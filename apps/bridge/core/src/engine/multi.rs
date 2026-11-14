//! Multi-repo boards: a folder that is not a git repo itself but holds several (frontend/,
//! backend/…), as when an agent is pointed at the parent folder to work on both.
//!
//! Orca only manages git repos, so each board gets a small, private, never-pushed "workspace"
//! repo under the bridge's data folder. A task is a worktree of that repo (Orca runs the agent
//! there) holding one worktree per real repo at the same relative path: `<task>/frontend`,
//! `<task>/backend`. The agent sees the same layout as the original folder. Each repo then
//! ships its own way: merge its PR, merge and push, or merge locally.

use super::*;

/// A git repo inside a multi-repo board's folder.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ChildRepo {
    pub name: String,
    pub path: String,
}

/// One repo's part of a task on a multi-repo board.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ChildWt {
    pub name: String,
    pub repo_path: String,
    pub worktree: String,
    pub branch: String,
    /// Ref the worktree started from (the diff base), e.g. `origin/main`.
    pub base_ref: String,
    /// Branch it merges into, e.g. `main`.
    pub merge_target: String,
    pub git: GitSettings,
    pub pr: Option<PrInfo>,
    /// "merged" | "pushed" | "local" | "skipped" once this repo's part is done.
    pub shipped: Option<String>,
}

/// The task text plus a note on the folder layout, so the agent knows where each repo is.
pub(super) fn with_layout(prompt: &str, children: &[ChildWt]) -> String {
    let layout = children
        .iter()
        .map(|c| format!("- `{}/`: its own git repository, on branch `{}` (from `{}`)", c.name, c.branch, c.base_ref))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "{}\n\nThis folder holds several separate git repositories (there is no repository at the top level):\n{layout}\nChange whichever of them the task needs, in place.",
        prompt.trim()
    )
}

pub(super) fn card_repos(children: &[ChildWt]) -> Vec<CardRepoInfo> {
    children
        .iter()
        .map(|c| CardRepoInfo {
            name: c.name.clone(),
            branch: c.branch.clone(),
            base: c.merge_target.clone(),
            flow: c.git.flow.clone(),
            pr: c.pr.clone(),
            shipped: c.shipped.clone(),
        })
        .collect()
}

/// Prefix every path of a unified diff with `dir/` (one patch for several repos).
pub(super) fn prefix_patch(patch: &str, dir: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    for l in patch.lines() {
        let line = if let Some(rest) = l.strip_prefix("diff --git a/") {
            match rest.find(" b/") {
                Some(i) => format!("diff --git a/{dir}/{} b/{dir}/{}", &rest[..i], &rest[i + 3..]),
                None => l.to_string(),
            }
        } else if let Some(p) = l.strip_prefix("--- a/") {
            format!("--- a/{dir}/{p}")
        } else if let Some(p) = l.strip_prefix("+++ b/") {
            format!("+++ b/{dir}/{p}")
        } else if let Some(p) = l.strip_prefix("rename from ") {
            format!("rename from {dir}/{p}")
        } else if let Some(p) = l.strip_prefix("rename to ") {
            format!("rename to {dir}/{p}")
        } else {
            l.to_string()
        };
        out.push(line);
    }
    let mut s = out.join("\n");
    if patch.ends_with('\n') {
        s.push('\n');
    }
    s
}

/// The repo to preview: one whose package.json has a dev/start script, app-like names first.
pub(super) fn pick_app(dirs: &[(&str, &str)]) -> Option<usize> {
    let has_script = |dir: &str| {
        std::fs::read_to_string(Path::new(dir).join("package.json"))
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .is_some_and(|v| v["scripts"]["dev"].is_string() || v["scripts"]["start"].is_string())
    };
    let appish = |n: &str| {
        let n = n.to_lowercase();
        ["frontend", "web", "client", "app", "ui", "site", "fe"].iter().any(|k| n.contains(k))
    };
    dirs.iter()
        .enumerate()
        .filter(|(_, (_, d))| has_script(d))
        .min_by_key(|(_, (n, _))| !appish(n))
        .map(|(i, _)| i)
}

fn workspace_dir(project_id: &str, display: &str) -> std::path::PathBuf {
    let short: String = project_id.chars().filter(|c| c.is_ascii_alphanumeric()).take(6).collect();
    let name = slug(display, 30);
    let name = if name.is_empty() { "board".to_string() } else { name };
    crate::config::home_dir().join("workspaces").join(format!("{name}-{short}"))
}

/// The board's private workspace repo: empty, ignores everything in its worktrees.
async fn ensure_workspace(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir).with_context(|| format!("không tạo được {}", dir.display()))?;
    let d = dir.to_string_lossy().into_owned();
    if !dir.join(".git").exists() {
        git::run(&d, &["init", "-q", "-b", "main"]).await?;
    }
    std::fs::write(dir.join(".gitignore"), "# Localkan workspace: task folders hold the real repos.\n/*\n!/.gitignore\n")?;
    if !git::has_commits(&d).await {
        git::run(&d, &["add", ".gitignore"]).await?;
        git::run(&d, &["-c", "user.name=Localkan", "-c", "user.email=localkan@localhost", "commit", "-q", "-m", "Localkan workspace"]).await?;
    }
    Ok(())
}

impl Engine {
    pub(super) async fn register_multi(&self, project_id: &str, parent: &str, children: Vec<ChildRepo>) -> Result<Value> {
        let orca = self.orca()?;
        orca.ensure_runtime().await?;
        let display_name = Path::new(parent).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or(parent.to_string());
        let existing = self.project(project_id).await;
        let ws = match existing.as_ref().and_then(|e| e.workspace.clone()) {
            Some(w) => std::path::PathBuf::from(w),
            None => workspace_dir(project_id, &display_name),
        };
        ensure_workspace(&ws).await?;
        let ws = ws.to_string_lossy().into_owned();
        let repo_id = self.orca_repo_id(&ws).await?;
        let p = ProjectRt {
            project_id: project_id.into(),
            repo_path: parent.to_string(),
            orca_repo_id: repo_id,
            base_ref: String::new(),
            display_name: display_name.clone(),
            coord_handle: existing.as_ref().and_then(|e| e.coord_handle.clone()),
            run_id: existing.as_ref().and_then(|e| e.run_id.clone()),
            children: children.clone(),
            workspace: Some(ws),
        };
        self.save_project(p).await;
        self.ensure_coordinator(project_id).await?;
        let mut repos = Vec::new();
        for c in &children {
            repos.push(json!({ "name": c.name, "path": c.path, "info": github::repo_info(&c.path, false).await }));
        }
        let first = repos.first().map(|r| r["info"].clone()).unwrap_or(Value::Null);
        Ok(json!({ "baseRef": null, "displayName": display_name, "initialized": false, "repo": first, "repos": repos }))
    }

    /// Repo info for the board's git settings: the first repo, plus every repo as `children`.
    pub(super) async fn multi_repo_info(&self, project: &ProjectRt) -> Value {
        let mut children = Vec::new();
        for c in &project.children {
            children.push(json!({ "name": c.name, "info": github::repo_info(&c.path, true).await }));
        }
        let mut first = children.first().map(|c| c["info"].clone()).unwrap_or(json!({}));
        first["children"] = json!(children);
        first
    }

    pub(super) async fn start_multi(self: &Arc<Self>, p: CardStart, project: ProjectRt) -> Result<Value> {
        self.ensure_coordinator(&p.project_id).await?;
        let orca = self.orca()?;
        let task = branch_name(&p.card_id, &p.title);
        let wt = orca
            .call_timeout(
                &["worktree", "create", "--repo", &format!("id:{}", project.orca_repo_id), "--name", &task, "--base-branch", "main", "--no-parent"],
                Duration::from_secs(300),
            )
            .await
            .context("không tạo được thư mục cho việc")?;
        let root = s(&wt["worktree"]["path"]).ok_or_else(|| anyhow!("Orca không trả đường dẫn thư mục việc"))?;
        let mut children: Vec<ChildWt> = Vec::new();
        for c in &project.children {
            match self.add_child(&p, c, &root).await {
                Ok(ch) => children.push(ch),
                Err(e) => {
                    for ch in &children {
                        let _ = git::raw(&ch.repo_path, &["worktree", "remove", "--force", &ch.worktree]).await;
                        let _ = git::raw(&ch.repo_path, &["branch", "-D", &ch.branch]).await;
                    }
                    let _ = orca.call(&["worktree", "rm", "--worktree", &format!("path:{root}"), "--force"]).await;
                    return Err(e.context(format!("repo {}", c.name)));
                }
            }
        }

        let log_seq = self.store.last_seq(&p.card_id);
        let branch = children.first().map(|c| c.branch.clone());
        self.put_card(CardRt {
            card_id: p.card_id.clone(),
            project_id: p.project_id.clone(),
            title: p.title.clone(),
            agent: p.agent.clone(),
            model: p.model.clone(),
            mode: p.mode.clone(),
            worktree_path: Some(root.clone()),
            branch: branch.clone(),
            git: p.git.clone(),
            children: children.clone(),
            active: true,
            log_seq,
            ..Default::default()
        })
        .await;
        let mut patch = CardStatePatch::new(&p.card_id);
        patch.run_state = Some(RUN_STARTING.into());
        patch.status = Some("in_progress".into());
        patch.branch = Some(branch);
        patch.worktree_path = Some(Some(root.clone()));
        patch.waiting = Some(None);
        patch.error = Some(None);
        patch.summary = Some(None);
        patch.repos = Some(card_repos(&children));
        self.emit(patch).await;
        self.sys(&p.card_id, format!("Đã tạo thư mục việc {root}")).await;
        for ch in &children {
            self.sys(&p.card_id, format!("{}: nhánh {} (từ {})", ch.name, ch.branch, ch.base_ref)).await;
        }

        let images = self.fetch_attachments(&p.card_id, &root, &p.attachments).await;
        let ctx = context::compose_context(&project.repo_path, &p.card_id, p.parent.as_ref());
        let skill_names = crate::skills::prepare_multi(
            &project.repo_path,
            &root,
            &children.iter().map(|c| (c.name.clone(), c.worktree.clone())).collect::<Vec<_>>(),
        );
        if !skill_names.is_empty() {
            self.sys(&p.card_id, format!("Đã nạp skill: {}.", skill_names.join(", "))).await;
        }
        let prompt = format!("{}{}", with_layout(&p.prompt, &children), crate::skills::note(&skill_names));
        let spec = compose_spec(&p.title, &prompt, &p.mode, &images, &ctx);
        let me = self.clone();
        let card_id = p.card_id.clone();
        tokio::spawn(async move { me.dispatch(&card_id, spec, None, None).await });
        Ok(json!({ "accepted": true }))
    }

    /// One repo's worktree inside the task folder, on the task branch, from a fresh base.
    async fn add_child(&self, p: &CardStart, c: &ChildRepo, root: &str) -> Result<ChildWt> {
        let g = p.repo_git.get(&c.name).cloned().unwrap_or_else(|| p.git.clone());
        git::ensure_initial_commit(&c.path).await?;
        let local = git::current_branch(&c.path).await.unwrap_or_else(|| "main".into());
        let base = if g.from_origin() { g.base_branch.clone().filter(|b| !b.is_empty()).unwrap_or(local.clone()) } else { local.clone() };
        let mut from = base.clone();
        if g.from_origin() {
            match github::fetch(&c.path, &base).await {
                Ok(()) => from = format!("origin/{base}"),
                Err(e) => self.sys(&p.card_id, format!("{}: không lấy được origin/{base} ({e}); dùng nhánh trên máy.", c.name)).await,
            }
        }
        let mut branch = if g.from_origin() { github::task_branch(&g.branch_prefix, &p.card_id, &p.title) } else { branch_name(&p.card_id, &p.title) };
        if git::branch_exists(&c.path, &branch).await {
            branch = format!("{branch}-{}", p.card_id.chars().filter(|c| c.is_ascii_alphanumeric()).skip(4).take(4).collect::<String>());
        }
        let dest = Path::new(root).join(&c.name).to_string_lossy().into_owned();
        git::run(&c.path, &["worktree", "add", "-q", "-b", &branch, &dest, &from]).await?;
        Ok(ChildWt {
            name: c.name.clone(),
            repo_path: c.path.clone(),
            worktree: dest,
            branch,
            base_ref: from,
            merge_target: base,
            git: g,
            pr: None,
            shipped: None,
        })
    }

    pub(super) async fn set_children(&self, card_id: &str, children: Vec<ChildWt>) {
        self.update_card(card_id, |c| c.children = children.clone()).await;
        let mut patch = CardStatePatch::new(card_id);
        patch.repos = Some(card_repos(&children));
        self.emit(patch).await;
    }

    /// Diff of every repo, paths prefixed with the repo folder (`frontend/src/…`).
    pub(super) async fn multi_diff(&self, card: &CardRt) -> Result<DiffResult> {
        let mut files = Vec::new();
        let mut patch = String::new();
        let mut labels = Vec::new();
        for ch in &card.children {
            let d = if Path::new(&ch.worktree).exists() {
                git::diff(&ch.worktree, &ch.base_ref).await
            } else {
                self.history_diff(&ch.repo_path, &ch.branch, &ch.merge_target, ch.pr.as_ref().map(|p| p.number)).await
            };
            let Ok(d) = d else { continue };
            labels.push(format!("{} → {}", ch.name, ch.merge_target));
            for f in d.files {
                files.push(DiffFile { path: format!("{}/{}", ch.name, f.path), ..f });
            }
            patch.push_str(&prefix_patch(&d.patch, &ch.name));
        }
        if labels.is_empty() {
            bail!("Không còn thay đổi để xem ở repo nào.");
        }
        Ok(DiffResult { base_ref: labels.join(" · "), files, patch })
    }

    /// Agent finished: push each PR-flow repo that changed and open/update its draft PR.
    pub(super) async fn publish_multi(&self, card_id: &str) -> Result<()> {
        let card = self.card(card_id).await?;
        let mut children = card.children.clone();
        let mut notes = Vec::new();
        for ch in children.iter_mut().filter(|c| c.shipped.is_none() && c.git.pr_flow() && (c.git.auto_draft_pr || c.pr.is_some())) {
            if !Path::new(&ch.worktree).exists() {
                continue;
            }
            match self.ensure_pr_at(&card, &ch.worktree, &ch.branch, &ch.merge_target, ch.pr.clone(), true).await {
                Ok(pr) => {
                    notes.push(format!("{}: PR #{}{}", ch.name, pr.number, if pr.draft { " (nháp)" } else { "" }));
                    ch.pr = Some(pr);
                }
                Err(e) if format!("{e:#}").contains("chưa có thay đổi") => {}
                Err(e) => notes.push(format!("{}: chưa đẩy được ({e:#})", ch.name)),
            }
        }
        self.set_children(card_id, children).await;
        if !notes.is_empty() {
            self.sys(card_id, format!("GitHub: {}", notes.join(" · "))).await;
        }
        Ok(())
    }

    /// Read each repo's PR; repos whose PR was merged on GitHub are cleaned up, and the task
    /// completes when nothing else is left.
    pub(super) async fn refresh_multi(&self, card_id: &str) -> Result<()> {
        let card = self.card(card_id).await?;
        if !card.active {
            return Ok(());
        }
        let mut children = card.children.clone();
        let mut changed = false;
        for ch in children.iter_mut().filter(|c| c.shipped.is_none()) {
            let dir = if Path::new(&ch.worktree).exists() { ch.worktree.clone() } else { ch.repo_path.clone() };
            let pr = match &ch.pr {
                Some(pr) => github::pr_view(&dir, &pr.number.to_string()).await.ok(),
                None if ch.git.pr_flow() => github::pr_for_branch(&dir, &ch.branch).await,
                None => None,
            };
            let Some(pr) = pr else { continue };
            if ch.pr.as_ref().is_none_or(|old| !old.same_as(&pr)) {
                changed = true;
            }
            if pr.state == "merged" {
                self.cleanup_child(ch, true).await;
                ch.shipped = Some("merged".into());
                changed = true;
            }
            ch.pr = Some(pr);
        }
        if changed {
            self.set_children(card_id, children.clone()).await;
        }
        if self.nothing_left(&children).await {
            self.complete_multi(card_id, "Các PR đã được merge trên GitHub.").await?;
        }
        Ok(())
    }

    /// At least one repo merged on GitHub and every other repo is done or unchanged.
    async fn nothing_left(&self, children: &[ChildWt]) -> bool {
        if !children.iter().any(|c| c.shipped.as_deref() == Some("merged") && c.pr.is_some()) {
            return false;
        }
        for c in children.iter().filter(|c| c.shipped.is_none()) {
            if !Path::new(&c.worktree).exists() {
                continue;
            }
            if git::has_changes(&c.worktree).await.unwrap_or(true) || github::ahead(&c.worktree, &c.base_ref).await > 0 {
                return false;
            }
        }
        true
    }

    async fn cleanup_child(&self, ch: &ChildWt, delete_remote: bool) {
        if Path::new(&ch.worktree).exists() {
            let _ = git::raw(&ch.repo_path, &["worktree", "remove", "--force", &ch.worktree]).await;
        }
        let _ = git::raw(&ch.repo_path, &["branch", "-D", &ch.branch]).await;
        if delete_remote {
            github::delete_remote_branch(&ch.repo_path, &ch.branch).await;
        }
        if ch.git.from_origin() {
            let _ = self.update_local_base(&ch.repo_path, &ch.merge_target).await;
        }
    }

    /// Every repo's part is done on GitHub: close the task like a finish would.
    async fn complete_multi(&self, card_id: &str, note: &str) -> Result<()> {
        let card = self.card(card_id).await?;
        let project = self.project(&card.project_id).await.ok_or_else(|| anyhow!("không thấy bảng"))?;
        self.previews.stop(card_id).await;
        self.release(&card).await;
        for ch in card.children.iter().filter(|c| c.shipped.is_none()) {
            self.cleanup_child(ch, false).await;
        }
        self.remove_task_folder(&card).await;
        let _ = context::set_status(&project.repo_path, card_id, "merged", &now()).await;
        let url = card.children.iter().find_map(|c| c.pr.as_ref().map(|p| p.url.clone()));
        let summary = format!("{note} {}", ship_summary(&card.children)).trim().to_string();
        self.update_card(card_id, |c| {
            c.active = false;
            c.running = false;
            c.waiting_kind = None;
            c.publish_pending = false;
        })
        .await;
        self.sys(card_id, summary.clone()).await;
        let mut patch = CardStatePatch::new(card_id);
        patch.status = Some("done".into());
        patch.run_state = Some("idle".into());
        patch.waiting = Some(None);
        patch.preview = Some(None);
        patch.pr_url = Some(url);
        patch.summary = Some(Some(summary));
        patch.repos = Some(card_repos(&card.children));
        self.emit(patch).await;
        Ok(())
    }

    async fn remove_task_folder(&self, card: &CardRt) {
        if let Some(root) = card.worktree_path.as_deref().filter(|w| Path::new(w).exists()) {
            let ok = match self.orca() {
                Ok(o) => o.call(&["worktree", "rm", "--worktree", &format!("path:{root}"), "--force"]).await.is_ok(),
                Err(_) => false,
            };
            if !ok {
                if let Some(ws) = self.project(&card.project_id).await.and_then(|p| p.workspace) {
                    let _ = git::raw(&ws, &["worktree", "remove", "--force", root]).await;
                }
            }
        }
    }

    /// Merge origin/<base> into each repo's task branch (and push to its PR). Conflicts undo.
    pub(super) async fn sync_multi(&self, card_id: &str) -> Result<Value> {
        let card = self.card(card_id).await?;
        let mut msgs = Vec::new();
        let mut conflict = false;
        for ch in card.children.iter().filter(|c| c.shipped.is_none() && c.git.from_origin() && Path::new(&c.worktree).exists()) {
            if github::fetch(&ch.repo_path, &ch.merge_target).await.is_err() {
                msgs.push(format!("{}: không lấy được origin/{}", ch.name, ch.merge_target));
                continue;
            }
            git::commit_all(&ch.worktree, &format!("Lưu thay đổi trước khi cập nhật theo {}", ch.merge_target)).await?;
            let out = git::raw(&ch.worktree, &["merge", "--no-edit", &format!("origin/{}", ch.merge_target)]).await?;
            if !out.ok {
                let _ = git::raw(&ch.worktree, &["merge", "--abort"]).await;
                if format!("{}{}", out.stdout, out.stderr).contains("CONFLICT") {
                    conflict = true;
                    msgs.push(format!("{}: xung đột với origin/{}, đã hủy merge", ch.name, ch.merge_target));
                } else {
                    msgs.push(format!("{}: không merge được origin/{}", ch.name, ch.merge_target));
                }
                continue;
            }
            if ch.pr.is_some() {
                let _ = github::push(&ch.worktree, &ch.branch).await;
            }
            msgs.push(format!("{}: đã cập nhật theo origin/{}", ch.name, ch.merge_target));
        }
        let _ = self.refresh_multi(card_id).await;
        let message = if msgs.is_empty() { "Không có repo nào cần cập nhật.".to_string() } else { msgs.join(" · ") };
        self.sys(card_id, message.clone()).await;
        Ok(json!({ "ok": !conflict, "conflict": conflict, "message": message }))
    }

    pub(super) async fn finish_multi(&self, p: CardFinish, card: CardRt) -> Result<Value> {
        let project = self.project(&card.project_id).await.ok_or_else(|| anyhow!("Không tìm thấy bảng"))?;
        let message = if p.commit_message.trim().is_empty() { card.title.clone() } else { p.commit_message.trim().to_string() };
        let action = match p.action.as_str() {
            "merge_pr" | "merge_push" | "merge" => "ship",
            a => a,
        };
        if !matches!(action, "ship" | "commit" | "discard") {
            bail!("Bảng nhiều repo: dùng Hoàn tất (mỗi repo theo cách của nó), Commit vào nhánh hoặc Hủy.");
        }
        self.previews.stop(&card.card_id).await;
        let mut children = card.children.clone();

        if action == "ship" {
            for i in 0..children.len() {
                if children[i].shipped.is_some() {
                    continue;
                }
                let mut ch = children[i].clone();
                let res = if Path::new(&ch.worktree).exists() {
                    self.ship_child(&card, &mut ch, &message).await
                } else {
                    ch.shipped = Some("skipped".into());
                    Ok(())
                };
                children[i] = ch;
                if let Err(e) = res {
                    self.set_children(&card.card_id, children.clone()).await;
                    let done = ship_summary(&children);
                    bail!("{}: {e:#}{}", children[i].name, if done.is_empty() { String::new() } else { format!(" (đã xong: {done})") });
                }
            }
        } else {
            for ch in children.iter().filter(|c| c.shipped.is_none() && Path::new(&c.worktree).exists()) {
                if action == "commit" {
                    git::commit_all(&ch.worktree, &message).await.with_context(|| ch.name.clone())?;
                } else if let Some(pr) = ch.pr.as_ref().filter(|pr| pr.state == "open") {
                    let _ = github::pr_close(&ch.repo_path, &pr.number.to_string()).await;
                    github::delete_remote_branch(&ch.repo_path, &ch.branch).await;
                }
            }
        }

        // Clean up: worktrees (task folder too), and branches that are merged or dropped.
        self.release(&card).await;
        let mut notes = Vec::new();
        for ch in &children {
            if Path::new(&ch.worktree).exists() {
                let _ = git::raw(&ch.repo_path, &["worktree", "remove", "--force", &ch.worktree]).await;
            }
            let shipped = matches!(ch.shipped.as_deref(), Some("merged" | "pushed" | "skipped"));
            if action == "discard" || shipped {
                let _ = git::raw(&ch.repo_path, &["branch", "-D", &ch.branch]).await;
            }
            if shipped && ch.shipped.as_deref() == Some("merged") && ch.pr.is_some() {
                github::delete_remote_branch(&ch.repo_path, &ch.branch).await;
            }
            if action == "ship" && matches!(ch.shipped.as_deref(), Some("merged" | "pushed")) && ch.git.from_origin() {
                let n = self.update_local_base(&ch.repo_path, &ch.merge_target).await;
                if !n.is_empty() {
                    notes.push(format!("{}: {n}", ch.name));
                }
            }
        }
        self.remove_task_folder(&card).await;

        let status = match action {
            "ship" => "merged",
            "commit" => "committed",
            _ => "discarded",
        };
        if let Err(e) = context::set_status(&project.repo_path, &card.card_id, status, &now()).await {
            tracing::warn!("handoff status: {e:#}");
        }
        let summary = match action {
            "ship" => format!("{} {}", ship_summary(&children), notes.join(" ")),
            "commit" => format!("Đã commit vào nhánh của từng repo: {}.", children.iter().map(|c| format!("{} ({})", c.name, c.branch)).collect::<Vec<_>>().join(", ")),
            _ => "Đã hủy thay đổi và xóa nhánh ở mọi repo.".to_string(),
        }
        .trim()
        .to_string();
        let pr_url = children.iter().find_map(|c| c.pr.as_ref().filter(|p| p.state == "merged").map(|p| p.url.clone()));
        self.update_card(&card.card_id, |c| {
            c.active = false;
            c.running = false;
            c.waiting_kind = None;
            c.pending_retry = None;
            c.publish_pending = false;
            c.children = children.clone();
            c.last.status = Some("done".into());
            c.last.run_state = Some("idle".into());
            c.last.waiting = Some(None);
            c.last.repos = Some(card_repos(&children));
        })
        .await;
        let mut patch = CardStatePatch::new(&card.card_id);
        patch.repos = Some(card_repos(&children));
        self.send_event("card.state", serde_json::to_value(&patch).unwrap_or_default());
        self.sys(&card.card_id, summary.clone()).await;
        Ok(json!({ "prUrl": pr_url, "message": summary, "repos": card_repos(&children) }))
    }

    /// Ship one repo its own way. Repos without changes are skipped.
    async fn ship_child(&self, card: &CardRt, ch: &mut ChildWt, message: &str) -> Result<()> {
        git::commit_all(&ch.worktree, message).await?;
        let changed = ch.pr.is_some() || github::ahead(&ch.worktree, &ch.base_ref).await > 0;
        if !changed {
            ch.shipped = Some("skipped".into());
            return Ok(());
        }
        match ch.git.flow.as_str() {
            "pr" => {
                let pr = self.ensure_pr_at(card, &ch.worktree, &ch.branch, &ch.merge_target, ch.pr.clone(), false).await?;
                if pr.draft {
                    github::pr_ready(&ch.worktree, &pr.number.to_string()).await?;
                }
                github::pr_merge(&ch.worktree, &pr.number.to_string(), &ch.git.merge_method)
                    .await
                    .map_err(|e| anyhow!("GitHub chưa cho merge PR #{}: {e:#}", pr.number))?;
                ch.pr = Some(PrInfo { state: "merged".into(), draft: false, ..pr });
                ch.shipped = Some("merged".into());
            }
            "push" => {
                self.merge_and_push(&ch.repo_path, &ch.worktree, &ch.branch, &ch.merge_target, message).await?;
                ch.shipped = Some("pushed".into());
            }
            _ => {
                self.local_merge(&ch.repo_path, &ch.branch, &ch.merge_target, message).await?;
                ch.shipped = Some("local".into());
            }
        }
        Ok(())
    }
}

/// "backend: đã merge và push vào develop · frontend: đã merge PR #12 vào main · docs: không đổi".
pub(super) fn ship_summary(children: &[ChildWt]) -> String {
    children
        .iter()
        .filter_map(|c| {
            let what = match c.shipped.as_deref()? {
                "merged" => match &c.pr {
                    Some(pr) => format!("đã merge PR #{} vào {}", pr.number, c.merge_target),
                    None => format!("đã merge vào {}", c.merge_target),
                },
                "pushed" => format!("đã merge và push vào {}", c.merge_target),
                "local" => format!("đã merge vào {} trên máy", c.merge_target),
                _ => "không có thay đổi".to_string(),
            };
            Some(format!("{}: {what}", c.name))
        })
        .collect::<Vec<_>>()
        .join(" · ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefixes_patch_paths() {
        let p = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-x\n+y\n";
        let out = prefix_patch(p, "frontend");
        assert!(out.starts_with("diff --git a/frontend/src/a.ts b/frontend/src/a.ts\n--- a/frontend/src/a.ts\n+++ b/frontend/src/a.ts\n"));
        assert!(out.ends_with("-x\n+y\n"));
        let added = "diff --git a/new.md b/new.md\n--- /dev/null\n+++ b/new.md\n";
        assert!(prefix_patch(added, "api").contains("--- /dev/null\n+++ b/api/new.md"));
    }
}
