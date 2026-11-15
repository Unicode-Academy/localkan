//! Machine setup: checks the tools the bridge relies on (besides the agent CLIs) and installs
//! the missing ones, skipping what is already there.
//!
//! macOS only for installing: Xcode Command Line Tools (Apple's own installer dialog),
//! Homebrew (its official .pkg, behind the system password prompt), then Git, Node.js, pnpm,
//! GitHub CLI, ngrok and Google Chrome with Homebrew, and Orca.app from its GitHub release.
//! GitHub sign-in, the ngrok token and the commit identity need the user; they are reported
//! as `Setup` and have their own helpers (`open_gh_login`, `set_ngrok_token`, `set_identity`).

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use serde::Serialize;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader};

use crate::paths::{self, which};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    /// Present and ready.
    Ok,
    /// Not installed.
    Missing,
    /// Installed, but needs the user (sign in, token, name).
    Setup,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: &'static str,
    pub label: &'static str,
    /// What the bridge uses it for.
    pub purpose: &'static str,
    pub required: bool,
    pub state: State,
    /// Version or location when present; what is missing otherwise.
    pub detail: Option<String>,
    /// `install` can install it on this machine.
    pub installable: bool,
}

/// Every item, in the order they are checked, shown and installed (each one only needs those
/// before it).
pub const ITEMS: [&str; 10] = ["clt", "brew", "git", "node", "pnpm", "orca", "gh", "ngrok", "chrome", "identity"];

const MACOS: bool = cfg!(target_os = "macos");

/// Progress of an install, for a UI or a terminal.
pub enum Event<'a> {
    /// Starting this item.
    Step(&'a Item),
    /// A line of output or a status message.
    Line(String),
    /// Finished this item.
    Done(&'a Item, &'a Result<(), String>),
}

pub struct Progress {
    report: Box<dyn Fn(Event) + Send + Sync>,
    cancel: Arc<AtomicBool>,
}

impl Progress {
    pub fn new(cancel: Arc<AtomicBool>, report: impl Fn(Event) + Send + Sync + 'static) -> Self {
        Self { report: Box::new(report), cancel }
    }

    fn say(&self, line: impl Into<String>) {
        (self.report)(Event::Line(line.into()));
    }

    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    async fn until_cancelled(&self) {
        while !self.cancelled() {
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    }
}

// -- checks --------------------------------------------------------------------

/// The state of every item.
pub async fn check() -> Vec<Item> {
    let items = futures_util::future::join_all(ITEMS.iter().map(|id| check_item(id))).await;
    items.into_iter().flatten().collect()
}

/// The state of one item (None for an id that does not apply here, e.g. Homebrew off macOS).
pub async fn check_item(id: &str) -> Option<Item> {
    let (label, purpose, required) = describe(id)?;
    let mut item = Item { id: ITEMS.into_iter().find(|i| *i == id)?, label, purpose, required, state: State::Missing, detail: None, installable: MACOS };
    match id {
        "clt" | "brew" if !MACOS => return None,
        "clt" => {
            if let Some(p) = clt_path().await {
                item.state = State::Ok;
                item.detail = Some(p);
            }
        }
        "brew" => {
            if let Some(b) = brew_path() {
                item.state = State::Ok;
                item.detail = version(&b, &["--version"]).await.or(Some(b.display().to_string()));
            }
        }
        "git" => {
            if let Some(git) = git_path(clt_path().await.is_some()) {
                item.state = State::Ok;
                item.detail = version(&git, &["--version"]).await.map(|v| v.trim_start_matches("git version ").to_string());
            }
        }
        "node" => present(&mut item, "node", &["--version"]).await,
        "pnpm" => present(&mut item, "pnpm", &["--version"]).await,
        "orca" => {
            if let Some(cli) = crate::orca::Orca::locate() {
                item.state = State::Ok;
                item.detail = match orca_app() {
                    Some(app) => version("plutil", &["-extract", "CFBundleShortVersionString", "raw", "-o", "-", &app.join("Contents/Info.plist").to_string_lossy()]).await,
                    None => Some(cli.display().to_string()),
                };
            }
        }
        "gh" => {
            present(&mut item, "gh", &["--version"]).await;
            if item.state == State::Ok {
                item.detail = item.detail.map(|v| v.split_whitespace().nth(2).unwrap_or(&v).to_string());
                if version("gh", &["auth", "status", "--hostname", "github.com"]).await.is_none() {
                    item.state = State::Setup;
                    item.detail = Some("Chưa đăng nhập GitHub".into());
                }
            }
        }
        "ngrok" => {
            present(&mut item, "ngrok", &["version"]).await;
            if item.state == State::Ok {
                item.detail = item.detail.map(|v| v.trim_start_matches("ngrok version ").to_string());
                if !ngrok_has_token().await {
                    item.state = State::Setup;
                    item.detail = Some("Chưa có authtoken".into());
                }
            }
        }
        "chrome" => {
            if let Some(b) = crate::preview::chrome_binary() {
                item.state = State::Ok;
                item.detail = b.ancestors().find(|p| p.extension() == Some(OsStr::new("app"))).and_then(|p| p.file_stem()).map(|s| s.to_string_lossy().into_owned());
            }
        }
        "identity" => {
            item.installable = false;
            match git_path(clt_path().await.is_some()) {
                None => item.detail = Some("Cần Git trước".into()),
                Some(git) => {
                    let name = version(&git, &["config", "--global", "--get", "user.name"]).await.filter(|s| !s.is_empty());
                    let email = version(&git, &["config", "--global", "--get", "user.email"]).await.filter(|s| !s.is_empty());
                    match (name, email) {
                        (Some(n), Some(e)) => {
                            item.state = State::Ok;
                            item.detail = Some(format!("{n} <{e}>"));
                        }
                        _ => {
                            item.state = State::Setup;
                            item.detail = Some("Chưa đặt user.name / user.email".into());
                        }
                    }
                }
            }
        }
        _ => return None,
    }
    Some(item)
}

fn describe(id: &str) -> Option<(&'static str, &'static str, bool)> {
    Some(match id {
        "clt" => ("Xcode Command Line Tools", "Bộ công cụ dòng lệnh của Apple, Homebrew cần nó", true),
        "brew" => ("Homebrew", "Dùng để cài các công cụ còn lại", true),
        "git" => ("Git", "Worktree, commit, merge", true),
        "node" => ("Node.js", "Chạy dev server khi xem trước", true),
        "pnpm" => ("pnpm", "Xem trước dự án dùng pnpm", false),
        "orca" => ("Orca", "Chạy agent, terminal và trình duyệt dùng chung", true),
        "gh" => ("GitHub CLI", "Mở và merge Pull Request", false),
        "ngrok" => ("ngrok", "Link xem trước mở được trên điện thoại", false),
        "chrome" => ("Google Chrome", "Chụp màn hình bản xem trước", false),
        "identity" => ("Tên và email commit", "Git ghi tên tác giả cho mỗi commit", true),
        _ => return None,
    })
}

async fn present(item: &mut Item, bin: &str, args: &[&str]) {
    if let Some(p) = which(bin) {
        item.state = State::Ok;
        item.detail = version(&p, args).await.or(Some(p.display().to_string()));
    }
}

/// First line of a successful command's output (stdout, else stderr), or None.
async fn version(program: impl AsRef<OsStr>, args: &[&str]) -> Option<String> {
    let out = tokio::time::timeout(Duration::from_secs(20), paths::command(program).args(args).output()).await.ok()?.ok()?;
    if !out.status.success() {
        return None;
    }
    let text = if out.stdout.is_empty() { out.stderr } else { out.stdout };
    Some(String::from_utf8_lossy(&text).lines().next().unwrap_or("").trim().to_string())
}

async fn clt_path() -> Option<String> {
    if !MACOS {
        return None;
    }
    version("xcode-select", &["-p"]).await.filter(|p| Path::new(p).exists())
}

fn brew_path() -> Option<PathBuf> {
    ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].into_iter().map(PathBuf::from).find(|p| paths::is_executable(p))
}

/// Git on the search path. On macOS `/usr/bin/git` is only a stub until the Command Line Tools
/// are installed (running it opens Apple's install dialog), so it counts only with them.
fn git_path(clt: bool) -> Option<PathBuf> {
    paths::search_path()
        .split(':')
        .map(|d| Path::new(d).join("git"))
        .filter(|p| !MACOS || clt || p != Path::new("/usr/bin/git"))
        .find(|p| paths::is_executable(p))
}

fn orca_app() -> Option<PathBuf> {
    [PathBuf::from("/Applications/Orca.app"), paths::home().join("Applications/Orca.app")].into_iter().find(|p| p.exists())
}

/// ngrok keeps its token in its config file (`ngrok config check` names the file).
async fn ngrok_has_token() -> bool {
    let Some(line) = version("ngrok", &["config", "check"]).await else { return false };
    let Some(path) = line.split(" at ").nth(1) else { return false };
    std::fs::read_to_string(path.trim())
        .map(|cfg| cfg.lines().any(|l| l.trim().strip_prefix("authtoken:").is_some_and(|v| !v.trim().trim_matches(['"', '\'']).is_empty())))
        .unwrap_or(false)
}

// -- install -------------------------------------------------------------------

/// Install every missing item (or only those in `only`), in order. Each item is checked again
/// right before its turn, so one already provided by an earlier step (Git comes with the
/// Command Line Tools) is skipped. Returns what was attempted and how it went.
pub async fn install_missing(only: Option<&[String]>, p: &Progress) -> Vec<(String, Result<(), String>)> {
    let mut results = Vec::new();
    for id in ITEMS {
        if only.is_some_and(|o| !o.iter().any(|x| x == id)) {
            continue;
        }
        if p.cancelled() {
            break;
        }
        let Some(item) = check_item(id).await else { continue };
        if item.state != State::Missing || !item.installable {
            continue;
        }
        (p.report)(Event::Step(&item));
        let r = install(id, p).await.map_err(|e| format!("{e:#}"));
        (p.report)(Event::Done(&item, &r));
        results.push((id.to_string(), r));
    }
    results
}

/// Install one item.
pub async fn install(id: &str, p: &Progress) -> Result<()> {
    if !MACOS {
        bail!("Cài tự động hiện chỉ hỗ trợ macOS; hãy cài bằng trình quản lý gói của máy.");
    }
    match id {
        "clt" => install_clt(p).await,
        "brew" => install_brew(p).await,
        "git" => brew_install(p, &["git"]).await,
        "node" => brew_install(p, &["node"]).await,
        "pnpm" => brew_install(p, &["pnpm"]).await,
        "gh" => brew_install(p, &["gh"]).await,
        "ngrok" => brew_install(p, &["--cask", "ngrok"]).await,
        "chrome" => brew_install(p, &["--cask", "google-chrome"]).await,
        "orca" => install_orca(p).await,
        other => bail!("Không có cách cài tự động cho \"{other}\"."),
    }
}

async fn install_clt(p: &Progress) -> Result<()> {
    // Opens Apple's "install the command line developer tools" dialog; the download and
    // install happen there.
    let _ = paths::command("xcode-select").arg("--install").output().await;
    p.say("Đã mở hộp thoại của Apple: bấm \"Cài đặt\" (Install), đồng ý điều khoản và chờ cài xong. Localkan tự đi tiếp khi xong.");
    let started = Instant::now();
    loop {
        if clt_path().await.is_some() {
            return Ok(());
        }
        if p.cancelled() {
            bail!("Đã hủy.");
        }
        if started.elapsed() > Duration::from_secs(3600) {
            bail!("Sau 60 phút vẫn chưa thấy Command Line Tools. Nếu đã đóng hộp thoại của Apple, bấm Cài lại.");
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

async fn install_brew(p: &Progress) -> Result<()> {
    let pkg = download(p, "https://github.com/Homebrew/brew/releases/latest/download/Homebrew.pkg", "Homebrew.pkg").await?;
    let pkg_s = pkg.to_string_lossy().into_owned();
    if pkg_s.contains(['"', '\\']) {
        bail!("Đường dẫn tải về không hợp lệ: {pkg_s}");
    }
    // Homebrew's installer gives /opt/homebrew to the user named here (else the console user).
    if let Some(user) = version("id", &["-un"]).await.filter(|u| !u.is_empty()) {
        let _ = paths::command("defaults").args(["write", "/var/tmp/.homebrew_pkg_user", "HOMEBREW_PKG_USER", &user]).output().await;
    }
    p.say("Nhập mật khẩu máy Mac vào hộp thoại của macOS để cài Homebrew.");
    let script = format!(
        "do shell script \"/usr/sbin/installer -pkg \" & quoted form of \"{pkg_s}\" & \" -target /\" with administrator privileges with prompt \"Localkan Bridge cần quyền quản trị để cài Homebrew.\""
    );
    let out = paths::command("osascript").args(["-e", &script]).output().await.context("không chạy được osascript")?;
    let _ = std::fs::remove_file(&pkg);
    let _ = std::fs::remove_file("/var/tmp/.homebrew_pkg_user.plist");
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        if err.contains("-128") {
            bail!("Bạn đã hủy hộp thoại mật khẩu.");
        }
        bail!("Bộ cài Homebrew báo lỗi: {}", err.trim());
    }
    brew_path().map(|_| ()).ok_or_else(|| anyhow!("Bộ cài đã chạy xong nhưng chưa thấy lệnh brew."))
}

async fn brew_install(p: &Progress, args: &[&str]) -> Result<()> {
    let brew = brew_path().ok_or_else(|| anyhow!("Cần cài Homebrew trước."))?;
    let mut cmd = paths::command(&brew);
    cmd.arg("install")
        .args(args)
        .env("NONINTERACTIVE", "1")
        .env("HOMEBREW_NO_AUTO_UPDATE", "1")
        .env("HOMEBREW_NO_ENV_HINTS", "1")
        .env("HOMEBREW_NO_INSTALL_CLEANUP", "1")
        // Never upgrade something already installed (only missing tools get here, but a
        // formula can be installed and unlinked).
        .env("HOMEBREW_NO_INSTALL_UPGRADE", "1");
    run_streaming(cmd, &format!("brew install {}", args.join(" ")), p).await
}

async fn install_orca(p: &Progress) -> Result<()> {
    let asset = if std::env::consts::ARCH == "aarch64" { "orca-macos-arm64.dmg" } else { "orca-macos-x64.dmg" };
    let dmg = download(p, &format!("https://github.com/stablyai/orca/releases/latest/download/{asset}"), asset).await?;
    let r = install_app_from_dmg(p, &dmg, "Orca.app", &apps_dir()).await;
    let _ = std::fs::remove_file(&dmg);
    r.map(|_| ())
}

/// `/Applications` when this user may write there, else `~/Applications`.
fn apps_dir() -> PathBuf {
    let probe = Path::new("/Applications").join(format!(".localkan-write-test-{}", std::process::id()));
    if std::fs::File::create(&probe).is_ok() {
        let _ = std::fs::remove_file(&probe);
        return PathBuf::from("/Applications");
    }
    paths::home().join("Applications")
}

/// Copy `app` out of a disk image into `target` (replacing an older copy).
pub async fn install_app_from_dmg(p: &Progress, dmg: &Path, app: &str, target: &Path) -> Result<PathBuf> {
    let mnt = crate::config::home_dir().join("downloads").join(format!("mnt-{}", std::process::id()));
    std::fs::create_dir_all(&mnt)?;
    let mnt_s = mnt.to_string_lossy().into_owned();
    let attach = paths::command("hdiutil")
        .args(["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", &mnt_s])
        .arg(dmg)
        .output()
        .await?;
    if !attach.status.success() {
        let _ = std::fs::remove_dir(&mnt);
        bail!("Không mở được file {}: {}", dmg.display(), String::from_utf8_lossy(&attach.stderr).trim());
    }
    let copied: Result<PathBuf> = async {
        let src = mnt.join(app);
        if !src.exists() {
            bail!("Trong {} không có {app}.", dmg.display());
        }
        std::fs::create_dir_all(target)?;
        let dest = target.join(app);
        p.say(format!("Đang chép {app} vào {}…", target.display()));
        if dest.exists() {
            std::fs::remove_dir_all(&dest).with_context(|| format!("không xóa được bản cũ {}", dest.display()))?;
        }
        let out = paths::command("ditto").arg(&src).arg(&dest).output().await?;
        if !out.status.success() {
            bail!("Không chép được {app}: {}", String::from_utf8_lossy(&out.stderr).trim());
        }
        Ok(dest)
    }
    .await;
    let detached = paths::command("hdiutil").args(["detach", &mnt_s, "-quiet"]).status().await;
    if !detached.is_ok_and(|s| s.success()) {
        let _ = paths::command("hdiutil").args(["detach", &mnt_s, "-force", "-quiet"]).status().await;
    }
    let _ = std::fs::remove_dir(&mnt);
    copied
}

/// Download `url` into the bridge's data folder, reporting every 10%.
pub async fn download(p: &Progress, url: &str, name: &str) -> Result<PathBuf> {
    let dir = crate::config::home_dir().join("downloads");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(name);
    p.say(format!("Đang tải {name}…"));
    let mut resp = reqwest::Client::new().get(url).send().await?.error_for_status().with_context(|| format!("không tải được {url}"))?;
    let total = resp.content_length().filter(|t| *t > 0);
    let mut file = tokio::fs::File::create(&path).await?;
    let (mut got, mut shown) = (0u64, 0u64);
    while let Some(chunk) = resp.chunk().await? {
        if p.cancelled() {
            drop(file);
            let _ = std::fs::remove_file(&path);
            bail!("Đã hủy.");
        }
        file.write_all(&chunk).await?;
        got += chunk.len() as u64;
        if let Some(t) = total {
            let pct = got * 100 / t;
            if pct >= shown + 10 {
                shown = pct - pct % 10;
                p.say(format!("Đang tải {name}: {pct}% ({} / {} MB)", got >> 20, t >> 20));
            }
        }
    }
    file.flush().await?;
    Ok(path)
}

/// Run a command, passing its output lines to the progress, until it ends or is cancelled.
async fn run_streaming(mut cmd: tokio::process::Command, what: &str, p: &Progress) -> Result<()> {
    p.say(format!("$ {what}"));
    let mut child = cmd.spawn().with_context(|| format!("không chạy được {what}"))?;
    let out = child.stdout.take();
    let err = child.stderr.take();
    let finished = tokio::select! {
        r = async {
            tokio::join!(pump(out, p), pump(err, p));
            child.wait().await
        } => Some(r),
        _ = p.until_cancelled() => None,
    };
    // Dropping the child (kill_on_drop) stops it when cancelled.
    match finished {
        None => bail!("Đã hủy."),
        Some(status) => {
            let status = status?;
            if !status.success() {
                bail!("{what} không thành công ({status}).");
            }
            Ok(())
        }
    }
}

async fn pump<R: AsyncRead + Unpin>(r: Option<R>, p: &Progress) {
    let Some(r) = r else { return };
    let mut lines = BufReader::new(r).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let line = clean_line(&line);
        if !line.is_empty() {
            p.say(line);
        }
    }
}

/// Terminal output without colour codes, keeping only the last state of `\r` progress bars.
fn clean_line(line: &str) -> String {
    static ANSI: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = ANSI.get_or_init(|| regex::Regex::new(r"\x1b\[[0-9;?]*[A-Za-z]").expect("valid regex"));
    let last = line.rsplit('\r').find(|s| !s.trim().is_empty()).unwrap_or("");
    re.replace_all(last, "").trim_end().to_string()
}

// -- things only the user can provide -------------------------------------------

/// Open Terminal on `gh auth login` (GitHub's sign-in in the browser).
pub async fn open_gh_login() -> Result<()> {
    let gh = which("gh").ok_or_else(|| anyhow!("Chưa cài GitHub CLI."))?;
    let gh_s = gh.to_string_lossy().into_owned();
    if gh_s.contains(['"', '\\', '\'']) {
        bail!("Đường dẫn gh không hợp lệ: {gh_s}");
    }
    let script = format!(
        "tell application \"Terminal\"\nactivate\ndo script \"'{gh_s}' auth login --web --git-protocol https --hostname github.com\"\nend tell"
    );
    let out = paths::command("osascript").args(["-e", &script]).output().await?;
    if !out.status.success() {
        bail!("Không mở được Terminal: {}", String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(())
}

/// Save the ngrok authtoken (from dashboard.ngrok.com).
pub async fn set_ngrok_token(token: &str) -> Result<()> {
    let token = token.trim();
    if token.len() < 20 || !token.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        bail!("Authtoken không hợp lệ: chép nguyên chuỗi ở dashboard.ngrok.com → Your Authtoken.");
    }
    let ngrok = which("ngrok").ok_or_else(|| anyhow!("Chưa cài ngrok."))?;
    let out = paths::command(ngrok).args(["config", "add-authtoken", token]).output().await?;
    if !out.status.success() {
        bail!("ngrok báo lỗi: {}", String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(())
}

/// Set git's global user.name and user.email.
pub async fn set_identity(name: &str, email: &str) -> Result<()> {
    let (name, email) = (name.trim(), email.trim());
    if name.is_empty() || name.contains('\n') {
        bail!("Hãy nhập tên.");
    }
    if !email.contains('@') || email.contains(char::is_whitespace) {
        bail!("Email không hợp lệ.");
    }
    let git = git_path(clt_path().await.is_some()).ok_or_else(|| anyhow!("Chưa cài Git."))?;
    for (key, value) in [("user.name", name), ("user.email", email)] {
        let out = paths::command(&git).args(["config", "--global", key, value]).output().await?;
        if !out.status.success() {
            bail!("git config {key}: {}", String::from_utf8_lossy(&out.stderr).trim());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_terminal_lines() {
        assert_eq!(clean_line("\x1b[34m==>\x1b[0m \x1b[1mPouring git\x1b[0m"), "==> Pouring git");
        assert_eq!(clean_line("###      10%\r#####    50%\r######## 100%"), "######## 100%");
        assert_eq!(clean_line("plain"), "plain");
    }

    #[test]
    fn every_item_is_described_in_order() {
        for id in ITEMS {
            assert!(describe(id).is_some(), "{id}");
        }
        // Homebrew comes before everything installed with it.
        let pos = |id| ITEMS.iter().position(|i| *i == id).unwrap();
        for id in ["git", "node", "pnpm", "gh", "ngrok", "chrome"] {
            assert!(pos("brew") < pos(id) && pos("clt") < pos("brew"), "{id}");
        }
    }
}
