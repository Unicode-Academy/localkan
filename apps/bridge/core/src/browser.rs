//! Remote control of the shared browser: Orca's built-in browser.
//!
//! Every tab uses Orca's default profile, so a sign-in done once is shared by every agent and
//! kept across runs. Agents drive it with the `orca` CLI from their terminal; the human drives
//! it from the Localkan web app (screenshot, tap, type, quick sign-in) through these helpers.
//!
//! Typed text and passwords go through `Orca::call_secret`: never logged, masked in errors,
//! never stored, and never shown to the agent.

use crate::orca::Orca;
use crate::protocol::{BrowserShot, BrowserTab};
use anyhow::{anyhow, bail, Result};
use serde::Deserialize;
use serde_json::Value;
use std::time::Duration;

const T: Duration = Duration::from_secs(60);

/// A tab as Orca reports it, before it is matched to a board/card.
#[derive(Debug, Clone)]
pub struct RawTab {
    pub page_id: String,
    pub url: String,
    pub title: String,
    pub active: bool,
    /// Worktree path the tab belongs to (Orca's worktree id is `<repoId>::<path>`).
    pub worktree_path: Option<String>,
}

impl RawTab {
    pub fn into_tab(self, card_id: Option<String>, main: bool) -> BrowserTab {
        BrowserTab {
            page_id: self.page_id,
            url: self.url,
            title: self.title,
            active: self.active,
            worktree_path: self.worktree_path,
            card_id,
            main,
        }
    }
}

pub async fn raw_tabs(orca: &Orca) -> Result<Vec<RawTab>> {
    let r = orca.call_timeout(&["tab", "list", "--worktree", "all"], T).await?;
    let tabs = r["tabs"].as_array().cloned().unwrap_or_default();
    Ok(tabs
        .iter()
        .filter_map(|t| {
            Some(RawTab {
                page_id: t["browserPageId"].as_str()?.to_string(),
                url: t["url"].as_str().unwrap_or("").to_string(),
                title: t["title"].as_str().unwrap_or("").to_string(),
                active: t["active"].as_bool().unwrap_or(false),
                worktree_path: t["worktreeId"]
                    .as_str()
                    .map(|w| w.split_once("::").map(|(_, p)| p).unwrap_or(w).to_string()),
            })
        })
        .collect())
}

/// Tabs that belong to a worktree path (an agent's tabs), most relevant first.
pub async fn tabs_of(orca: &Orca, worktree: &str) -> Result<Vec<RawTab>> {
    let want = norm(worktree);
    let mut tabs: Vec<RawTab> =
        raw_tabs(orca).await?.into_iter().filter(|t| t.worktree_path.as_deref().map(norm) == Some(want.clone())).collect();
    tabs.sort_by_key(|t| !t.active);
    Ok(tabs)
}

fn norm(p: &str) -> String {
    let p = p.trim_end_matches('/');
    // macOS: /tmp and /var live under /private; Orca may report either spelling.
    p.strip_prefix("/private").filter(|r| r.starts_with("/tmp/") || r.starts_with("/var/")).unwrap_or(p).to_string()
}

/// Open a tab. With a worktree it is that worktree's tab (what the agent sees); without one it
/// is a shared tab.
pub async fn open(orca: &Orca, url: &str, worktree: Option<&str>) -> Result<String> {
    let url = normalize_url(url)?;
    let r = match worktree {
        Some(w) => {
            let sel = format!("path:{w}");
            match orca.call_timeout(&["tab", "create", "--url", &url, "--worktree", &sel], T).await {
                Ok(r) => r,
                // Not an Orca worktree (e.g. a folder Orca does not know): fall back to a shared tab.
                Err(_) => orca.call_timeout(&["tab", "create", "--url", &url], T).await?,
            }
        }
        None => orca.call_timeout(&["tab", "create", "--url", &url], T).await?,
    };
    let id = r["browserPageId"].as_str().ok_or_else(|| anyhow!("Orca không trả mã tab"))?.to_string();
    settle(orca, &id).await;
    Ok(id)
}

pub async fn shot(orca: &Orca, page: &str) -> Result<BrowserShot> {
    let info = eval(orca, page, "JSON.stringify([innerWidth, innerHeight, location.href, document.title])").await?;
    let info: (f64, f64, String, String) = info
        .as_str()
        .and_then(|s| serde_json::from_str(s).ok())
        .ok_or_else(|| anyhow!("Không đọc được kích thước trang"))?;
    let r = orca.call_timeout(&["screenshot", "--page", page, "--format", "jpeg"], T).await?;
    let data = r["data"].as_str().ok_or_else(|| anyhow!("Orca không trả ảnh chụp"))?;
    let format = r["format"].as_str().unwrap_or("jpeg");
    Ok(BrowserShot {
        page_id: page.to_string(),
        data_url: format!("data:image/{format};base64,{data}"),
        width: info.0,
        height: info.1,
        url: info.2,
        title: info.3,
    })
}

pub async fn goto(orca: &Orca, page: &str, url: &str) -> Result<()> {
    let url = normalize_url(url)?;
    orca.call_timeout(&["goto", "--page", page, "--url", &url], T).await?;
    settle(orca, page).await;
    Ok(())
}

/// Click at CSS-pixel coordinates of the viewport (the coordinate space of `shot`).
pub async fn tap(orca: &Orca, page: &str, x: f64, y: f64) -> Result<()> {
    if !(x.is_finite() && y.is_finite()) || x < 0.0 || y < 0.0 {
        bail!("Vị trí chạm không hợp lệ");
    }
    let (x, y) = (format!("{}", x.round() as i64), format!("{}", y.round() as i64));
    orca.call_timeout(&["mouse", "move", "--page", page, "--x", &x, "--y", &y], T).await?;
    orca.call_timeout(&["mouse", "down", "--page", page], T).await?;
    orca.call_timeout(&["mouse", "up", "--page", page], T).await?;
    settle(orca, page).await;
    Ok(())
}

/// Type at the current focus. The text may be a password: it never reaches a log.
pub async fn type_text(orca: &Orca, page: &str, text: &str) -> Result<()> {
    if text.is_empty() {
        return Ok(());
    }
    orca.call_secret(&["type", "--page", page, "--input", text], text, T).await?;
    Ok(())
}

pub async fn key(orca: &Orca, page: &str, key: &str) -> Result<()> {
    let ok = !key.is_empty() && key.len() <= 24 && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '+');
    if !ok {
        bail!("Phím không hợp lệ");
    }
    orca.call_timeout(&["keypress", "--page", page, "--key", key], T).await?;
    settle(orca, page).await;
    Ok(())
}

pub async fn scroll(orca: &Orca, page: &str, dy: f64) -> Result<()> {
    let dir = if dy < 0.0 { "up" } else { "down" };
    let amount = format!("{}", dy.abs().clamp(50.0, 5000.0).round() as i64);
    orca.call_timeout(&["scroll", "--page", page, "--direction", dir, "--amount", &amount], T).await?;
    tokio::time::sleep(Duration::from_millis(250)).await;
    Ok(())
}

pub async fn back(orca: &Orca, page: &str) -> Result<()> {
    orca.call_timeout(&["back", "--page", page], T).await?;
    settle(orca, page).await;
    Ok(())
}

pub async fn reload(orca: &Orca, page: &str) -> Result<()> {
    orca.call_timeout(&["reload", "--page", page], T).await?;
    settle(orca, page).await;
    Ok(())
}

pub async fn close(orca: &Orca, page: &str) -> Result<()> {
    orca.call_timeout(&["tab", "close", "--page", page], T).await?;
    Ok(())
}

async fn eval(orca: &Orca, page: &str, js: &str) -> Result<Value> {
    let r = orca.call_timeout(&["eval", "--page", page, "--expression", js], T).await?;
    Ok(r["result"].clone())
}

/// Orca returns `eval` results as text (`"true"`), sometimes as JSON values.
fn truthy(v: &Value) -> bool {
    v.as_bool() == Some(true) || v.as_str() == Some("true")
}

/// Give a navigation a moment to start, then wait (bounded) for the document to load.
async fn settle(orca: &Orca, page: &str) {
    tokio::time::sleep(Duration::from_millis(400)).await;
    let _ = orca
        .call_timeout(
            &["wait", "--page", page, "--fn", "document.readyState === 'complete'", "--timeout", "6000"],
            Duration::from_secs(15),
        )
        .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
}

/// Accept `http(s)://…`, or a bare host (localhost gets http, everything else https).
pub fn normalize_url(raw: &str) -> Result<String> {
    let u = raw.trim();
    if u.is_empty() {
        bail!("Chưa nhập địa chỉ trang");
    }
    if u.contains(char::is_whitespace) {
        bail!("Địa chỉ trang không hợp lệ");
    }
    let lower = u.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return Ok(u.to_string());
    }
    if lower.contains("://") || lower.starts_with("javascript:") || lower.starts_with("data:") || lower.starts_with("file:") {
        bail!("Chỉ mở được trang http hoặc https");
    }
    let local = lower.starts_with("localhost") || lower.starts_with("127.") || lower.starts_with("[::1]") || lower.starts_with("0.0.0.0");
    Ok(format!("{}://{u}", if local { "http" } else { "https" }))
}

// --- quick sign-in -----------------------------------------------------------------------

/// Marks the sign-in fields of the page with `data-lk-field` and reports which exist.
const DETECT_JS: &str = r#"(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
    return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none' && !e.disabled && !e.readOnly; };
  document.querySelectorAll('[data-lk-field]').forEach((e) => e.removeAttribute('data-lk-field'));
  const all = [...document.querySelectorAll('input')].filter(vis);
  const hint = (e) => [e.name, e.id, e.placeholder, e.getAttribute('aria-label'), e.autocomplete].join(' ').toLowerCase();
  const pw = all.find((e) => e.type === 'password');
  const otp = all.find((e) => e.type !== 'password' && e.type !== 'hidden' && (e.autocomplete === 'one-time-code'
    || /otp|one.?time|2fa|mfa|totp|verif|passcode|security.?code|\bcode\b|mã/.test(hint(e))));
  const texty = all.filter((e) => ['text', 'email', 'tel', ''].includes(e.type) && e !== otp);
  let user = texty.find((e) => e.autocomplete === 'username' || e.type === 'email'
    || /user|email|e-mail|login|account|phone|tài khoản|đăng nhập/.test(hint(e)));
  if (!user && pw) user = texty.filter((e) => e.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING).pop();
  if (user) user.setAttribute('data-lk-field', 'user');
  if (pw) pw.setAttribute('data-lk-field', 'password');
  if (otp) otp.setAttribute('data-lk-field', 'otp');
  return JSON.stringify({ user: !!user, password: !!pw, otp: !!otp });
})()"#;

#[derive(Debug, Default, Deserialize)]
struct Fields {
    user: bool,
    password: bool,
    otp: bool,
}

async fn detect(orca: &Orca, page: &str) -> Result<Fields> {
    let v = eval(orca, page, DETECT_JS).await?;
    Ok(v.as_str().and_then(|s| serde_json::from_str(s).ok()).unwrap_or_default())
}

/// Focus a marked field (selecting its current text so typing replaces it), then type.
async fn fill(orca: &Orca, page: &str, field: &str, value: &str) -> Result<()> {
    let js = format!(
        "(() => {{ const e = document.querySelector('[data-lk-field=\"{field}\"]'); if (!e) return false; \
         e.scrollIntoView({{ block: 'center' }}); e.focus(); if (e.select) e.select(); return document.activeElement === e; }})()"
    );
    if !truthy(&eval(orca, page, &js).await?) {
        bail!("Không chọn được ô cần nhập trên trang");
    }
    type_text(orca, page, value).await
}

async fn submit(orca: &Orca, page: &str) -> Result<()> {
    orca.call_timeout(&["keypress", "--page", page, "--key", "Enter"], T).await?;
    tokio::time::sleep(Duration::from_millis(800)).await;
    settle(orca, page).await;
    Ok(())
}

/// Fill the page's sign-in form and submit it, handling "email first, then password" pages
/// and a follow-up one-time-code step. Returns a short note of what was done.
pub async fn login(
    orca: &Orca,
    page: &str,
    username: Option<&str>,
    password: Option<&str>,
    otp: Option<&str>,
) -> Result<String> {
    let username = username.map(str::trim).filter(|s| !s.is_empty());
    let password = password.filter(|s| !s.is_empty());
    let otp = otp.map(str::trim).filter(|s| !s.is_empty());
    if username.is_none() && password.is_none() && otp.is_none() {
        bail!("Nhập tài khoản, mật khẩu hoặc mã xác minh");
    }
    let mut done: Vec<&str> = Vec::new();
    let mut f = detect(orca, page).await?;
    if !f.user && !f.password && !f.otp {
        bail!("Không thấy ô đăng nhập nào trên trang này. Chạm vào ô cần nhập trên ảnh rồi gõ.");
    }

    // A page that only asks for the one-time code.
    if f.otp && !f.password && !f.user {
        let Some(code) = otp else { bail!("Trang đang hỏi mã xác minh: nhập mã vào ô Mã xác minh.") };
        fill(orca, page, "otp", code).await?;
        submit(orca, page).await?;
        return Ok("Đã nhập mã xác minh và gửi.".into());
    }

    let mut submitted = false;
    if f.user {
        if let Some(u) = username {
            fill(orca, page, "user", u).await?;
            done.push("tài khoản");
        }
    }
    let user_filled = !done.is_empty();
    if !f.password && user_filled && password.is_some() {
        // "Email first" page: submit it and look for the password field on the next step.
        submit(orca, page).await?;
        f = detect(orca, page).await?;
    }
    if f.password && password.is_some() {
        fill(orca, page, "password", password.unwrap_or_default()).await?;
        done.push("mật khẩu");
        submit(orca, page).await?;
        submitted = true;
    } else if password.is_some() {
        bail!("Đã điền {} nhưng không thấy ô mật khẩu. Xem ảnh và tiếp tục bằng tay.", join(&done));
    } else if user_filled && !f.password {
        // Only a username was given and the page asks for nothing else yet: go to the next step.
        submit(orca, page).await?;
        submitted = true;
    }

    if let Some(code) = otp {
        if submitted {
            f = detect(orca, page).await?;
        }
        if f.otp {
            fill(orca, page, "otp", code).await?;
            done.push("mã xác minh");
            submit(orca, page).await?;
        } else if done.is_empty() {
            bail!("Không thấy ô mã xác minh trên trang.");
        }
    }
    let _ = eval(orca, page, "document.querySelectorAll('[data-lk-field]').forEach((e) => e.removeAttribute('data-lk-field'))").await;
    if done.is_empty() {
        bail!("Không điền được gì: trang không có ô tương ứng với thông tin bạn nhập.");
    }
    Ok(format!("Đã điền {} rồi gửi. Xem ảnh để chắc đã đăng nhập.", join(&done)))
}

fn join(items: &[&str]) -> String {
    match items {
        [] => String::new(),
        [one] => one.to_string(),
        [rest @ .., last] => format!("{} và {last}", rest.join(", ")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls() {
        assert_eq!(normalize_url("localhost:3000/a").unwrap(), "http://localhost:3000/a");
        assert_eq!(normalize_url("example.com").unwrap(), "https://example.com");
        assert_eq!(normalize_url(" https://x.dev/login ").unwrap(), "https://x.dev/login");
        assert!(normalize_url("javascript:alert(1)").is_err());
        assert!(normalize_url("file:///etc/passwd").is_err());
        assert!(normalize_url("").is_err());
    }

    #[test]
    fn paths() {
        assert_eq!(norm("/private/tmp/x/"), "/tmp/x");
        assert_eq!(norm("/Users/a/repo"), "/Users/a/repo");
        assert_eq!(join(&["a", "b", "c"]), "a, b và c");
        assert!(truthy(&Value::String("true".into())) && truthy(&Value::Bool(true)) && !truthy(&Value::String("false".into())));
    }
}
