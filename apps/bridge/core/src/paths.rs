//! Process spawning helpers.
//!
//! A bridge launched from Finder or a login item inherits a minimal PATH, so tools such as
//! `orca`, `git`, `gh`, `claude` and `agy` would not be found. Every child process gets an
//! augmented PATH that includes the usual user and Homebrew install locations.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

pub fn search_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let home = home();
        let mut dirs: Vec<String> = std::env::var("PATH")
            .unwrap_or_default()
            .split(':')
            .filter(|s| !s.is_empty())
            .map(String::from)
            .collect();
        let extra = [
            home.join(".local/bin"),
            home.join(".cargo/bin"),
            home.join("Library/pnpm/bin"),
            home.join(".bun/bin"),
            home.join(".npm-global/bin"),
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/opt/homebrew/sbin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
            PathBuf::from("/usr/sbin"),
            PathBuf::from("/sbin"),
        ];
        for d in extra {
            let s = d.to_string_lossy().into_owned();
            if !dirs.contains(&s) {
                dirs.push(s);
            }
        }
        dirs.join(":")
    })
}

fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

/// Find an executable on the augmented PATH.
pub fn which(bin: &str) -> Option<PathBuf> {
    search_path().split(':').map(|d| Path::new(d).join(bin)).find(|p| is_executable(p))
}

/// A `tokio::process::Command` with the augmented PATH and no inherited stdin.
pub fn command(program: impl AsRef<OsStr>) -> tokio::process::Command {
    let mut c = tokio::process::Command::new(program);
    c.env("PATH", search_path())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    c
}
