//! Git operations the bridge runs directly in a card's worktree.

use crate::paths::command;
use crate::protocol::{DiffFile, DiffResult, FolderInfo};
use crate::redact::redact_patch;
use anyhow::{bail, Context, Result};
use std::collections::HashMap;

pub struct Output {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
}

pub async fn raw(dir: &str, args: &[&str]) -> Result<Output> {
    let out = command("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .await
        .context("không chạy được git")?;
    Ok(Output {
        ok: out.status.success(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

/// Run git and fail with its stderr on a non-zero exit.
pub async fn run(dir: &str, args: &[&str]) -> Result<String> {
    let out = raw(dir, args).await?;
    if !out.ok {
        bail!("git {}: {}", args.join(" "), out.stderr.trim());
    }
    Ok(out.stdout)
}

pub async fn toplevel(path: &str) -> Result<String> {
    if !std::path::Path::new(path).is_dir() {
        bail!("Không tìm thấy thư mục {path} trên máy này.");
    }
    let top = run(path, &["rev-parse", "--show-toplevel"])
        .await
        .map_err(|_| anyhow::anyhow!("{path} không phải là một repo git."))?;
    Ok(top.trim().to_string())
}

pub async fn current_branch(dir: &str) -> Option<String> {
    // symbolic-ref also works on a fresh repo whose branch has no commits yet.
    let b = run(dir, &["symbolic-ref", "--short", "-q", "HEAD"]).await.ok()?;
    let b = b.trim();
    (!b.is_empty()).then(|| b.to_string())
}

pub async fn has_commits(dir: &str) -> bool {
    raw(dir, &["rev-parse", "--verify", "-q", "HEAD"]).await.map(|o| o.ok).unwrap_or(false)
}

/// Worktrees branch off a commit, so a freshly `git init`-ed repo needs one first.
/// Creates an empty commit (no files touched). Returns true when it had to.
pub async fn ensure_initial_commit(dir: &str) -> Result<bool> {
    if has_commits(dir).await {
        return Ok(false);
    }
    let out = raw(dir, &["commit", "--allow-empty", "-m", "Initial commit"]).await?;
    if !out.ok {
        let msg = format!("{}{}", out.stdout, out.stderr);
        if msg.contains("Please tell me who you are") || msg.contains("user.email") {
            bail!("Repo chưa có commit nào và git chưa có tên/email người commit. Chạy: git config --global user.name \"Tên\" && git config --global user.email \"email\"");
        }
        bail!("Repo chưa có commit nào và không tạo được commit đầu tiên: {}", msg.trim());
    }
    Ok(true)
}

pub async fn has_changes(dir: &str) -> Result<bool> {
    Ok(!run(dir, &["status", "--porcelain"]).await?.trim().is_empty())
}

/// Stage everything and commit. Returns false when there was nothing to commit.
pub async fn commit_all(dir: &str, message: &str) -> Result<bool> {
    if !has_changes(dir).await? {
        return Ok(false);
    }
    run(dir, &["add", "-A"]).await?;
    let out = raw(dir, &["commit", "-m", message]).await?;
    if !out.ok {
        let msg = format!("{}{}", out.stdout, out.stderr);
        if msg.contains("Please tell me who you are") || msg.contains("user.email") {
            bail!("Git chưa có tên/email người commit. Chạy: git config --global user.name \"Tên\" && git config --global user.email \"email\"");
        }
        bail!("git commit thất bại: {}", msg.trim());
    }
    Ok(true)
}

async fn merge_base(dir: &str, base: &str) -> String {
    match run(dir, &["merge-base", base, "HEAD"]).await {
        Ok(s) if !s.trim().is_empty() => s.trim().to_string(),
        _ => base.to_string(),
    }
}

/// Everything the card changed relative to its base: commits on the branch, uncommitted
/// edits and untracked files. Read-only: the index is not touched.
pub async fn diff(dir: &str, base: &str) -> Result<DiffResult> {
    let mb = merge_base(dir, base).await;
    diff_spec(dir, &[mb.as_str()], true, base).await
}

/// Changes between two commits (a finished task: its branch, or the commit that merged it).
pub async fn diff_commits(dir: &str, from: &str, to: &str, label: &str) -> Result<DiffResult> {
    diff_spec(dir, &[from, to], false, label).await
}

/// `git diff <spec>`, with per-file stats; `untracked` adds new files not yet added to git.
async fn diff_spec(dir: &str, spec: &[&str], untracked: bool, label: &str) -> Result<DiffResult> {
    let with = |extra: &[&str]| -> Vec<String> { extra.iter().chain(spec.iter()).map(|s| s.to_string()).collect() };
    let args = with(&["diff", "--no-color", "--find-renames"]);
    let mut patch = run(dir, &args.iter().map(String::as_str).collect::<Vec<_>>()).await?;

    let mut files: Vec<DiffFile> = Vec::new();
    let mut stats: HashMap<String, (u64, u64)> = HashMap::new();
    let numstat = with(&["diff", "--numstat", "--find-renames"]);
    for line in run(dir, &numstat.iter().map(String::as_str).collect::<Vec<_>>()).await?.lines() {
        let mut parts = line.splitn(3, '\t');
        let (a, d, p) = (parts.next(), parts.next(), parts.next());
        if let (Some(a), Some(d), Some(p)) = (a, d, p) {
            stats.insert(rename_target(p), (a.parse().unwrap_or(0), d.parse().unwrap_or(0)));
        }
    }
    let names = with(&["diff", "--name-status", "--find-renames"]);
    for line in run(dir, &names.iter().map(String::as_str).collect::<Vec<_>>()).await?.lines() {
        let cols: Vec<&str> = line.split('\t').collect();
        if cols.len() < 2 {
            continue;
        }
        let path = cols.last().unwrap().to_string();
        let status = match cols[0].chars().next() {
            Some('A') => "added",
            Some('D') => "deleted",
            Some('R') => "renamed",
            _ => "modified",
        };
        let (additions, deletions) = stats.get(&path).copied().unwrap_or((0, 0));
        files.push(DiffFile { path, status: status.into(), additions, deletions });
    }

    let untracked = if untracked { run(dir, &["ls-files", "--others", "--exclude-standard"]).await? } else { String::new() };
    for path in untracked.lines().filter(|l| !l.is_empty()) {
        // `git diff --no-index` exits 1 when the files differ, which is the expected case.
        let out = raw(dir, &["diff", "--no-color", "--no-index", "--", "/dev/null", path]).await?;
        let additions = out.stdout.lines().filter(|l| l.starts_with('+') && !l.starts_with("+++")).count() as u64;
        patch.push_str(&out.stdout);
        files.push(DiffFile { path: path.to_string(), status: "untracked".into(), additions, deletions: 0 });
    }

    Ok(DiffResult { base_ref: label.to_string(), files, patch: redact_patch(&patch) })
}

/// numstat prints renames as `old => new` or `dir/{old => new}/file`; keep the new path.
fn rename_target(p: &str) -> String {
    if let (Some(open), Some(close)) = (p.find('{'), p.find('}')) {
        let inner = &p[open + 1..close];
        let new = inner.split(" => ").last().unwrap_or(inner);
        return format!("{}{}{}", &p[..open], new, &p[close + 1..]).replace("//", "/");
    }
    p.split(" => ").last().unwrap_or(p).to_string()
}

/// `~/x` -> `$HOME/x`; everything else unchanged.
pub fn expand_path(p: &str) -> String {
    let p = p.trim();
    match p.strip_prefix("~/") {
        Some(rest) => crate::paths::home().join(rest).to_string_lossy().into_owned(),
        None if p == "~" => crate::paths::home().to_string_lossy().into_owned(),
        None => p.to_string(),
    }
}

pub async fn folder_info(path: &str) -> FolderInfo {
    let dir = std::path::Path::new(path);
    let exists = dir.is_dir();
    let is_git_repo = exists
        && raw(path, &["rev-parse", "--is-inside-work-tree"]).await.map(|o| o.ok && o.stdout.trim() == "true").unwrap_or(false);
    // macOS drops these into otherwise empty folders.
    let is_empty = exists
        && std::fs::read_dir(dir)
            .map(|mut it| it.all(|e| e.ok().is_some_and(|e| matches!(e.file_name().to_str(), Some(".DS_Store" | ".localized")))))
            .unwrap_or(false);
    let child_repos = if exists && !is_git_repo { child_repos(dir) } else { Vec::new() };
    FolderInfo { path: path.to_string(), exists, is_git_repo, is_empty, child_repos }
}

/// Git repos directly inside `dir` (frontend/, backend/…), backend-like ones first: on a
/// multi-repo board they ship in this order, APIs before the apps that call them.
pub fn child_repos(dir: &std::path::Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.path().is_dir() && e.path().join(".git").exists())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| !n.starts_with('.'))
                .collect()
        })
        .unwrap_or_default();
    let backendish = |n: &str| {
        let n = n.to_lowercase();
        ["backend", "api", "server", "service"].iter().any(|k| n.contains(k)) || n == "be"
    };
    names.sort_by_key(|n| (!backendish(n), n.to_lowercase()));
    names
}

/// Create the folder if needed and make it a git repository on branch `main`.
pub async fn init(dir: &str) -> Result<()> {
    std::fs::create_dir_all(dir).with_context(|| format!("không tạo được thư mục {dir}"))?;
    run(dir, &["init", "-b", "main"]).await?;
    Ok(())
}

/// Add a pattern to the repository's local exclude file (never committed, applies to all
/// worktrees of the repo).
pub async fn exclude_locally(dir: &str, pattern: &str) -> Result<()> {
    use std::io::Write;
    let common = run(dir, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).await?;
    let file = std::path::Path::new(common.trim()).join("info").join("exclude");
    let current = std::fs::read_to_string(&file).unwrap_or_default();
    if current.lines().any(|l| l.trim() == pattern) {
        return Ok(());
    }
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&file)?;
    let sep = if current.is_empty() || current.ends_with('\n') { "" } else { "\n" };
    writeln!(f, "{sep}{pattern}")?;
    Ok(())
}

pub async fn branch_exists(dir: &str, branch: &str) -> bool {
    raw(dir, &["rev-parse", "--verify", "-q", &format!("refs/heads/{branch}")]).await.map(|o| o.ok).unwrap_or(false)
}

/// Is `commit` already contained in `target` (e.g. a branch merged into main)?
pub async fn is_ancestor(dir: &str, commit: &str, target: &str) -> bool {
    raw(dir, &["merge-base", "--is-ancestor", commit, target]).await.map(|o| o.ok).unwrap_or(false)
}
