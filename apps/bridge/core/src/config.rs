//! Bridge configuration (server URL, device identity) and device-token storage.
//!
//! The device token lives in the macOS Keychain (via the `security` tool). Set
//! `LOCALKAN_TOKEN_STORE=file` to keep it in a 0600 file instead (headless/dev use).

use crate::paths::command;
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const KEYCHAIN_SERVICE: &str = "dev.localkan.bridge";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub server_url: Option<String>,
    pub device_id: Option<String>,
    pub device_name: Option<String>,
}

/// Where the bridge keeps its config, local DB and (file store) token.
pub fn home_dir() -> PathBuf {
    if let Some(p) = std::env::var_os("LOCALKAN_BRIDGE_HOME") {
        return PathBuf::from(p);
    }
    directories::ProjectDirs::from("dev", "localkan", "bridge")
        .map(|d| d.data_dir().to_path_buf())
        .unwrap_or_else(|| crate::paths::home().join(".localkan-bridge"))
}

fn config_path() -> PathBuf {
    home_dir().join("config.json")
}

pub fn db_path() -> PathBuf {
    home_dir().join("bridge.db")
}

pub fn load() -> Config {
    std::fs::read_to_string(config_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(cfg: &Config) -> Result<()> {
    std::fs::create_dir_all(home_dir())?;
    std::fs::write(config_path(), serde_json::to_string_pretty(cfg)?)?;
    Ok(())
}

pub fn default_device_name() -> String {
    gethostname::gethostname().to_string_lossy().trim_end_matches(".local").to_string()
}

fn use_file_store() -> bool {
    !cfg!(target_os = "macos") || std::env::var("LOCALKAN_TOKEN_STORE").as_deref() == Ok("file")
}

fn token_file() -> PathBuf {
    home_dir().join("device-token")
}

pub async fn store_token(account: &str, token: &str) -> Result<()> {
    if use_file_store() {
        use std::os::unix::fs::OpenOptionsExt;
        use std::io::Write;
        std::fs::create_dir_all(home_dir())?;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(token_file())?;
        f.write_all(token.as_bytes())?;
        return Ok(());
    }
    let out = command("security")
        .args(["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", account, "-w", token])
        .output()
        .await
        .context("không gọi được security")?;
    if !out.status.success() {
        bail!("Không lưu được token vào Keychain: {}", String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(())
}

pub async fn load_token(account: &str) -> Option<String> {
    if use_file_store() {
        return std::fs::read_to_string(token_file()).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    }
    let out = command("security")
        .args(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"])
        .output()
        .await
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
}

pub async fn clear_token(account: &str) {
    let _ = std::fs::remove_file(token_file());
    if cfg!(target_os = "macos") {
        let _ = command("security")
            .args(["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account])
            .output()
            .await;
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairResponse {
    device_id: String,
    token: String,
}

/// Exchange a pairing code from the web UI for a device token.
pub async fn pair(server_url: &str, code: &str, device_name: Option<String>) -> Result<Config> {
    let server_url = server_url.trim().trim_end_matches('/').to_string();
    if !(server_url.starts_with("http://") || server_url.starts_with("https://")) {
        bail!("Địa chỉ server phải bắt đầu bằng http:// hoặc https://");
    }
    let name = device_name.filter(|n| !n.trim().is_empty()).unwrap_or_else(default_device_name);
    let res = reqwest::Client::new()
        .post(format!("{server_url}/api/bridge/pair"))
        .json(&serde_json::json!({ "code": code, "deviceName": name }))
        .send()
        .await
        .with_context(|| format!("không kết nối được {server_url}"))?;
    if !res.status().is_success() {
        let body: serde_json::Value = res.json().await.unwrap_or_default();
        bail!("{}", body["error"].as_str().unwrap_or("Ghép nối thất bại."));
    }
    let pr: PairResponse = res.json().await?;
    store_token(&pr.device_id, &pr.token).await?;
    let cfg = Config { server_url: Some(server_url), device_id: Some(pr.device_id), device_name: Some(name) };
    save(&cfg)?;
    Ok(cfg)
}

pub async fn unpair() -> Result<()> {
    let cfg = load();
    if let Some(id) = &cfg.device_id {
        clear_token(id).await;
    }
    save(&Config::default())
}
