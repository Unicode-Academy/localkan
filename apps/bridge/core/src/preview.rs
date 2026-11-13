//! Live previews of a card's worktree.
//!
//! - Runs the project's dev server (package.json `dev`/`start`) inside the worktree on a free
//!   local port, installing dependencies first when `node_modules` is missing.
//! - Optionally exposes it through ngrok so it can be opened from a phone: one shared ngrok
//!   agent (free plans allow a single agent) with one password-protected tunnel per card.
//! - Takes screenshots of the running app with headless Chrome at phone and desktop sizes.

use crate::git;
use crate::paths::{command, which};
use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Child;
use tokio::sync::Mutex;

pub const USERNAME: &str = "localkan";
const DEV_READY_TIMEOUT: Duration = Duration::from_secs(240);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(900);

#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewInfo {
    /// starting | running | error
    pub status: String,
    pub local_url: Option<String>,
    pub url: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub command: Option<String>,
    pub message: Option<String>,
    pub started_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Screenshot {
    pub viewport: String,
    pub width: u32,
    pub height: u32,
    pub url: String,
    pub data_url: String,
    pub taken_at: String,
}

struct Session {
    port: u16,
    dev: Child,
    command: String,
    tunnel: Option<String>,
    url: Option<String>,
    password: String,
    output: Arc<StdMutex<VecDeque<String>>>,
    started_at: String,
}

struct NgrokAgent {
    child: Child,
    api: String,
}

pub struct Previews {
    home: PathBuf,
    sessions: Mutex<HashMap<String, Session>>,
    ngrok: Mutex<Option<NgrokAgent>>,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn random_secret(len: usize) -> String {
    const ALPHABET: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789";
    let mut bytes = vec![0u8; len];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        use std::io::Read;
        let _ = f.read_exact(&mut bytes);
    }
    bytes.iter().map(|b| ALPHABET[*b as usize % ALPHABET.len()] as char).collect()
}

fn free_port() -> Result<u16> {
    Ok(std::net::TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}

async fn port_open(port: u16) -> bool {
    tokio::net::TcpStream::connect(("127.0.0.1", port)).await.is_ok()
}

/// Terminate a process group started with `process_group(0)` (dev servers spawn children).
async fn kill_group(child: &mut Child) {
    if let Some(pid) = child.id() {
        let _ = command("kill").args(["-TERM", "--", &format!("-{pid}")]).output().await;
        if tokio::time::timeout(Duration::from_secs(4), child.wait()).await.is_err() {
            let _ = command("kill").args(["-KILL", "--", &format!("-{pid}")]).output().await;
        }
    }
    let _ = child.kill().await;
}

/// Keep the last lines a process printed (for error messages).
fn drain(child: &mut Child, buf: Arc<StdMutex<VecDeque<String>>>) {
    let push = move |buf: &Arc<StdMutex<VecDeque<String>>>, line: String| {
        let mut b = buf.lock().unwrap();
        b.push_back(line);
        while b.len() > 60 {
            b.pop_front();
        }
    };
    if let Some(out) = child.stdout.take() {
        let buf = buf.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(out).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                push(&buf, l);
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        tokio::spawn(async move {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                push(&buf, l);
            }
        });
    }
}

fn tail(buf: &Arc<StdMutex<VecDeque<String>>>, n: usize) -> String {
    let b = buf.lock().unwrap();
    let skip = b.len().saturating_sub(n);
    b.iter().skip(skip).map(|l| crate::redact::redact_line(l)).collect::<Vec<_>>().join("\n")
}

struct DevPlan {
    manager: &'static str,
    script: String,
    args: Vec<String>,
    display: String,
}

/// Work out how to start the dev server for the project in `wt`.
fn plan_dev(wt: &Path, port: u16) -> Result<DevPlan> {
    let pkg: Value = std::fs::read_to_string(wt.join("package.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .ok_or_else(|| anyhow!("Chưa có package.json trong worktree, nên chưa biết chạy dev server thế nào."))?;
    let scripts = pkg["scripts"].as_object().cloned().unwrap_or_default();
    let (script, body) = ["dev", "start", "serve", "preview"]
        .iter()
        .find_map(|s| scripts.get(*s).and_then(Value::as_str).map(|b| (s.to_string(), b.to_string())))
        .ok_or_else(|| anyhow!("package.json không có script dev/start/serve/preview."))?;
    let lock = |f: &str| wt.join(f).exists();
    let manager = if lock("pnpm-lock.yaml") && which("pnpm").is_some() {
        "pnpm"
    } else if lock("yarn.lock") && which("yarn").is_some() {
        "yarn"
    } else if (lock("bun.lock") || lock("bun.lockb")) && which("bun").is_some() {
        "bun"
    } else {
        "npm"
    };
    // PORT works for Next.js, CRA, Express…; Vite and Astro need a flag.
    let port_s = port.to_string();
    let mut args: Vec<String> = Vec::new();
    if body.contains("vite") {
        args.extend(["--port".into(), port_s.clone(), "--strictPort".into(), "--host".into(), "127.0.0.1".into()]);
    } else if body.contains("next ") || body.ends_with("next") {
        args.extend(["-p".into(), port_s.clone()]);
    } else if body.contains("astro") {
        args.extend(["--port".into(), port_s.clone()]);
    }
    let display = format!("{manager} run {script}{}", if args.is_empty() { String::new() } else { format!(" {}", args.join(" ")) });
    Ok(DevPlan { manager, script, args, display })
}

fn chrome_binary() -> Option<PathBuf> {
    [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ]
    .iter()
    .map(PathBuf::from)
    .find(|p| p.exists())
    .or_else(|| which("google-chrome").or_else(|| which("chromium")))
}

const PROCESS_HINTS: [&str; 9] = ["ngrok", "node", "npm", "pnpm", "yarn", "bun", "next", "vite", "astro"];

impl Previews {
    pub fn new(home: PathBuf) -> Self {
        let me = Self { home, sessions: Mutex::new(HashMap::new()), ngrok: Mutex::new(None) };
        me.reap_orphans();
        me
    }

    fn pid_file(&self) -> PathBuf {
        self.home.join("pids")
    }

    /// Remember a process group so a later bridge run can clean it up after a crash/quit.
    fn remember(&self, child: &Child) {
        if let Some(pid) = child.id() {
            let _ = std::fs::create_dir_all(&self.home);
            let mut list = std::fs::read_to_string(self.pid_file()).unwrap_or_default();
            list.push_str(&format!("{pid}\n"));
            let _ = std::fs::write(self.pid_file(), list);
        }
    }

    /// Kill dev servers / ngrok left over by a previous bridge process. Only process groups
    /// whose leader still looks like one of ours are touched (PIDs can be reused).
    fn reap_orphans(&self) {
        let Ok(list) = std::fs::read_to_string(self.pid_file()) else { return };
        for pid in list.lines().filter_map(|l| l.trim().parse::<u32>().ok()) {
            let cmdline = std::process::Command::new("ps")
                .args(["-o", "command=", "-p", &pid.to_string()])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).to_lowercase())
                .unwrap_or_default();
            if !cmdline.trim().is_empty() && PROCESS_HINTS.iter().any(|h| cmdline.contains(h)) {
                let _ = std::process::Command::new("kill").args(["-TERM", "--", &format!("-{pid}")]).status();
            }
        }
        let _ = std::fs::remove_file(self.pid_file());
    }

    pub async fn info(&self, card_id: &str) -> Option<PreviewInfo> {
        let mut sessions = self.sessions.lock().await;
        let s = sessions.get_mut(card_id)?;
        if !matches!(s.dev.try_wait(), Ok(None)) {
            return Some(PreviewInfo {
                status: "error".into(),
                local_url: None,
                url: None,
                username: None,
                password: None,
                command: Some(s.command.clone()),
                message: Some(format!("Dev server đã dừng.\n{}", tail(&s.output, 15))),
                started_at: Some(s.started_at.clone()),
            });
        }
        Some(self.running_info(s))
    }

    fn running_info(&self, s: &Session) -> PreviewInfo {
        PreviewInfo {
            status: "running".into(),
            local_url: Some(format!("http://127.0.0.1:{}", s.port)),
            url: s.url.clone(),
            username: s.url.as_ref().map(|_| USERNAME.to_string()),
            password: s.url.as_ref().map(|_| s.password.clone()),
            command: Some(s.command.clone()),
            message: None,
            started_at: Some(s.started_at.clone()),
        }
    }

    /// Make sure the card's dev server is up; returns its local port. `progress` receives
    /// human-readable steps (install, start) for the card log.
    pub async fn ensure_dev(&self, card_id: &str, repo: &str, wt: &str, progress: &(dyn Fn(String) + Sync)) -> Result<u16> {
        {
            let mut sessions = self.sessions.lock().await;
            if let Some(s) = sessions.get_mut(card_id) {
                if matches!(s.dev.try_wait(), Ok(None)) {
                    return Ok(s.port);
                }
                sessions.remove(card_id);
            }
        }
        let wt_path = Path::new(wt);
        // Files the dev server creates must never end up in a commit.
        for p in ["node_modules/", ".next/", ".turbo/", ".vercel/"] {
            let _ = git::exclude_locally(repo, p).await;
        }
        let port = free_port()?;
        let plan = plan_dev(wt_path, port)?;

        if !wt_path.join("node_modules").exists() {
            self.install(wt_path, plan.manager, progress).await?;
        }

        progress(format!("Chạy dev server: {} (cổng {port})", plan.display));
        let mut cmd = command(plan.manager);
        cmd.arg("run").arg(&plan.script);
        if !plan.args.is_empty() {
            if plan.manager == "npm" {
                cmd.arg("--");
            }
            cmd.args(&plan.args);
        }
        let mut dev = cmd
            .current_dir(wt_path)
            .env("PORT", port.to_string())
            .env("BROWSER", "none")
            .env("FORCE_COLOR", "0")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .spawn()
            .with_context(|| format!("không chạy được {}", plan.display))?;
        self.remember(&dev);
        let output = Arc::new(StdMutex::new(VecDeque::new()));
        drain(&mut dev, output.clone());

        let started = Instant::now();
        loop {
            if port_open(port).await {
                break;
            }
            if let Ok(Some(status)) = dev.try_wait() {
                bail!("Dev server thoát ({status}):\n{}", tail(&output, 15));
            }
            if started.elapsed() > DEV_READY_TIMEOUT {
                kill_group(&mut dev).await;
                bail!("Dev server chưa mở cổng {port} sau {} giây:\n{}", DEV_READY_TIMEOUT.as_secs(), tail(&output, 15));
            }
            tokio::time::sleep(Duration::from_millis(800)).await;
        }
        self.sessions.lock().await.insert(
            card_id.to_string(),
            Session {
                port,
                dev,
                command: plan.display,
                tunnel: None,
                url: None,
                password: random_secret(12),
                output,
                started_at: now(),
            },
        );
        Ok(port)
    }

    /// Install dependencies for previewing without changing tracked files: the lockfile is
    /// used as-is (or none is written), so the card's diff shows only the agent's work.
    async fn install(&self, wt: &Path, manager: &str, progress: &(dyn Fn(String) + Sync)) -> Result<()> {
        let has = |f: &str| wt.join(f).exists();
        let (frozen, plain): (Vec<&str>, Vec<&str>) = match manager {
            "pnpm" if has("pnpm-lock.yaml") => (vec!["install", "--frozen-lockfile"], vec!["install"]),
            "pnpm" => (vec!["install", "--no-lockfile"], vec!["install", "--no-lockfile"]),
            "yarn" => (vec!["install", "--frozen-lockfile"], vec!["install"]),
            "bun" if has("bun.lock") || has("bun.lockb") => (vec!["install", "--frozen-lockfile"], vec!["install"]),
            "bun" => (vec!["install", "--no-save"], vec!["install", "--no-save"]),
            _ if has("package-lock.json") || has("npm-shrinkwrap.json") => (vec!["ci"], vec!["install"]),
            _ => (vec!["install", "--no-package-lock"], vec!["install", "--no-package-lock"]),
        };
        let mut last_err = String::new();
        for (i, args) in [frozen, plain].into_iter().enumerate() {
            if i == 1 && args.is_empty() {
                break;
            }
            let shown = format!("{manager} {}", args.join(" "));
            progress(if i == 0 {
                format!("Đang cài dependencies ({shown})… lần đầu có thể mất vài phút.")
            } else {
                format!("Lockfile lệch với package.json; cài lại bằng {shown}.")
            });
            let run = command(manager).args(&args).current_dir(wt).output();
            let out = tokio::time::timeout(INSTALL_TIMEOUT, run)
                .await
                .map_err(|_| anyhow!("{shown} quá {} phút.", INSTALL_TIMEOUT.as_secs() / 60))??;
            if out.status.success() {
                return Ok(());
            }
            let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
            let last: Vec<&str> = text.lines().rev().take(12).collect::<Vec<_>>().into_iter().rev().collect();
            last_err = format!("{shown} thất bại:\n{}", crate::redact::redact_line(&last.join("\n")));
        }
        bail!("{last_err}")
    }

    /// Start (or reuse) the dev server and, when `tunnel` is set, a password-protected ngrok
    /// tunnel to it.
    pub async fn start(&self, card_id: &str, repo: &str, wt: &str, tunnel: bool, progress: &(dyn Fn(String) + Sync)) -> Result<PreviewInfo> {
        let port = self.ensure_dev(card_id, repo, wt, progress).await?;
        if tunnel {
            let has_tunnel = self.sessions.lock().await.get(card_id).is_some_and(|s| s.url.is_some());
            if !has_tunnel {
                progress("Mở link xem trước qua ngrok…".into());
                let password = self.sessions.lock().await.get(card_id).map(|s| s.password.clone()).unwrap_or_default();
                let prefix = format!("lk-{}", card_id.chars().filter(|c| c.is_ascii_alphanumeric()).take(10).collect::<String>());
                let (name, url) = self.open_tunnel(&prefix, port, &password).await?;
                if let Some(s) = self.sessions.lock().await.get_mut(card_id) {
                    s.tunnel = Some(name);
                    s.url = Some(url);
                }
            }
        }
        self.info(card_id).await.ok_or_else(|| anyhow!("Xem trước đã dừng."))
    }

    pub async fn stop(&self, card_id: &str) {
        let session = self.sessions.lock().await.remove(card_id);
        let Some(mut s) = session else { return };
        if let Some(name) = &s.tunnel {
            if let Some(agent) = self.ngrok.lock().await.as_ref() {
                let _ = reqwest::Client::new().delete(format!("{}/api/tunnels/{name}", agent.api)).send().await;
            }
        }
        kill_group(&mut s.dev).await;
        // Free the (single) ngrok agent session when no tunnel is left.
        let any_tunnel = self.sessions.lock().await.values().any(|s| s.tunnel.is_some());
        if !any_tunnel {
            if let Some(mut agent) = self.ngrok.lock().await.take() {
                kill_group(&mut agent.child).await;
            }
        }
    }

    async fn agent_api(&self) -> Result<String> {
        let mut guard = self.ngrok.lock().await;
        if let Some(agent) = guard.as_mut() {
            if matches!(agent.child.try_wait(), Ok(None)) {
                return Ok(agent.api.clone());
            }
        }
        let ngrok = which("ngrok").ok_or_else(|| anyhow!("Chưa cài ngrok. Cài bằng: brew install ngrok, rồi chạy ngrok config add-authtoken <token>."))?;
        // Keep the user's own config (authtoken) and add ours: a private local API port so we
        // never clash with another ngrok they run.
        let check = command(&ngrok).args(["config", "check"]).output().await?;
        let text = format!("{}{}", String::from_utf8_lossy(&check.stdout), String::from_utf8_lossy(&check.stderr));
        let default_cfg = text
            .lines()
            .find_map(|l| l.split_once("configuration file at ").map(|(_, p)| p.trim().to_string()))
            .ok_or_else(|| anyhow!("ngrok chưa được cấu hình. Chạy: ngrok config add-authtoken <token>"))?;
        let api_port = free_port()?;
        std::fs::create_dir_all(&self.home)?;
        let ours = self.home.join("ngrok-localkan.yml");
        std::fs::write(&ours, format!("version: \"3\"\nagent:\n  web_addr: 127.0.0.1:{api_port}\n"))?;
        let mut child = command(&ngrok)
            .args(["start", "--none", "--log=stdout", "--log-format=json", "--config", &default_cfg, "--config"])
            .arg(&ours)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .spawn()
            .context("không chạy được ngrok")?;
        self.remember(&child);
        let output = Arc::new(StdMutex::new(VecDeque::new()));
        drain(&mut child, output.clone());
        let api = format!("http://127.0.0.1:{api_port}");
        let client = reqwest::Client::new();
        for _ in 0..60 {
            if let Ok(Some(_)) = child.try_wait() {
                bail!("ngrok thoát ngay khi khởi động:\n{}", tail(&output, 8));
            }
            // The local API comes up before the session with ngrok's servers; tunnels can only
            // be created once the agent logs that its session started.
            let session_up = output.lock().unwrap().iter().any(|l| l.contains("tunnel session started"));
            if session_up && client.get(format!("{api}/api/tunnels")).send().await.is_ok_and(|r| r.status().is_success()) {
                *guard = Some(NgrokAgent { child, api: api.clone() });
                return Ok(api);
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        kill_group(&mut child).await;
        bail!("ngrok không sẵn sàng:\n{}", tail(&output, 8))
    }

    /// Open a tunnel; returns `(tunnel name, public url)`. Each attempt uses a fresh name: a
    /// failed attempt can leave its name reserved in the agent ("already exists").
    async fn open_tunnel(&self, prefix: &str, port: u16, password: &str) -> Result<(String, String)> {
        let api = self.agent_api().await?;
        let client = reqwest::Client::new();
        let mut last = String::new();
        for _ in 0..20 {
            let name = format!("{prefix}-{}", random_secret(4));
            let body = json!({
                "name": name,
                "proto": "http",
                "addr": port.to_string(),
                "basic_auth": [format!("{USERNAME}:{password}")],
            });
            let res: Value = client.post(format!("{api}/api/tunnels")).json(&body).send().await?.json().await?;
            if let Some(url) = res["public_url"].as_str() {
                return Ok((name, url.to_string()));
            }
            last = res["details"]["err"].as_str().or(res["msg"].as_str()).unwrap_or("lỗi không rõ").to_string();
            if !(last.contains("not yet ready") || last.contains("already exists")) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(600)).await;
        }
        bail!("ngrok không mở được tunnel: {last}")
    }

    /// Screenshots of `path` on the card's running dev server at phone and desktop sizes.
    pub async fn screenshots(&self, card_id: &str, repo: &str, wt: &str, path: &str, progress: &(dyn Fn(String) + Sync)) -> Result<Vec<Screenshot>> {
        let chrome = chrome_binary().ok_or_else(|| anyhow!("Cần Google Chrome (hoặc Chromium/Edge/Brave) để chụp màn hình."))?;
        let port = self.ensure_dev(card_id, repo, wt, progress).await?;
        let path = if path.starts_with('/') { path.to_string() } else { format!("/{path}") };
        let url = format!("http://127.0.0.1:{port}{path}");
        let profile = self.home.join("chrome-screenshots");
        let dir = std::env::temp_dir().join(format!("localkan-shots-{}", random_secret(8)));
        std::fs::create_dir_all(&dir)?;
        let mut shots = Vec::new();
        for (viewport, w, h) in [("mobile", 390u32, 844u32), ("desktop", 1440, 900)] {
            let file = dir.join(format!("{viewport}.png"));
            let mut cmd = command(&chrome);
            cmd.args([
                "--headless=new",
                "--disable-gpu",
                "--hide-scrollbars",
                "--no-first-run",
                "--no-default-browser-check",
                "--virtual-time-budget=8000",
            ])
            .arg(format!("--user-data-dir={}", profile.display()))
            .arg(format!("--window-size={w},{h}"))
            .arg(format!("--screenshot={}", file.display()));
            if viewport == "mobile" {
                cmd.arg("--user-agent=Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1");
            }
            cmd.arg(&url);
            let out = tokio::time::timeout(Duration::from_secs(90), cmd.output())
                .await
                .map_err(|_| anyhow!("Chrome chụp màn hình quá 90 giây."))??;
            let bytes = std::fs::read(&file).map_err(|_| {
                anyhow!("Chrome không tạo được ảnh: {}", String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or(""))
            })?;
            shots.push(Screenshot {
                viewport: viewport.into(),
                width: w,
                height: h,
                url: path.clone(),
                data_url: format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)),
                taken_at: now(),
            });
        }
        let _ = std::fs::remove_dir_all(dir);
        Ok(shots)
    }

    /// Stop everything (bridge shutdown).
    pub async fn stop_all(&self) {
        let ids: Vec<String> = self.sessions.lock().await.keys().cloned().collect();
        for id in ids {
            self.stop(&id).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans_dev_commands() {
        let dir = std::env::temp_dir().join(format!("lk-plan-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("package.json"), r#"{"scripts":{"dev":"next dev --turbopack","build":"next build"}}"#).unwrap();
        let p = plan_dev(&dir, 4321).unwrap();
        assert_eq!((p.manager, p.script.as_str()), ("npm", "dev"));
        assert_eq!(p.args, vec!["-p", "4321"]);
        std::fs::write(dir.join("package.json"), r#"{"scripts":{"dev":"vite"}}"#).unwrap();
        assert!(plan_dev(&dir, 5000).unwrap().args.contains(&"--strictPort".to_string()));
        std::fs::write(dir.join("package.json"), r#"{"scripts":{"start":"node server.js"}}"#).unwrap();
        let p = plan_dev(&dir, 6000).unwrap();
        assert_eq!(p.script, "start");
        assert!(p.args.is_empty());
        std::fs::remove_dir_all(dir).ok();
    }
}
