//! GitHub pull-request workflow: task branches from origin, draft PRs with CI, merging on GitHub.
//!
//! Git talks to the remote with the user's own credentials; the GitHub CLI (`gh`, already
//! logged in on this machine) creates, reads and merges pull requests.

use crate::git;
use crate::paths::command;
use crate::protocol::{PrChecks, PrInfo, RepoInfo};
use anyhow::{anyhow, bail, Context, Result};
use serde_json::Value;
use std::time::Duration;

const NET: Duration = Duration::from_secs(90);

/// Remote, branches and GitHub CLI state of a repo. `fetch` refreshes origin's branches first.
pub async fn repo_info(repo: &str, fetch: bool) -> RepoInfo {
    let remote_url = git::run(repo, &["remote", "get-url", "origin"]).await.ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if fetch && remote_url.is_some() {
        let _ = timed(git::raw(repo, &["fetch", "--prune", "origin"])).await;
    }
    let default_branch = git::run(repo, &["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"])
        .await
        .ok()
        .map(|s| s.trim().trim_start_matches("origin/").to_string())
        .filter(|s| !s.is_empty());
    let remote_branches = git::run(repo, &["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"])
        .await
        .unwrap_or_default()
        .lines()
        .filter_map(|l| l.trim().strip_prefix("origin/").map(String::from))
        .filter(|b| b != "HEAD" && !b.is_empty())
        .collect();
    RepoInfo {
        github: remote_url.as_deref().is_some_and(|u| u.contains("github.com")),
        remote_url: remote_url.map(|u| strip_credentials(&u)),
        current_branch: git::current_branch(repo).await,
        default_branch,
        remote_branches,
        gh_ready: gh_ready().await,
    }
}

/// `gh` installed and logged in.
pub async fn gh_ready() -> bool {
    match timed(command("gh").args(["auth", "status"]).output()).await {
        Ok(Ok(out)) => out.status.success(),
        _ => false,
    }
}

/// Bring `origin/<branch>` up to date. Errors when offline or the branch is not on origin.
pub async fn fetch(repo: &str, branch: &str) -> Result<()> {
    let out = timed(git::raw(repo, &["fetch", "origin", &format!("+refs/heads/{branch}:refs/remotes/origin/{branch}")]))
        .await
        .map_err(|_| anyhow!("git fetch quá thời gian"))??;
    if !out.ok {
        bail!("{}", first_line(&out.stderr));
    }
    Ok(())
}

/// Branch name for a task: `<prefix><slug>-<4 chars of the card id>`, e.g. `feature/login-3f2a`.
pub fn task_branch(prefix: &str, card_id: &str, title: &str) -> String {
    let short: String = card_id.chars().filter(|c| c.is_ascii_alphanumeric()).take(4).collect();
    let slug = crate::engine::slug(title, 40);
    let name = if slug.is_empty() { format!("task-{short}") } else { format!("{slug}-{short}") };
    format!("{prefix}{name}")
}

/// Commits on HEAD that `base` does not have.
pub async fn ahead(wt: &str, base: &str) -> u32 {
    git::run(wt, &["rev-list", "--count", &format!("{base}..HEAD")]).await.ok().and_then(|s| s.trim().parse().ok()).unwrap_or(0)
}

pub async fn push(wt: &str, branch: &str) -> Result<()> {
    let out = timed(git::raw(wt, &["push", "-u", "origin", &format!("HEAD:refs/heads/{branch}")]))
        .await
        .map_err(|_| anyhow!("git push quá thời gian"))??;
    if !out.ok {
        bail!("git push thất bại: {}", first_line(&out.stderr));
    }
    Ok(())
}

/// Delete the task branch on origin (after a merge or when the work is dropped).
pub async fn delete_remote_branch(repo: &str, branch: &str) {
    let _ = timed(git::raw(repo, &["push", "origin", "--delete", branch])).await;
}

async fn gh(cwd: &str, args: &[&str]) -> Result<String> {
    let out = timed(
        command("gh")
            .current_dir(cwd)
            .env("GH_PROMPT_DISABLED", "1")
            .env("GH_NO_UPDATE_NOTIFIER", "1")
            .env("NO_COLOR", "1")
            .args(args)
            .output(),
    )
    .await
    .map_err(|_| anyhow!("gh {} quá thời gian", args.first().unwrap_or(&"")))?
    .context("không chạy được gh (GitHub CLI). Cài bằng: brew install gh, rồi gh auth login")?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        bail!("gh {}: {}", args.first().unwrap_or(&""), first_line(if err.trim().is_empty() { "lỗi không rõ" } else { &err }));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Open a pull request from `branch` into `base`; returns its URL.
pub async fn pr_create(wt: &str, base: &str, branch: &str, title: &str, body: &str, draft: bool) -> Result<String> {
    let mut args = vec!["pr", "create", "--base", base, "--head", branch, "--title", title, "--body", body];
    if draft {
        args.push("--draft");
    }
    let out = gh(wt, &args).await?;
    out.lines().rev().find(|l| l.trim().starts_with("http")).map(|l| l.trim().to_string()).ok_or_else(|| anyhow!("gh không trả link PR"))
}

/// The open PR whose head is `branch`, if any (a PR opened earlier, e.g. by hand).
pub async fn pr_for_branch(wt: &str, branch: &str) -> Option<PrInfo> {
    let out = gh(wt, &["pr", "list", "--head", branch, "--state", "open", "--json", "number", "--limit", "1"]).await.ok()?;
    let n = serde_json::from_str::<Value>(&out).ok()?.as_array()?.first()?["number"].as_u64()?;
    pr_view(wt, &n.to_string()).await.ok()
}

const VIEW_FIELDS: &str = "number,url,state,isDraft,mergeable,baseRefName,statusCheckRollup";

pub async fn pr_view(wt: &str, pr: &str) -> Result<PrInfo> {
    let out = gh(wt, &["pr", "view", pr, "--json", VIEW_FIELDS]).await?;
    let v: Value = serde_json::from_str(&out).context("gh trả dữ liệu PR không hợp lệ")?;
    Ok(parse_pr(&v))
}

pub async fn pr_ready(wt: &str, pr: &str) -> Result<()> {
    gh(wt, &["pr", "ready", pr]).await.map(|_| ())
}

/// Merge on GitHub. The remote branch is deleted separately: `gh --delete-branch` would also
/// try to switch the local checkout, which a worktree cannot do.
pub async fn pr_merge(wt: &str, pr: &str, method: &str) -> Result<()> {
    let flag = match method {
        "merge" => "--merge",
        "rebase" => "--rebase",
        _ => "--squash",
    };
    gh(wt, &["pr", "merge", pr, flag]).await.map(|_| ())
}

pub async fn pr_close(wt: &str, pr: &str) -> Result<()> {
    gh(wt, &["pr", "close", pr]).await.map(|_| ())
}

pub fn parse_pr(v: &Value) -> PrInfo {
    let state = match v["state"].as_str().unwrap_or("") {
        "MERGED" => "merged",
        "CLOSED" => "closed",
        _ => "open",
    };
    let mergeable = match v["mergeable"].as_str().unwrap_or("") {
        "MERGEABLE" => "mergeable",
        "CONFLICTING" => "conflicting",
        _ => "unknown",
    };
    PrInfo {
        number: v["number"].as_u64().unwrap_or(0),
        url: v["url"].as_str().unwrap_or("").to_string(),
        state: state.into(),
        draft: v["isDraft"].as_bool().unwrap_or(false),
        mergeable: mergeable.into(),
        base: v["baseRefName"].as_str().unwrap_or("").to_string(),
        checks: parse_checks(&v["statusCheckRollup"]),
        checked_at: chrono::Utc::now().to_rfc3339(),
    }
}

/// Fold GitHub check runs and commit statuses into pass / fail / pending counts.
pub fn parse_checks(rollup: &Value) -> PrChecks {
    let mut c = PrChecks::default();
    for item in rollup.as_array().into_iter().flatten() {
        let name = item["name"].as_str().or(item["context"].as_str()).unwrap_or("check").to_string();
        // CheckRun: status + conclusion. StatusContext: state.
        let verdict = if let Some(state) = item["state"].as_str().filter(|_| item["status"].is_null()) {
            match state {
                "SUCCESS" => "pass",
                "FAILURE" | "ERROR" => "fail",
                _ => "pending",
            }
        } else if item["status"].as_str() != Some("COMPLETED") {
            "pending"
        } else {
            match item["conclusion"].as_str().unwrap_or("") {
                "SUCCESS" | "NEUTRAL" | "SKIPPED" => "pass",
                "FAILURE" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED" | "STARTUP_FAILURE" | "STALE" => "fail",
                _ => "pending",
            }
        };
        c.total += 1;
        match verdict {
            "pass" => c.passed += 1,
            "fail" => {
                c.failed += 1;
                if c.failing.len() < 8 {
                    c.failing.push(name);
                }
            }
            _ => c.pending += 1,
        }
    }
    c
}

async fn timed<F: std::future::IntoFuture>(f: F) -> Result<F::Output, tokio::time::error::Elapsed> {
    tokio::time::timeout(NET, f.into_future()).await
}

fn first_line(s: &str) -> String {
    s.lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with("hint:")).unwrap_or("").chars().take(300).collect()
}

/// `https://user:token@github.com/...` -> `https://github.com/...` (never show credentials).
fn strip_credentials(url: &str) -> String {
    match (url.find("://"), url.find('@')) {
        (Some(s), Some(at)) if at > s => format!("{}{}", &url[..s + 3], &url[at + 1..]),
        _ => url.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn checks() {
        let c = parse_checks(&json!([
            { "__typename": "CheckRun", "name": "build", "status": "COMPLETED", "conclusion": "SUCCESS" },
            { "__typename": "CheckRun", "name": "test", "status": "COMPLETED", "conclusion": "FAILURE" },
            { "__typename": "CheckRun", "name": "lint", "status": "IN_PROGRESS", "conclusion": "" },
            { "__typename": "StatusContext", "context": "deploy/preview", "state": "PENDING" },
            { "__typename": "StatusContext", "context": "ci/legacy", "state": "SUCCESS" }
        ]));
        assert_eq!((c.total, c.passed, c.failed, c.pending), (5, 2, 1, 2));
        assert_eq!(c.failing, vec!["test".to_string()]);
    }

    #[test]
    fn names_and_urls() {
        assert_eq!(task_branch("feature/", "3f2a9c1d-aa", "Thêm thanh toán Stripe"), "feature/them-thanh-toan-stripe-3f2a");
        assert_eq!(task_branch("", "3f2a9c1d", "!!!"), "task-3f2a");
        assert_eq!(strip_credentials("https://x:tok@github.com/a/b.git"), "https://github.com/a/b.git");
        assert_eq!(strip_credentials("git@github.com:a/b.git"), "git@github.com:a/b.git");
    }
}
