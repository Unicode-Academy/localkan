//! WebSocket link to the Localkan server, with reconnect and backoff.

use crate::engine::Engine;
use crate::protocol::{Outgoing, Request};
use crate::runtime::{set_status, SharedStatus};
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{header::AUTHORIZATION, HeaderValue, StatusCode};
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

pub fn ws_url(server: &str) -> String {
    let base = server.trim_end_matches('/');
    let base = if let Some(rest) = base.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = base.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        base.to_string()
    };
    // Under /api so a reverse proxy only has to forward one path prefix to the server.
    format!("{base}/api/bridge")
}

pub async fn run(
    server: String,
    token: String,
    engine: Arc<Engine>,
    tx: mpsc::UnboundedSender<Outgoing>,
    mut rx: mpsc::UnboundedReceiver<Outgoing>,
    status: SharedStatus,
) {
    let url = ws_url(&server);
    let mut backoff = Duration::from_secs(1);
    loop {
        set_status(&status, "connecting", None);
        let mut req = match url.as_str().into_client_request() {
            Ok(r) => r,
            Err(e) => {
                set_status(&status, "error", Some(format!("Địa chỉ server không hợp lệ: {e}")));
                return;
            }
        };
        if let Ok(v) = HeaderValue::from_str(&format!("Bearer {token}")) {
            req.headers_mut().insert(AUTHORIZATION, v);
        }

        match tokio_tungstenite::connect_async(req).await {
            Ok((ws, _)) => {
                backoff = Duration::from_secs(1);
                set_status(&status, "connected", None);
                tracing::info!("connected to {url}");
                let (mut sink, mut stream) = ws.split();

                // Hello (may wait for the Orca runtime to start) and state re-sync run
                // alongside the message loop so requests are served immediately.
                {
                    let engine = engine.clone();
                    let tx = tx.clone();
                    let status = status.clone();
                    tokio::spawn(async move {
                        engine.snapshot().await;
                        let info = engine.info().await;
                        if let Ok(mut s) = status.write() {
                            s.info = Some(info.clone());
                        }
                        let _ = tx.send(Outgoing::Event {
                            event: "hello".into(),
                            data: serde_json::to_value(info).unwrap_or_default(),
                        });
                    });
                }

                loop {
                    tokio::select! {
                        msg = stream.next() => match msg {
                            Some(Ok(Message::Text(text))) => {
                                match serde_json::from_str::<Request>(&text) {
                                    Ok(req) if req.kind == "req" => {
                                        let engine = engine.clone();
                                        let tx = tx.clone();
                                        tokio::spawn(async move {
                                            let out = match engine.handle(&req.method, req.params).await {
                                                Ok(v) => Outgoing::Res { id: req.id, ok: true, result: Some(v), error: None },
                                                Err(e) => Outgoing::Res { id: req.id, ok: false, result: None, error: Some(e) },
                                            };
                                            let _ = tx.send(out);
                                        });
                                    }
                                    Ok(_) => {}
                                    Err(e) => tracing::warn!("bad message from server: {e}"),
                                }
                            }
                            Some(Ok(Message::Close(frame))) => {
                                tracing::info!("server closed the connection: {frame:?}");
                                if frame.as_ref().is_some_and(|f| u16::from(f.code) == 4001) {
                                    set_status(&status, "unauthorized", Some("Máy này đã bị gỡ khỏi tài khoản. Hãy ghép nối lại.".into()));
                                    return;
                                }
                                break;
                            }
                            Some(Ok(_)) => {}
                            Some(Err(e)) => {
                                tracing::warn!("websocket error: {e}");
                                break;
                            }
                            None => break,
                        },
                        out = rx.recv() => match out {
                            Some(o) => {
                                let text = match serde_json::to_string(&o) {
                                    Ok(t) => t,
                                    Err(_) => continue,
                                };
                                if sink.send(Message::Text(text.into())).await.is_err() {
                                    break;
                                }
                            }
                            None => return,
                        },
                    }
                }
                set_status(&status, "disconnected", Some("Mất kết nối tới server, đang thử lại…".into()));
            }
            Err(WsError::Http(resp)) if resp.status() == StatusCode::UNAUTHORIZED => {
                set_status(&status, "unauthorized", Some("Server từ chối token của máy này. Hãy ghép nối lại.".into()));
                tokio::time::sleep(Duration::from_secs(60)).await;
                continue;
            }
            Err(e) => {
                set_status(&status, "disconnected", Some(format!("Không kết nối được {server}: {e}")));
            }
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}
