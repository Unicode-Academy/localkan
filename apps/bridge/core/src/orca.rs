//! Thin async wrapper over the `orca` CLI (`--json` mode) and the headless runtime.

use crate::paths::{command, home, which};
use serde_json::Value;
use std::fmt;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Child;
use tokio::sync::Mutex;

#[derive(Debug, Clone)]
pub struct OrcaError {
    pub code: String,
    pub message: String,
    pub data: Value,
}

impl fmt::Display for OrcaError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Orca: {} ({})", self.message, self.code)
    }
}

impl std::error::Error for OrcaError {}

impl OrcaError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into(), data: Value::Null }
    }
}

pub type OrcaResult = Result<Value, OrcaError>;

pub struct Orca {
    bin: PathBuf,
    serve: Mutex<Option<Child>>,
}

impl Orca {
    /// Find the orca CLI: $ORCA_BIN, PATH, then the copy inside Orca.app.
    pub fn locate() -> Option<PathBuf> {
        if let Some(p) = std::env::var_os("ORCA_BIN") {
            return Some(PathBuf::from(p));
        }
        if let Some(p) = which("orca") {
            return Some(p);
        }
        [
            PathBuf::from("/Applications/Orca.app/Contents/Resources/bin/orca"),
            home().join("Applications/Orca.app/Contents/Resources/bin/orca"),
        ]
        .into_iter()
        .find(|p| p.exists())
    }

    pub fn new(bin: PathBuf) -> Self {
        Self { bin, serve: Mutex::new(None) }
    }

    pub async fn call(&self, args: &[&str]) -> OrcaResult {
        self.call_timeout(args, Duration::from_secs(120)).await
    }

    /// Run `orca <args> --json` and return `result` from the `{ ok, result | error }` envelope.
    pub async fn call_timeout(&self, args: &[&str], timeout: Duration) -> OrcaResult {
        self.run(args, timeout, None).await
    }

    /// Like `call_timeout`, for commands whose arguments carry a secret (a password typed
    /// into the browser): the arguments are never logged and the secret is masked in errors.
    pub async fn call_secret(&self, args: &[&str], secret: &str, timeout: Duration) -> OrcaResult {
        self.run(args, timeout, Some(secret)).await.map_err(|mut e| {
            if !secret.is_empty() {
                e.message = e.message.replace(secret, "***");
            }
            e.data = Value::Null;
            e
        })
    }

    async fn run(&self, args: &[&str], timeout: Duration, secret: Option<&str>) -> OrcaResult {
        if secret.is_none() {
            tracing::debug!(?args, "orca");
        } else {
            tracing::debug!(cmd = args.first().copied().unwrap_or(""), "orca (arguments hidden)");
        }
        let child = command(&self.bin)
            .args(args)
            .arg("--json")
            .output();
        let shown = if secret.is_some() { args.first().copied().unwrap_or("").to_string() } else { args.join(" ") };
        let out = match tokio::time::timeout(timeout, child).await {
            Err(_) => return Err(OrcaError::new("timeout", format!("lệnh orca {shown} quá {}s", timeout.as_secs()))),
            Ok(Err(e)) => return Err(OrcaError::new("spawn_failed", format!("không chạy được orca: {e}"))),
            Ok(Ok(o)) => o,
        };
        let stdout = String::from_utf8_lossy(&out.stdout);
        let json = parse_json(&stdout).ok_or_else(|| {
            let stderr = String::from_utf8_lossy(&out.stderr);
            OrcaError::new(
                "bad_output",
                format!("orca {} không trả JSON: {}", args.first().unwrap_or(&""), first_line(&stderr, &stdout)),
            )
        })?;
        if json.get("ok").and_then(Value::as_bool) == Some(true) {
            return Ok(json.get("result").cloned().unwrap_or(Value::Null));
        }
        let err = json.get("error").cloned().unwrap_or(Value::Null);
        Err(OrcaError {
            code: err.get("code").and_then(Value::as_str).unwrap_or("orca_error").to_string(),
            message: err.get("message").and_then(Value::as_str).unwrap_or("lỗi không rõ").to_string(),
            data: err.get("data").cloned().unwrap_or(Value::Null),
        })
    }

    /// `(reachable, app version)` of the local Orca runtime.
    pub async fn status(&self) -> (bool, Option<String>) {
        match self.call_timeout(&["status"], Duration::from_secs(30)).await {
            Ok(r) => {
                let rt = &r["runtime"];
                let ready = rt["reachable"].as_bool() == Some(true) && rt["state"].as_str() == Some("ready");
                (ready, rt["appVersion"].as_str().map(String::from))
            }
            Err(_) => (false, None),
        }
    }

    /// Make sure a runtime is reachable, starting `orca serve` (headless) if needed.
    pub async fn ensure_runtime(&self) -> Result<Option<String>, OrcaError> {
        let (ok, version) = self.status().await;
        if ok {
            return Ok(version);
        }
        let mut guard = self.serve.lock().await;
        // Another caller may have started it while we waited for the lock.
        let (ok, version) = self.status().await;
        if ok {
            return Ok(version);
        }
        tracing::info!("starting headless Orca runtime (orca serve)");
        // ORCA_BACKGROUND_LAUNCH=1: Orca hides its Dock icon, uses the accessory activation
        // policy and never shows its window. Without it, a macOS "activate" event (for example
        // one delivered because a GUI app spawned the process) makes the headless server open
        // its desktop window a minute or two after start.
        let mut child = command(&self.bin)
            .env("ORCA_BACKGROUND_LAUNCH", "1")
            .args(["serve", "--json", "--no-pairing"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| OrcaError::new("spawn_failed", format!("không khởi động được orca serve: {e}")))?;
        let stdout = child.stdout.take().expect("piped stdout");
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<()>();
        // Drain the server's stdout for its whole lifetime so it never blocks on a full pipe.
        tokio::spawn(async move {
            let mut ready_tx = Some(ready_tx);
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.contains("orca_server_ready") {
                    if let Some(tx) = ready_tx.take() {
                        let _ = tx.send(());
                    }
                }
                tracing::debug!(target: "orca_serve", "{line}");
            }
        });
        *guard = Some(child);
        drop(guard);
        let _ = tokio::time::timeout(Duration::from_secs(90), ready_rx).await;
        for _ in 0..30 {
            let (ok, version) = self.status().await;
            if ok {
                return Ok(version);
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        Err(OrcaError::new("runtime_unavailable", "Orca runtime không sẵn sàng sau khi chạy orca serve."))
    }
}

fn parse_json(s: &str) -> Option<Value> {
    if let Ok(v) = serde_json::from_str::<Value>(s.trim()) {
        return Some(v);
    }
    // Tolerate log lines around the JSON document.
    let start = s.find('{')?;
    let end = s.rfind('}')?;
    serde_json::from_str(&s[start..=end]).ok()
}

fn first_line(a: &str, b: &str) -> String {
    a.lines().chain(b.lines()).find(|l| !l.trim().is_empty()).unwrap_or("").chars().take(300).collect()
}

/// Pull a terminal handle out of a worker-start receipt (effects / residualResources).
pub fn agent_terminal_from_receipt(receipt: &Value) -> Option<String> {
    for key in ["effects", "residualResources"] {
        if let Some(items) = receipt[key].as_array() {
            for it in items {
                if it["kind"] == "terminal" && it["role"] == "agent" {
                    if let Some(id) = it["id"].as_str() {
                        return Some(id.to_string());
                    }
                }
            }
        }
    }
    receipt["agentTerminalHandle"].as_str().map(String::from)
}

/// Text lines from a `terminal read` / `worker-read` result, whatever its source.
pub fn output_lines(result: &Value) -> Vec<String> {
    let as_lines = |v: &Value| -> Option<Vec<String>> {
        v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
    };
    for path in [&result["terminal"]["tail"], &result["tail"], &result["transcript"]["tail"], &result["lines"]] {
        if let Some(l) = as_lines(path) {
            return l;
        }
    }
    // Transcript entries: [{ role, text }, …]
    for path in [&result["entries"], &result["transcript"]["entries"], &result["items"]] {
        if let Some(items) = path.as_array() {
            return items
                .iter()
                .filter_map(|e| {
                    let text = e["text"].as_str().or_else(|| e["content"].as_str())?;
                    let role = e["role"].as_str().unwrap_or("");
                    Some(if role.is_empty() { text.to_string() } else { format!("[{role}] {text}") })
                })
                .flat_map(|s| s.lines().map(String::from).collect::<Vec<_>>())
                .collect();
        }
    }
    Vec::new()
}
