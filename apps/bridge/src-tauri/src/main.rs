//! Localkan Bridge desktop app: a tray app that keeps the bridge connected and offers a
//! small window for pairing and status.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use localkan_bridge_core::{config, runtime};
use serde::Serialize;
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, State, WindowEvent};

struct AppState {
    status: runtime::SharedStatus,
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
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
        .manage(AppState { status: runtime::new_status(), task: Mutex::new(None) })
        .invoke_handler(tauri::generate_handler![get_status, pair, unpair, reconnect, open_board])
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
