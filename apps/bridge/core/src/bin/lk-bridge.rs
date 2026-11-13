//! Headless Localkan bridge (for servers, dev machines and testing).
//!
//!   lk-bridge pair --server http://127.0.0.1:8787 --code ABCD-EFGH [--name "My Mac"]
//!   lk-bridge run
//!   lk-bridge status
//!   lk-bridge unpair

use clap::{Parser, Subcommand};
use localkan_bridge_core::{config, runtime};

#[derive(Parser)]
#[command(name = "lk-bridge", version, about = "Localkan local bridge (headless)")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Pair this machine with a Localkan server using a code from the web UI.
    Pair {
        #[arg(long)]
        server: String,
        #[arg(long)]
        code: String,
        #[arg(long)]
        name: Option<String>,
    },
    /// Connect to the server and run cards until stopped.
    Run,
    /// Show pairing info.
    Status,
    /// Forget the server and delete the device token.
    Unpair,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let level = match std::env::var("LOCALKAN_LOG").as_deref() {
        Ok("debug") => tracing::Level::DEBUG,
        Ok("warn") => tracing::Level::WARN,
        _ => tracing::Level::INFO,
    };
    tracing_subscriber::fmt().with_max_level(level).with_target(false).init();

    match Cli::parse().cmd {
        Cmd::Pair { server, code, name } => {
            let cfg = config::pair(&server, &code, name).await?;
            println!(
                "Đã ghép nối \"{}\" với {}. Chạy `lk-bridge run` để bắt đầu.",
                cfg.device_name.unwrap_or_default(),
                cfg.server_url.unwrap_or_default()
            );
        }
        Cmd::Run => {
            let status = runtime::new_status();
            runtime::run(status.clone()).await?;
            let s = status.read().map(|s| s.clone()).unwrap_or_default();
            anyhow::bail!("Bridge dừng: {} {}", s.link, s.detail.unwrap_or_default());
        }
        Cmd::Status => {
            let cfg = config::load();
            match (cfg.server_url, cfg.device_id) {
                (Some(url), Some(id)) => {
                    let token = config::load_token(&id).await.is_some();
                    println!("Server: {url}\nThiết bị: {} ({id})\nToken: {}", cfg.device_name.unwrap_or_default(), if token { "có" } else { "thiếu" });
                    println!("Dữ liệu: {}", config::home_dir().display());
                }
                _ => println!("Chưa ghép nối. Dùng `lk-bridge pair --server URL --code MÃ`."),
            }
        }
        Cmd::Unpair => {
            config::unpair().await?;
            println!("Đã gỡ ghép nối.");
        }
    }
    Ok(())
}
