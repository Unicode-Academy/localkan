//! Wires config, store, Orca, engine and the server link into one running bridge.

use crate::config;
use crate::engine::Engine;
use crate::orca::Orca;
use crate::protocol::BridgeInfo;
use crate::store::Store;
use anyhow::{anyhow, Result};
use serde::Serialize;
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tokio::sync::mpsc;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// idle | connecting | connected | disconnected | unauthorized | error
    pub link: String,
    pub detail: Option<String>,
    pub info: Option<BridgeInfo>,
}

pub type SharedStatus = Arc<RwLock<Status>>;

pub fn new_status() -> SharedStatus {
    Arc::new(RwLock::new(Status { link: "idle".into(), ..Default::default() }))
}

pub fn set_status(status: &SharedStatus, link: &str, detail: Option<String>) {
    if let Ok(mut s) = status.write() {
        s.link = link.into();
        s.detail = detail;
    }
}

/// Run the bridge until the link gives up (unpaired/revoked). Requires a paired config.
pub async fn run(status: SharedStatus) -> Result<()> {
    let cfg = config::load();
    let (Some(server), Some(device_id)) = (cfg.server_url.clone(), cfg.device_id.clone()) else {
        return Err(anyhow!("Bridge chưa được ghép nối với server nào."));
    };
    let token = config::load_token(&device_id)
        .await
        .ok_or_else(|| anyhow!("Không tìm thấy token của máy này. Hãy ghép nối lại."))?;
    let store = Store::open(&config::db_path())?;
    let orca = Orca::locate().map(Orca::new);
    if orca.is_none() {
        tracing::warn!("orca CLI not found; install Orca or set ORCA_BIN");
    }
    let mock = std::env::var("LOCALKAN_MOCK_AGENT_CMD").ok().filter(|s| !s.trim().is_empty());
    if mock.is_some() {
        tracing::warn!("LOCALKAN_MOCK_AGENT_CMD is set: cards run the mock agent instead of real agents");
    }
    let (tx, rx) = mpsc::unbounded_channel();
    let device_name = cfg.device_name.clone().unwrap_or_else(config::default_device_name);
    let engine = Arc::new(Engine::new(orca, store, tx.clone(), device_name, mock, Some((server.clone(), token.clone()))));

    // Supervision loop and server link share this task, so aborting the task (unpair,
    // reconnect in the desktop app) stops both.
    let supervise = {
        let engine = engine.clone();
        async move {
            let mut iv = tokio::time::interval(Duration::from_secs(2));
            iv.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                iv.tick().await;
                engine.tick().await;
            }
        }
    };
    // Model lists for the picker: at start, then a few times a day (CLIs add models).
    let models = {
        let engine = engine.clone();
        async move {
            loop {
                engine.refresh_models().await;
                tokio::time::sleep(Duration::from_secs(6 * 3600)).await;
            }
        }
    };
    tokio::select! {
        _ = supervise => {}
        _ = models => {}
        _ = crate::link::run(server, token, engine, tx, rx, status) => {}
    }
    Ok(())
}
