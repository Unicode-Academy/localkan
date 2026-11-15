//! Localkan Bridge desktop app: a tray app that keeps the bridge connected and offers a
//! small window for pairing and status.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use localkan_bridge_core::setup::{self, Event};
use localkan_bridge_core::{config, runtime};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, State, WindowEvent};

struct AppState {
    status: runtime::SharedStatus,
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    setup: Arc<Mutex<SetupProgress>>,
    setup_cancel: Arc<AtomicBool>,
}

/// The running (or last) install of missing tools, polled by the window.
#[derive(Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupProgress {
    running: bool,
    /// Item being installed now.
    current: Option<String>,
    log: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusView {
    paired: bool,
    server_url: Option<String>,
    device_name: Option<String>,
    link: String,
    detail: Option<String>,
    info: Option<serde_json::Value>,
    data_dir: String,
}

fn start(state: &AppState) {
    stop(state);
    let cfg = config::load();
    if cfg.server_url.is_none() || cfg.device_id.is_none() {
        runtime::set_status(&state.status, "idle", None);
        return;
    }
    let status = state.status.clone();
    let handle = tauri::async_runtime::spawn(async move {
        if let Err(e) = runtime::run(status.clone()).await {
            runtime::set_status(&status, "error", Some(format!("{e:#}")));
        }
    });
    *state.task.lock().unwrap() = Some(handle);
}

fn stop(state: &AppState) {
    if let Some(h) = state.task.lock().unwrap().take() {
        h.abort();
    }
}

#[tauri::command]
fn get_status(state: State<AppState>) -> StatusView {
    let cfg = config::load();
    let s = state.status.read().map(|s| s.clone()).unwrap_or_default();
    StatusView {
        paired: cfg.server_url.is_some() && cfg.device_id.is_some(),
        server_url: cfg.server_url,
        device_name: cfg.device_name,
        link: s.link,
        detail: s.detail,
        info: s.info.and_then(|i| serde_json::to_value(i).ok()),
        data_dir: config::home_dir().display().to_string(),
    }
}

#[tauri::command]
async fn pair(state: State<'_, AppState>, server_url: String, code: String, device_name: Option<String>) -> Result<(), String> {
    config::pair(&server_url, &code, device_name).await.map_err(|e| format!("{e:#}"))?;
    start(&state);
    Ok(())
}

#[tauri::command]
async fn unpair(state: State<'_, AppState>) -> Result<(), String> {
    stop(&state);
    config::unpair().await.map_err(|e| format!("{e:#}"))?;
    runtime::set_status(&state.status, "idle", None);
    Ok(())
}

#[tauri::command]
fn reconnect(state: State<AppState>) {
    start(&state);
}

#[tauri::command]
async fn setup_check() -> Vec<setup::Item> {
    setup::check().await
}

#[tauri::command]
fn setup_progress(state: State<AppState>) -> SetupProgress {
    state.setup.lock().unwrap().clone()
}

/// Install the missing tools (all of them, or only `ids`) in the background.
#[tauri::command]
fn setup_install(app: AppHandle, state: State<AppState>, ids: Option<Vec<String>>) -> Result<(), String> {
    {
        let mut s = state.setup.lock().unwrap();
        if s.running {
            return Err("Đang cài, chờ xong lượt này đã.".into());
        }
        *s = SetupProgress { running: true, ..Default::default() };
    }
    state.setup_cancel.store(false, Ordering::Relaxed);
    let shared = state.setup.clone();
    let cancel = state.setup_cancel.clone();
    tauri::async_runtime::spawn(async move {
        let log = shared.clone();
        let progress = setup::Progress::new(cancel, move |e| {
            let mut s = log.lock().unwrap();
            match e {
                Event::Step(i) => {
                    s.current = Some(i.id.to_string());
                    s.log.push(format!("▸ Cài {}…", i.label));
                }
                Event::Line(l) => s.log.push(l),
                Event::Done(i, r) => {
                    s.current = None;
                    s.log.push(match r {
                        Ok(()) => format!("✓ Đã cài {}", i.label),
                        Err(e) => format!("✗ {}: {e}", i.label),
                    });
                }
            }
            let n = s.log.len();
            if n > 400 {
                s.log.drain(..n - 400);
            }
        });
        let results = setup::install_missing(ids.as_deref(), &progress).await;
        // The bridge looks for Orca when it starts: restart it to use a freshly installed one.
        if results.iter().any(|(id, r)| id == "orca" && r.is_ok()) {
            start(&app.state::<AppState>());
        }
        let mut s = shared.lock().unwrap();
        if results.is_empty() {
            s.log.push("Không còn gì cần cài.".into());
        }
        s.running = false;
        s.current = None;
    });
    Ok(())
}

#[tauri::command]
fn setup_cancel(state: State<AppState>) {
    state.setup_cancel.store(true, Ordering::Relaxed);
}

#[tauri::command]
async fn setup_gh_login() -> Result<(), String> {
    setup::open_gh_login().await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn setup_ngrok_token(token: String) -> Result<(), String> {
    setup::set_ngrok_token(&token).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn setup_ngrok_dashboard() -> Result<(), String> {
    open_url("https://dashboard.ngrok.com/get-started/your-authtoken")
}

#[tauri::command]
async fn setup_identity(name: String, email: String) -> Result<(), String> {
    setup::set_identity(&name, &email).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn open_board() -> Result<(), String> {
    let url = config::load().server_url.ok_or("Chưa ghép nối với server nào.")?;
    open_url(&url)
}

fn open_url(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let opener = "open";
    #[cfg(target_os = "linux")]
    let opener = "xdg-open";
    #[cfg(target_os = "windows")]
    let opener = "explorer";
    std::process::Command::new(opener).arg(url).spawn().map(|_| ()).map_err(|e| e.to_string())
}

fn show_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn main() {
    tracing_subscriber::fmt().with_target(false).init();

    tauri::Builder::default()
        .manage(AppState {
            status: runtime::new_status(),
            task: Mutex::new(None),
            setup: Arc::new(Mutex::new(SetupProgress::default())),
            setup_cancel: Arc::new(AtomicBool::new(false)),
        })
        .invoke_handler(tauri::generate_handler![
            get_status,
            pair,
            unpair,
            reconnect,
            open_board,
            setup_check,
            setup_progress,
            setup_install,
            setup_cancel,
            setup_gh_login,
            setup_ngrok_token,
            setup_ngrok_dashboard,
            setup_identity
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let show = MenuItem::with_id(app, "show", "Mở Localkan Bridge", true, None::<&str>)?;
            let board = MenuItem::with_id(app, "board", "Mở bảng Kanban", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Thoát", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &board, &quit])?;
            let mut tray = TrayIconBuilder::with_id("main").tooltip("Localkan Bridge").menu(&menu);
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.on_menu_event(|app, event| match event.id.as_ref() {
                "show" => show_window(app),
                "board" => {
                    let _ = open_board();
                }
                "quit" => app.exit(0),
                _ => {}
            })
            .build(app)?;

            let state = app.state::<AppState>();
            start(&state);
            let cfg = config::load();
            if cfg.server_url.is_none() || cfg.device_id.is_none() {
                show_window(app.handle());
            }
            // A new machine: open the window when something the bridge needs is missing, so
            // the "Môi trường máy" list (with its install button) is the first thing seen.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if setup::check().await.iter().any(|i| i.required && i.state != setup::State::Ok) {
                    show_window(&handle);
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps the bridge running in the tray.
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("không khởi động được Localkan Bridge");
}
