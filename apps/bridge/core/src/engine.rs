//! Card engine: turns server commands into Orca worktrees and supervised agent workers,
//! and turns Orca's orchestration mailbox and worker observations back into card updates.
//!
//! The bridge is the Orca *coordinator* for each board: one coordinator terminal and one
//! orchestration Run per project. Each started card gets its own worktree and a worker
//! dispatched with `orca orchestration worker-start`.

use crate::context;
mod multi;

use crate::git;
use crate::github;
use crate::orca::{agent_terminal_from_receipt, output_lines, Orca, OrcaError};
use crate::paths::which;
use crate::protocol::*;
use crate::redact::redact_line;
use crate::store::Store;
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, Mutex};

use multi::{ChildRepo, ChildWt};

const RUN_STARTING: &str = "starting";
const RUN_RUNNING: &str = "running";
const RUN_WAITING: &str = "waiting";
const RUN_SUCCEEDED: &str = "succeeded";
const RUN_FAILED: &str = "failed";
const RUN_STOPPED: &str = "stopped";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ProjectRt {
    pub project_id: String,
    pub repo_path: String,
    pub orca_repo_id: String,
    pub base_ref: String,
    pub display_name: String,
    pub coord_handle: Option<String>,
    pub run_id: Option<String>,
    /// Multi-repo board: the git repos inside `repo_path` (which is not a repo itself).
    pub children: Vec<ChildRepo>,
    /// Multi-repo board: Localkan's private workspace repo that Orca manages.
    pub workspace: Option<String>,
}

impl ProjectRt {
    /// The folder Orca knows: the repo itself, or the workspace repo of a multi-repo board.
    fn orca_path(&self) -> String {
        self.workspace.clone().unwrap_or_else(|| self.repo_path.clone())
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PendingRetry {
    pub task_id: String,
    pub dispatch_id: String,
    pub terminal: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CardRt {
    pub card_id: String,
    pub project_id: String,
    pub title: String,
    pub agent: String,
    pub mode: String,
    pub worktree_path: Option<String>,
    pub branch: Option<String>,
    pub base_ref: String,
    pub task_id: Option<String>,
    pub dispatch_id: Option<String>,
    pub agent_terminal: Option<String>,
    pub read_cursor: Option<String>,
    /// The current dispatch is live and being polled.
    pub running: bool,
    /// The card still owns a worktree (not finished yet).
    pub active: bool,
    /// Startup blocked on an interactive prompt; retry this dispatch once the user answers.
    pub pending_retry: Option<PendingRetry>,
    /// "question" | "prompt" while the card is in the Human-in-the-loop column.
    pub waiting_kind: Option<String>,
    /// The board's git workflow when the card started (flow "pr": GitHub pull requests).
    pub git: GitSettings,
    /// The task's pull request (flow "pr").
    pub pr: Option<PrInfo>,
    /// Last follow-up request: the commit message of that round.
    pub last_request: Option<String>,
    /// The agent finished: commit, push and open/update the PR on the next tick.
    pub publish_pending: bool,
    /// Multi-repo board: one worktree per repo inside `worktree_path`.
    pub children: Vec<ChildWt>,
    pub log_seq: i64,
    /// Accumulated card state, re-sent to the server after a reconnect.
    pub last: CardStatePatch,
    /// Agent terminal launched ahead of the dispatch while it shows startup dialogs
    /// (folder trust, permission-mode warnings) that the human must answer first.
    pub startup_terminal: Option<String>,
    /// Task spec to dispatch once the agent in `startup_terminal` is ready.
    pub pending_spec: Option<String>,
    /// Branch that "merge" / "PR" target. Differs from `base_ref` (the diff base) when the
    /// card continues from another card's unmerged branch.
    pub merge_target: Option<String>,
}

pub struct Engine {
    orca: Option<Orca>,
    store: Store,
    out: mpsc::UnboundedSender<Outgoing>,
    projects: Mutex<HashMap<String, ProjectRt>>,
    cards: Mutex<HashMap<String, CardRt>>,
    coord_lock: Mutex<()>,
    ticks: AtomicU64,
    /// Per-card filters that strip TUI repaint noise from agent output.
    filters: std::sync::Mutex<HashMap<String, LogFilter>>,
    device_name: String,
    /// Dev/testing: run this command in a plain terminal instead of a real agent CLI.
    mock_cmd: Option<String>,
    /// Server base URL and device token, for downloading card images.
    server: Option<(String, String)>,
    /// Live previews (dev server + ngrok) and screenshots per card.
    previews: crate::preview::Previews,
    /// Cards whose PR is being published or refreshed right now.
    pr_busy: std::sync::Mutex<HashSet<String>>,
}

fn bad_params(e: serde_json::Error) -> BridgeError {
    BridgeError::new("bad_params", e.to_string())
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn s(v: &Value) -> Option<String> {
    v.as_str().filter(|x| !x.is_empty()).map(String::from)
}

impl Engine {
    pub fn new(
        orca: Option<Orca>,
        store: Store,
        out: mpsc::UnboundedSender<Outgoing>,
        device_name: String,
        mock_cmd: Option<String>,
        server: Option<(String, String)>,
    ) -> Self {
        let projects = store
            .all::<ProjectRt>("project")
            .unwrap_or_default()
            .into_iter()
            .map(|p| (p.project_id.clone(), p))
            .collect();
        let cards = store
            .all::<CardRt>("card")
            .unwrap_or_default()
            .into_iter()
            .map(|mut c| {
                // Dev servers and tunnels die with the previous bridge process.
                if matches!(c.last.preview, Some(Some(_))) {
                    c.last.preview = Some(None);
                }
                (c.card_id.clone(), c)
            })
            .collect();
        Self {
            orca,
            store,
            out,
            projects: Mutex::new(projects),
            cards: Mutex::new(cards),
            coord_lock: Mutex::new(()),
            ticks: AtomicU64::new(0),
            filters: std::sync::Mutex::new(HashMap::new()),
            device_name,
            mock_cmd,
            server,
            previews: crate::preview::Previews::new(crate::config::home_dir().join("previews")),
            pr_busy: std::sync::Mutex::new(HashSet::new()),
        }
    }

    fn orca(&self) -> Result<&Orca> {
        self.orca
            .as_ref()
            .ok_or_else(|| anyhow!("Không tìm thấy Orca trên máy này. Cài Orca (orca.app) hoặc đặt biến ORCA_BIN."))
    }

    pub async fn has_active_cards(&self) -> bool {
        self.cards.lock().await.values().any(|c| c.active)
    }

    // -- server-facing API ---------------------------------------------------

    pub async fn info(&self) -> BridgeInfo {
        let orca = match &self.orca {
            None => OrcaInfo { reachable: false, version: None, error: Some("chưa cài Orca".into()) },
            Some(o) => match o.ensure_runtime().await {
                Ok(v) => OrcaInfo { reachable: true, version: v, error: None },
                Err(e) => OrcaInfo { reachable: false, version: None, error: Some(e.message) },
            },
        };
        let mut agents = std::collections::BTreeMap::new();
        agents.insert("claude".to_string(), which("claude").is_some());
        agents.insert("antigravity".to_string(), which("agy").is_some());
        BridgeInfo { device_name: self.device_name.clone(), version: crate::VERSION.into(), orca, agents }
    }

    /// Re-send the last known state of every card and board preview (after a reconnect).
    pub async fn snapshot(&self) {
        let project_ids: Vec<String> = self.projects.lock().await.keys().cloned().collect();
        for id in project_ids {
            // None clears a stale "running" left over from a previous bridge process.
            self.emit_project_preview(&id, self.previews.info(&project_key(&id)).await);
        }
        let cards = self.cards.lock().await;
        // Finished cards are owned by the server now; re-sending their old state would
        // reopen them.
        for c in cards.values().filter(|c| c.active) {
            if c.last.run_state.is_some() || c.last.status.is_some() {
                self.send_event("card.state", serde_json::to_value(&c.last).unwrap_or_default());
            }
        }
    }

    pub async fn handle(self: &Arc<Self>, method: &str, params: Value) -> Result<Value, BridgeError> {
        let res = match method {
            "project.register" => {
                let p: ProjectRegister = serde_json::from_value(params).map_err(bad_params)?;
                self.register_project(&p.project_id, &p.repo_path).await
            }
            "card.start" => {
                let p: CardStart = serde_json::from_value(params).map_err(bad_params)?;
                self.start_card(p).await
            }
            "project.memory.get" => {
                let p: ProjectRef = serde_json::from_value(params).map_err(bad_params)?;
                let repo = git::expand_path(&p.repo_path);
                Ok(json!({ "content": context::read_memory(&repo), "path": context::memory_file(&repo) }))
            }
            "project.memory.set" => {
                let p: ProjectRef = serde_json::from_value(params).map_err(bad_params)?;
                let repo = git::expand_path(&p.repo_path);
                if !Path::new(&repo).is_dir() {
                    return Err(BridgeError::new("not_found", format!("Không thấy thư mục {repo} trên máy này.")));
                }
                context::write_memory(&repo, p.content.as_deref().unwrap_or("")).await.map(|_| json!({ "ok": true }))
            }
            "project.handoffs" => {
                let p: ProjectRef = serde_json::from_value(params).map_err(bad_params)?;
                Ok(json!({ "handoffs": context::list_handoffs(&git::expand_path(&p.repo_path)) }))
            }
            "fs.pickFolder" => {
                let p: FsPick = serde_json::from_value(params).map_err(bad_params)?;
                self.pick_folder(p).await
            }
            "fs.inspect" => {
                let p: FsInspect = serde_json::from_value(params).map_err(bad_params)?;
                Ok(serde_json::to_value(git::folder_info(&git::expand_path(&p.path)).await).unwrap_or_default())
            }
            "card.preview.start" => {
                let p: CardPreview = serde_json::from_value(params).map_err(bad_params)?;
                self.preview_start(p).await
            }
            "card.preview.stop" => {
                let p: CardRef = serde_json::from_value(params).map_err(bad_params)?;
                self.previews.stop(&p.card_id).await;
                self.emit_preview(&p.card_id, None).await;
                self.sys(&p.card_id, "Đã dừng xem trước.").await;
                Ok(json!({ "ok": true }))
            }
            "project.preview.start" => {
                let p: ProjectPreview = serde_json::from_value(params).map_err(bad_params)?;
                self.project_preview_start(p).await
            }
            "project.preview.stop" => {
                let p: ProjectPreview = serde_json::from_value(params).map_err(bad_params)?;
                self.previews.stop(&project_key(&p.project_id)).await;
                self.emit_project_preview(&p.project_id, None);
                Ok(json!({ "ok": true }))
            }
            "project.screenshot" => {
                let p: ProjectPreview = serde_json::from_value(params).map_err(bad_params)?;
                let repo = self.project_dir(&p).await?;
                let key = project_key(&p.project_id);
                let progress = self.project_progress(&p.project_id);
                let shots = self.previews.screenshots(&key, &repo, &repo, p.path.as_deref().unwrap_or("/"), &progress).await;
                self.emit_project_preview(&p.project_id, self.previews.info(&key).await);
                Ok(json!({ "shots": shots? }))
            }
            "browser.action" => {
                // Never echo the parse error: the params may hold a password.
                let p: BrowserReq = serde_json::from_value(params)
                    .map_err(|_| BridgeError { code: "bad_params".into(), message: "Lệnh trình duyệt không hợp lệ".into() })?;
                self.browser_action(p).await
            }
            "project.repo" => {
                let p: ProjectRef = serde_json::from_value(params).map_err(bad_params)?;
                match self.project(&p.project_id).await {
                    Some(pr) if !pr.children.is_empty() => Ok(self.multi_repo_info(&pr).await),
                    Some(pr) => Ok(json!(github::repo_info(&pr.repo_path, true).await)),
                    None => Ok(json!(github::repo_info(&git::expand_path(&p.repo_path), true).await)),
                }
            }
            "card.pr.refresh" => {
                let p: CardRef = serde_json::from_value(params).map_err(bad_params)?;
                self.pr_refresh(&p.card_id).await
            }
            "card.pr.sync" => {
                let p: CardRef = serde_json::from_value(params).map_err(bad_params)?;
                self.pr_sync(&p.card_id).await
            }
            "card.screenshot" => {
                let p: CardScreenshot = serde_json::from_value(params).map_err(bad_params)?;
                self.screenshot(p).await
            }
            "card.retry" => {
                let p: CardStart = serde_json::from_value(params).map_err(bad_params)?;
                self.retry_card(p).await
            }
            "card.reply" => {
                let p: CardReply = serde_json::from_value(params).map_err(bad_params)?;
                self.reply(p).await
            }
            "card.followup" => {
                let p: CardFollowup = serde_json::from_value(params).map_err(bad_params)?;
                self.followup(p).await
            }
            "card.diff" => {
                let p: CardRef = serde_json::from_value(params).map_err(bad_params)?;
                self.diff(&p.card_id).await
            }
            "card.screen" => {
                let p: CardRef = serde_json::from_value(params).map_err(bad_params)?;
                self.screen(&p.card_id).await
            }
            "card.log" => {
                let p: CardLog = serde_json::from_value(params).map_err(bad_params)?;
                let lines = self.store.logs_after(&p.card_id, p.after.unwrap_or(-1), 3000)?;
                Ok(json!({ "lines": lines }))
            }
            "card.stop" => {
                let p: CardRef = serde_json::from_value(params).map_err(bad_params)?;
                self.stop(&p.card_id).await
            }
            "card.focus" => {
                let p: CardRef = serde_json::from_value(params).map_err(bad_params)?;
                self.focus(&p.card_id).await
            }
            "card.finish" => {
                let p: CardFinish = serde_json::from_value(params).map_err(bad_params)?;
                self.finish(p).await
            }
            other => return Err(BridgeError::new("unknown_method", format!("Bridge không hỗ trợ {other}"))),
        };
        res.map_err(|e| {
            let code = e.downcast_ref::<OrcaError>().map(|o| o.code.clone()).unwrap_or_else(|| "bridge_error".into());
            BridgeError::new(&code, format!("{e:#}"))
        })
    }

    // -- projects ------------------------------------------------------------

    async fn project(&self, id: &str) -> Option<ProjectRt> {
        self.projects.lock().await.get(id).cloned()
    }

    async fn save_project(&self, p: ProjectRt) {
        let _ = self.store.put("project", &p.project_id, &p);
        self.projects.lock().await.insert(p.project_id.clone(), p);
    }

    async fn register_project(&self, project_id: &str, repo_path: &str) -> Result<Value> {
        let repo_path = git::expand_path(repo_path);
        let repo_path = repo_path.as_str();
        if !Path::new(repo_path).is_absolute() {
            bail!("Hãy dùng đường dẫn đầy đủ, ví dụ /Users/ban/code/du-an.");
        }
        let info = git::folder_info(repo_path).await;
        if !info.is_git_repo && !info.child_repos.is_empty() {
            // A folder holding several repos (frontend/, backend/…): a multi-repo board.
            let children = info
                .child_repos
                .iter()
                .map(|n| ChildRepo { name: n.clone(), path: Path::new(repo_path).join(n).to_string_lossy().into_owned() })
                .collect();
            return self.register_multi(project_id, repo_path, children).await;
        }
        let mut initialized = false;
        if !info.exists || (!info.is_git_repo && info.is_empty) {
            // A brand-new project folder: make it a repo with a first commit so worktrees
            // can branch off it.
            git::init(repo_path).await?;
            git::ensure_initial_commit(repo_path).await?;
            initialized = true;
        } else if !info.is_git_repo {
            bail!(
                "{repo_path} đã có file nhưng chưa phải repo git. Localkan chỉ tự git init cho thư mục trống. \
                 Hãy chạy: cd \"{repo_path}\" && git init && git add -A && git commit -m \"Initial commit\", rồi bấm Thử lại."
            );
        }
        let top = git::toplevel(repo_path).await?;
        let orca = self.orca()?;
        orca.ensure_runtime().await?;
        let repo_id = self.orca_repo_id(&top).await?;
        let base_ref = git::current_branch(&top).await.unwrap_or_else(|| "main".into());
        let display_name = Path::new(&top).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or(top.clone());
        let existing = self.project(project_id).await;
        let p = ProjectRt {
            project_id: project_id.into(),
            repo_path: top,
            orca_repo_id: repo_id,
            base_ref: base_ref.clone(),
            display_name: display_name.clone(),
            coord_handle: existing.as_ref().and_then(|e| e.coord_handle.clone()),
            run_id: existing.as_ref().and_then(|e| e.run_id.clone()),
            children: Vec::new(),
            workspace: None,
        };
        self.save_project(p).await;
        self.ensure_coordinator(project_id).await?;
        let repo = github::repo_info(&self.project(project_id).await.map(|p| p.repo_path).unwrap_or_default(), false).await;
        Ok(json!({ "baseRef": base_ref, "displayName": display_name, "initialized": initialized, "repo": repo }))
    }

    async fn orca_repo_id(&self, top: &str) -> Result<String> {
        let orca = self.orca()?;
        match orca.call(&["repo", "add", "--path", top]).await {
            Ok(r) => {
                if let Some(id) = s(&r["repo"]["id"]) {
                    return Ok(id);
                }
            }
            Err(e) => tracing::debug!("repo add: {e}"),
        }
        let list = orca.call(&["repo", "list"]).await?;
        let repos = list["repos"].as_array().or_else(|| list.as_array()).cloned().unwrap_or_default();
        let canon = std::fs::canonicalize(top).ok();
        repos
            .iter()
            .find(|r| {
                let p = r["path"].as_str().unwrap_or("");
                p == top || canon.as_ref().is_some_and(|c| std::fs::canonicalize(p).ok().as_ref() == Some(c))
            })
            .and_then(|r| s(&r["id"]))
            .ok_or_else(|| anyhow!("Orca không đăng ký được repo {top}"))
    }

    async fn terminal_alive(&self, handle: &str) -> bool {
        match self.orca().ok() {
            None => false,
            Some(o) => match o.call(&["terminal", "show", "--terminal", handle]).await {
                Ok(r) => !matches!(r["terminal"]["status"].as_str(), Some("exited" | "closed" | "dead")),
                Err(_) => false,
            },
        }
    }

    /// The project's coordinator terminal and Run, created or re-bound when needed.
    async fn ensure_coordinator(&self, project_id: &str) -> Result<(String, String)> {
        let _guard = self.coord_lock.lock().await;
        let mut p = self.project(project_id).await.ok_or_else(|| anyhow!("Bảng chưa được đăng ký trên bridge này."))?;
        if let (Some(h), Some(run)) = (&p.coord_handle, &p.run_id) {
            if self.terminal_alive(h).await {
                return Ok((h.clone(), run.clone()));
            }
        }
        let orca = self.orca()?;
        orca.ensure_runtime().await?;
        let t = orca
            .call(&["terminal", "create", "--worktree", &format!("path:{}", p.orca_path()), "--title", "localkan-coordinator"])
            .await?;
        let handle = s(&t["terminal"]["handle"]).ok_or_else(|| anyhow!("Orca không trả handle cho terminal điều phối"))?;
        let run = match &p.run_id {
            Some(run) => match orca.call(&["orchestration", "run-use", "--id", run, "--from", &handle]).await {
                Ok(_) => run.clone(),
                Err(e) => {
                    tracing::warn!("run-use failed ({e}); creating a new Run");
                    self.create_run(&p, &handle).await?
                }
            },
            None => self.create_run(&p, &handle).await?,
        };
        p.coord_handle = Some(handle.clone());
        p.run_id = Some(run.clone());
        self.save_project(p).await;
        Ok((handle, run))
    }

    async fn create_run(&self, p: &ProjectRt, handle: &str) -> Result<String> {
        let r = self
            .orca()?
            .call(&["orchestration", "run-create", "--objective", &format!("Localkan: {}", p.display_name), "--from", handle])
            .await?;
        s(&r["run"]["id"]).ok_or_else(|| anyhow!("Orca không trả id của Run"))
    }

    // -- cards ---------------------------------------------------------------

    async fn card(&self, id: &str) -> Result<CardRt> {
        self.cards.lock().await.get(id).cloned().ok_or_else(|| anyhow!("Bridge không có thông tin về thẻ này."))
    }

    async fn put_card(&self, c: CardRt) {
        let _ = self.store.put("card", &c.card_id, &c);
        self.cards.lock().await.insert(c.card_id.clone(), c);
    }

    /// Mutate one card under the lock and persist it.
    async fn update_card(&self, id: &str, f: impl FnOnce(&mut CardRt)) -> Option<CardRt> {
        let mut cards = self.cards.lock().await;
        let c = cards.get_mut(id)?;
        f(c);
        let _ = self.store.put("card", id, c);
        Some(c.clone())
    }

    fn send_event(&self, event: &str, data: Value) {
        let _ = self.out.send(Outgoing::Event { event: event.into(), data });
    }

    async fn emit(&self, patch: CardStatePatch) {
        let id = patch.card_id.clone();
        self.update_card(&id, |c| {
            c.last.card_id = id.clone();
            c.last.merge(&patch);
        })
        .await;
        self.send_event("card.state", serde_json::to_value(&patch).unwrap_or_default());
    }

    async fn log(&self, card_id: &str, source: &str, lines: Vec<String>) {
        let lines: Vec<String> = if source == "agent" {
            let mut filters = self.filters.lock().unwrap();
            let f = filters.entry(card_id.to_string()).or_default();
            lines.iter().filter_map(|l| f.accept(l)).collect()
        } else {
            lines
        };
        if lines.is_empty() {
            return;
        }
        let mut seq = match self.cards.lock().await.get(card_id) {
            Some(c) => c.log_seq,
            None => return,
        };
        let ts = now();
        let entries: Vec<LogLine> = lines
            .into_iter()
            .map(|t| {
                seq += 1;
                LogLine { seq, ts: ts.clone(), source: source.into(), text: redact_line(t.trim_end()) }
            })
            .collect();
        self.update_card(card_id, |c| c.log_seq = seq).await;
        let _ = self.store.append_logs(card_id, &entries);
        self.send_event("card.log", json!({ "cardId": card_id, "lines": entries }));
    }

    async fn sys(&self, card_id: &str, text: impl Into<String>) {
        self.log(card_id, "system", vec![format!("▸ {}", text.into())]).await;
    }

    async fn start_card(self: &Arc<Self>, p: CardStart) -> Result<Value> {
        if self.project(&p.project_id).await.is_none() {
            self.register_project(&p.project_id, &p.repo_path).await?;
        }
        let project = self.project(&p.project_id).await.unwrap();
        if !project.children.is_empty() {
            return self.start_multi(p, project).await;
        }
        self.ensure_coordinator(&p.project_id).await?;
        let orca = self.orca()?;
        let created_root = git::ensure_initial_commit(&project.repo_path).await?;
        // Name the base explicitly: Orca cannot infer a default base for repos without an
        // origin HEAD (fresh local repos).
        let base_ref = git::current_branch(&project.repo_path).await.unwrap_or(project.base_ref.clone());
        // PR flow: start from the base branch as it is on GitHub right now, so the PR does not
        // begin behind (or conflicting with) work merged since the last pull.
        let mut merge_target = base_ref.clone();
        let mut from = base_ref.clone();
        if p.git.from_origin() {
            let base = p.git.base_branch.clone().filter(|b| !b.is_empty()).unwrap_or(base_ref.clone());
            merge_target = base.clone();
            match github::fetch(&project.repo_path, &base).await {
                Ok(()) => from = format!("origin/{base}"),
                Err(e) => {
                    self.sys(&p.card_id, format!("Không lấy được origin/{base} ({e}); bắt đầu từ nhánh {base} trên máy.")).await;
                    from = base.clone();
                }
            }
        }
        let worktree_base = self.parent_base(&project.repo_path, &from, p.parent.as_ref()).await?;
        context::ensure_excluded(&project.repo_path).await;
        let wanted_branch = p.git.from_origin().then(|| github::task_branch(&p.git.branch_prefix, &p.card_id, &p.title));
        let name = match &wanted_branch {
            // Orca turns "/" into "-" in worktree names; the branch is renamed right after.
            Some(b) => b.replace('/', "-"),
            None => branch_name(&p.card_id, &p.title),
        };
        let wt = orca
            .call_timeout(
                &[
                    "worktree",
                    "create",
                    "--repo",
                    &format!("id:{}", project.orca_repo_id),
                    "--name",
                    &name,
                    "--base-branch",
                    &worktree_base,
                    "--no-parent",
                ],
                Duration::from_secs(300),
            )
            .await
            .context("không tạo được worktree")?;
        let w = &wt["worktree"];
        let path = s(&w["path"]).ok_or_else(|| anyhow!("Orca không trả đường dẫn worktree"))?;
        let mut branch = s(&w["branch"]).map(|b| b.trim_start_matches("refs/heads/").to_string());
        if let (Some(wanted), Some(current)) = (&wanted_branch, &branch) {
            if wanted != current {
                let mut target = wanted.clone();
                if git::branch_exists(&project.repo_path, &target).await {
                    target = format!("{wanted}-{}", &p.card_id.chars().filter(|c| c.is_ascii_alphanumeric()).skip(4).take(4).collect::<String>());
                }
                match git::run(&path, &["branch", "-m", &target]).await {
                    Ok(_) => branch = Some(target),
                    Err(e) => tracing::warn!("rename branch: {e:#}"),
                }
            }
        }
        let base = s(&w["baseRef"]).unwrap_or(worktree_base.clone());

        let log_seq = self.store.last_seq(&p.card_id);
        self.put_card(CardRt {
            card_id: p.card_id.clone(),
            project_id: p.project_id.clone(),
            title: p.title.clone(),
            agent: p.agent.clone(),
            mode: p.mode.clone(),
            worktree_path: Some(path.clone()),
            branch: branch.clone(),
            base_ref: base,
            merge_target: Some(merge_target.clone()),
            git: p.git.clone(),
            active: true,
            log_seq,
            ..Default::default()
        })
        .await;
        let mut patch = CardStatePatch::new(&p.card_id);
        patch.run_state = Some(RUN_STARTING.into());
        patch.status = Some("in_progress".into());
        patch.branch = Some(branch.clone());
        patch.worktree_path = Some(Some(path.clone()));
        patch.waiting = Some(None);
        patch.error = Some(None);
        patch.summary = Some(None);
        self.emit(patch).await;
        if created_root {
            self.sys(
                &p.card_id,
                format!("Repo chưa có commit nào: đã tạo commit rỗng \"Initial commit\" trên nhánh {base_ref} để làm gốc cho worktree."),
            )
            .await;
        }
        self.sys(&p.card_id, format!("Đã tạo worktree {path} (nhánh {})", branch.unwrap_or_default())).await;
        if worktree_base != base_ref {
            self.sys(&p.card_id, format!("Làm tiếp từ nhánh {worktree_base} của thẻ nền.")).await;
        }

        let images = self.fetch_attachments(&p.card_id, &path, &p.attachments).await;
        let ctx = context::compose_context(&project.repo_path, &p.card_id, p.parent.as_ref());
        if !ctx.is_empty() {
            self.sys(&p.card_id, "Đã đưa bộ nhớ dự án và ghi chú bàn giao vào nhiệm vụ.").await;
        }
        let spec = compose_spec(&p.title, &p.prompt, &p.mode, &images, &ctx);
        let me = self.clone();
        let card_id = p.card_id.clone();
        tokio::spawn(async move { me.dispatch(&card_id, spec, None, None).await });
        Ok(json!({ "accepted": true }))
    }

    /// Dispatch work to the card's agent; on failure, surface the error on the card.
    async fn dispatch(self: &Arc<Self>, card_id: &str, spec: String, terminal: Option<String>, retry: Option<PendingRetry>) {
        let mut res = self.try_dispatch(card_id, &spec, terminal.clone(), retry.clone()).await;
        if res.is_err() && terminal.is_some() && retry.is_none() {
            // The kept agent terminal could not take the follow-up; start a fresh agent instead.
            self.sys(card_id, "Terminal agent cũ không nhận việc, mở agent mới trong cùng worktree.").await;
            res = self.try_dispatch(card_id, &spec, None, None).await;
        }
        if let Err(e) = res {
            tracing::warn!(card_id, "dispatch failed: {e:#}");
            self.update_card(card_id, |c| {
                c.running = false;
                c.waiting_kind = None;
            })
            .await;
            self.sys(card_id, format!("Lỗi: {e:#}")).await;
            let mut patch = CardStatePatch::new(card_id);
            patch.run_state = Some(RUN_FAILED.into());
            patch.status = Some("review".into());
            patch.waiting = Some(None);
            patch.error = Some(Some(format!("{e:#}")));
            self.emit(patch).await;
        }
    }

    async fn try_dispatch(
        &self,
        card_id: &str,
        spec: &str,
        terminal: Option<String>,
        retry: Option<PendingRetry>,
    ) -> Result<()> {
        let card = self.card(card_id).await?;
        let (coord, _run) = self.ensure_coordinator(&card.project_id).await?;
        let wt = card.worktree_path.clone().ok_or_else(|| anyhow!("Thẻ chưa có worktree"))?;
        if let (Some(cmd), None) = (&self.mock_cmd, &retry) {
            return self.dispatch_mock(&card, cmd, spec, &coord, terminal).await;
        }
        if card.agent == "claude" && terminal.is_none() && retry.is_none() {
            // Claude can open startup dialogs (folder trust, bypass-permissions warning) whose
            // default answer is "No, exit". Orca would type the task into them and Claude
            // would quit, so launch Claude first, let the human answer any dialog, and
            // dispatch into that terminal once Claude is ready.
            return self.prelaunch_agent(&card, &wt, spec).await;
        }
        let wt_sel = format!("path:{wt}");
        let mut args: Vec<&str> = vec!["orchestration", "worker-start", "--worktree", &wt_sel, "--from", &coord];
        match &retry {
            Some(r) => args.extend(["--task", &r.task_id, "--retry-of", &r.dispatch_id, "--terminal", &r.terminal]),
            None => {
                args.extend(["--spec", spec, "--task-title", &card.title]);
                match &terminal {
                    Some(t) => args.extend(["--terminal", t.as_str()]),
                    None => args.extend(["--agent", &card.agent]),
                }
            }
        }
        let r = self.orca()?.call_timeout(&args, Duration::from_secs(300)).await?;
        let dispatch_id = s(&r["dispatchId"]);
        let task_id = s(&r["taskId"]);
        let agent_term = agent_terminal_from_receipt(&r).or(terminal.clone());

        let state = r["state"].as_str().unwrap_or("").to_string();
        let unverified = state != "ready" && state != "failed" && dispatch_id.is_some();
        if state == "ready" || unverified {
            if unverified {
                // Orca submitted the task but could not confirm the agent started its turn
                // (e.g. outcome_unknown). Not a failure: keep supervising; the dispatch
                // settles if the agent reports, and observation catches an exited agent.
                let note = s(&r["lastError"]).unwrap_or_default();
                self.sys(card_id, format!("Orca chưa xác nhận được agent đã bắt đầu ({state}); tiếp tục theo dõi. {note}")).await;
            }
            let d = dispatch_id.clone().ok_or_else(|| anyhow!("Orca không trả dispatch id"))?;
            self.update_card(card_id, |c| {
                c.dispatch_id = Some(d.clone());
                c.task_id = task_id.clone();
                if agent_term.is_some() {
                    c.agent_terminal = agent_term.clone();
                }
                c.read_cursor = None;
                c.running = true;
                c.pending_retry = None;
                c.waiting_kind = None;
            })
            .await;
            self.sys(card_id, format!("Agent {} đã nhận việc (dispatch {d}).", card.agent)).await;
            let mut patch = CardStatePatch::new(card_id);
            patch.run_state = Some(RUN_RUNNING.into());
            patch.status = Some("in_progress".into());
            patch.dispatch_id = Some(Some(d));
            patch.waiting = Some(None);
            patch.error = Some(None);
            self.emit(patch).await;
            return Ok(());
        }

        let last_error = s(&r["lastError"]).unwrap_or_else(|| "không rõ".into());
        let failed_stage = s(&r["failedStage"]).unwrap_or_default();
        if let (Some(t), Some(task), Some(disp)) = (agent_term.clone(), task_id, dispatch_id) {
            if failed_stage == "agent_readiness" {
                // The agent is up but parked on a prompt (e.g. "trust this folder?").
                // Let the human answer it, then retry the same task in that terminal.
                let screen = self.screen_of(&t).await;
                self.update_card(card_id, |c| {
                    c.agent_terminal = Some(t.clone());
                    c.pending_retry = Some(PendingRetry { task_id: task, dispatch_id: disp, terminal: t.clone() });
                    c.waiting_kind = Some("prompt".into());
                    c.running = false;
                })
                .await;
                self.sys(card_id, format!("Agent bị chặn khi khởi động: {last_error}")).await;
                let mut patch = CardStatePatch::new(card_id);
                patch.run_state = Some(RUN_WAITING.into());
                patch.status = Some("needs_input".into());
                patch.waiting = Some(Some(WaitingInfo {
                    kind: "prompt".into(),
                    text: format!("Agent cần bạn xác nhận trước khi bắt đầu ({last_error})."),
                    message_id: None,
                    screen,
                    ..Default::default()
                }));
                self.emit(patch).await;
                return Ok(());
            }
        }
        let stage = s(&r["stage"]).unwrap_or_default();
        bail!("Không giao được việc cho agent (state={state}, stage={stage}, failedStage={failed_stage}): {last_error}")
    }

    /// Testing path: a plain terminal running the mock agent, dispatched without Orca's
    /// agent detection (unsupervised dispatch + manual prompt delivery).
    async fn dispatch_mock(&self, card: &CardRt, cmd: &str, spec: &str, coord: &str, terminal: Option<String>) -> Result<()> {
        let orca = self.orca()?;
        let wt = card.worktree_path.clone().unwrap_or_default();
        let handle = match terminal {
            Some(t) => t,
            None => {
                let t = orca
                    .call(&["terminal", "create", "--worktree", &format!("path:{wt}"), "--title", "mock-agent"])
                    .await?;
                let h = s(&t["terminal"]["handle"]).ok_or_else(|| anyhow!("không tạo được terminal mock"))?;
                tokio::time::sleep(Duration::from_millis(1500)).await;
                orca.call(&["terminal", "send", "--terminal", &h, "--text", cmd, "--enter"]).await?;
                tokio::time::sleep(Duration::from_millis(1500)).await;
                h
            }
        };
        let task = orca
            .call(&["orchestration", "task-create", "--spec", spec, "--task-title", &card.title, "--from", coord])
            .await?;
        let task_id = s(&task["task"]["id"]).ok_or_else(|| anyhow!("không tạo được task"))?;
        let d = orca
            .call(&["orchestration", "dispatch", "--task", &task_id, "--to", &handle, "--from", coord, "--return-preamble"])
            .await?;
        let dispatch_id = s(&d["dispatch"]["id"]).ok_or_else(|| anyhow!("không dispatch được"))?;
        let preamble = s(&d["preamble"]).unwrap_or_default();
        orca.call(&["terminal", "send", "--terminal", &handle, "--text", &preamble, "--enter"]).await?;
        self.update_card(&card.card_id, |c| {
            c.dispatch_id = Some(dispatch_id.clone());
            c.task_id = Some(task_id.clone());
            c.agent_terminal = Some(handle.clone());
            c.read_cursor = None;
            c.running = true;
            c.waiting_kind = None;
        })
        .await;
        self.sys(&card.card_id, format!("Mock agent đã nhận việc (dispatch {dispatch_id}).")).await;
        let mut patch = CardStatePatch::new(&card.card_id);
        patch.run_state = Some(RUN_RUNNING.into());
        patch.status = Some("in_progress".into());
        patch.dispatch_id = Some(Some(dispatch_id));
        patch.waiting = Some(None);
        self.emit(patch).await;
        Ok(())
    }

    async fn reply(self: &Arc<Self>, p: CardReply) -> Result<Value> {
        let card = self.card(&p.card_id).await?;
        let orca = self.orca()?;

        if let Some(mid) = p.message_id.filter(|m| !m.is_empty()) {
            let text = p.text.unwrap_or_default();
            if text.trim().is_empty() {
                bail!("Câu trả lời đang trống.");
            }
            if let Err(e) = orca.call(&["orchestration", "reply", "--id", &mid, "--body", &text]).await {
                let coord = self.project(&card.project_id).await.and_then(|p| p.coord_handle).unwrap_or_default();
                orca.call(&["orchestration", "reply", "--id", &mid, "--body", &text, "--from", &coord])
                    .await
                    .map_err(|e2| anyhow!("{e}; {e2}"))?;
            }
            self.update_card(&card.card_id, |c| c.waiting_kind = None).await;
            self.sys(&card.card_id, format!("Bạn trả lời: {text}")).await;
            let mut patch = CardStatePatch::new(&card.card_id);
            patch.run_state = Some(RUN_RUNNING.into());
            patch.status = Some("in_progress".into());
            patch.waiting = Some(None);
            self.emit(patch).await;
            return Ok(json!({ "ok": true }));
        }

        if let Some(st) = card.startup_terminal.clone() {
            if let Some(text) = p.text.clone().filter(|t| !t.is_empty()) {
                orca.call(&["terminal", "send", "--terminal", &st, "--text", &text, "--enter"]).await?;
            }
            for key in p.keys.clone().unwrap_or_default() {
                self.send_key(&st, &key).await?;
            }
            self.update_card(&card.card_id, |c| c.waiting_kind = None).await;
            let mut patch = CardStatePatch::new(&card.card_id);
            patch.run_state = Some(RUN_STARTING.into());
            patch.status = Some("in_progress".into());
            patch.waiting = Some(None);
            self.emit(patch).await;
            let me = self.clone();
            let id = card.card_id.clone();
            tokio::spawn(async move { me.continue_startup(&id).await });
            return Ok(json!({ "ok": true }));
        }

        let term = card
            .pending_retry
            .as_ref()
            .map(|r| r.terminal.clone())
            .or(card.agent_terminal.clone())
            .ok_or_else(|| anyhow!("Thẻ chưa có terminal agent."))?;
        if let Some(text) = p.text.filter(|t| !t.is_empty()) {
            orca.call(&["terminal", "send", "--terminal", &term, "--text", &text, "--enter"]).await?;
            self.sys(&card.card_id, format!("Bạn gõ vào terminal: {text}")).await;
        }
        for key in p.keys.unwrap_or_default() {
            self.send_key(&term, &key).await?;
        }

        if let Some(retry) = card.pending_retry.clone() {
            let mut patch = CardStatePatch::new(&card.card_id);
            patch.run_state = Some(RUN_STARTING.into());
            patch.status = Some("in_progress".into());
            patch.waiting = Some(None);
            self.emit(patch).await;
            let me = self.clone();
            let id = card.card_id.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(3)).await;
                me.sys(&id, "Thử giao việc lại cho agent…").await;
                me.dispatch(&id, String::new(), None, Some(retry)).await;
            });
        } else if card.waiting_kind.as_deref() == Some("prompt") {
            // Optimistically clear; the next observation re-raises it if the agent still waits.
            self.update_card(&card.card_id, |c| c.waiting_kind = None).await;
            let mut patch = CardStatePatch::new(&card.card_id);
            patch.run_state = Some(RUN_RUNNING.into());
            patch.status = Some("in_progress".into());
            patch.waiting = Some(None);
            self.emit(patch).await;
        }
        Ok(json!({ "ok": true }))
    }

    async fn send_key(&self, term: &str, key: &str) -> Result<()> {
        let orca = self.orca()?;
        let text = match key {
            "approve" | "reject" => return self.choose_option(term, key == "approve").await,
            "enter" => {
                orca.call(&["terminal", "send", "--terminal", term, "--enter"]).await?;
                return Ok(());
            }
            "interrupt" => {
                orca.call(&["terminal", "send", "--terminal", term, "--interrupt"]).await?;
                return Ok(());
            }
            "esc" => "\u{1b}",
            "up" => "\u{1b}[A",
            "down" => "\u{1b}[B",
            "tab" => "\t",
            other => bail!("Phím không hỗ trợ: {other}"),
        };
        orca.call(&["terminal", "send", "--terminal", term, "--text", text]).await?;
        Ok(())
    }

    /// Where a new card's worktree starts: the parent card's branch when it has work that is
    /// not in the base branch yet, otherwise the base branch itself.
    async fn parent_base(&self, repo: &str, base_ref: &str, parent: Option<&ParentRef>) -> Result<String> {
        let Some(parent) = parent else { return Ok(base_ref.to_string()) };
        let Some(branch) = parent.branch.as_deref().filter(|b| !b.is_empty()) else { return Ok(base_ref.to_string()) };
        if !git::branch_exists(repo, branch).await || git::is_ancestor(repo, branch, base_ref).await {
            // Merged (or discarded): its code is already in the base branch, or gone.
            return Ok(base_ref.to_string());
        }
        // Uncommitted edits of a parent still in review are not on its branch yet.
        let parent_rt = self.cards.lock().await.get(&parent.card_id).cloned();
        if let Some(prt) = parent_rt.filter(|c| c.active) {
            if let Some(pw) = prt.worktree_path.filter(|w| Path::new(w).exists()) {
                if git::has_changes(&pw).await.unwrap_or(false) {
                    bail!(
                        "Thẻ nền \"{}\" còn thay đổi chưa commit nên thẻ này chưa thấy được. Hãy Hoàn tất thẻ đó (Commit vào nhánh) trước, rồi giao lại thẻ này.",
                        parent.title
                    );
                }
            }
        }
        Ok(branch.to_string())
    }

    /// Remote control of the shared browser from the web app. Mutating actions return a fresh
    /// screenshot so the UI updates in one round trip.
    async fn browser_action(&self, p: BrowserReq) -> Result<Value> {
        use crate::browser;
        let orca = self.orca()?;
        let repo = match self.project(&p.project_id).await {
            Some(pr) => pr.repo_path,
            None => git::expand_path(&p.repo_path),
        };
        let shot_of = |page: String| async move { browser::shot(orca, &page).await };
        let res = match p.action {
            BrowserAction::Tabs => json!({ "tabs": self.board_tabs(&p.project_id, &repo).await? }),
            BrowserAction::Open { url } => {
                let main = (!repo.is_empty() && Path::new(&repo).is_dir()).then_some(repo.as_str());
                let page = browser::open(orca, &url, main).await?;
                json!({ "tabs": self.board_tabs(&p.project_id, &repo).await?, "shot": shot_of(page).await? })
            }
            BrowserAction::Shot { page_id } => json!({ "shot": shot_of(page_id).await? }),
            BrowserAction::Goto { page_id, url } => {
                browser::goto(orca, &page_id, &url).await?;
                json!({ "shot": shot_of(page_id).await? })
            }
            BrowserAction::Tap { page_id, x, y } => {
                browser::tap(orca, &page_id, x, y).await?;
                json!({ "shot": shot_of(page_id).await? })
            }
            BrowserAction::Type { page_id, text } => {
                browser::type_text(orca, &page_id, &text).await?;
                tokio::time::sleep(Duration::from_millis(200)).await;
                json!({ "shot": shot_of(page_id).await? })
            }
            BrowserAction::Key { page_id, key } => {
                browser::key(orca, &page_id, &key).await?;
                json!({ "shot": shot_of(page_id).await? })
            }
            BrowserAction::Scroll { page_id, dy } => {
                browser::scroll(orca, &page_id, dy).await?;
                json!({ "shot": shot_of(page_id).await? })
            }
            BrowserAction::Back { page_id } => {
                browser::back(orca, &page_id).await?;
                json!({ "shot": shot_of(page_id).await? })
            }
            BrowserAction::Reload { page_id } => {
                browser::reload(orca, &page_id).await?;
                json!({ "shot": shot_of(page_id).await? })
            }
            BrowserAction::Close { page_id } => {
                browser::close(orca, &page_id).await?;
                json!({ "tabs": self.board_tabs(&p.project_id, &repo).await?, "shot": null })
            }
            BrowserAction::Login { page_id, username, password, otp } => {
                let msg = browser::login(orca, &page_id, username.as_deref(), password.as_deref(), otp.as_deref()).await?;
                json!({ "shot": shot_of(page_id).await?, "message": msg })
            }
        };
        Ok(res)
    }

    /// Tabs this board may show: shared tabs, the main folder's, and its cards' worktrees.
    async fn board_tabs(&self, project_id: &str, repo: &str) -> Result<Vec<BrowserTab>> {
        let cards: Vec<(String, String)> = self
            .cards
            .lock()
            .await
            .values()
            .filter(|c| c.project_id == project_id)
            .filter_map(|c| Some((c.card_id.clone(), c.worktree_path.clone()?)))
            .collect();
        let same = |a: &str, b: &str| a.trim_end_matches('/') == b.trim_end_matches('/')
            || a.trim_start_matches("/private").trim_end_matches('/') == b.trim_start_matches("/private").trim_end_matches('/');
        let tabs = crate::browser::raw_tabs(self.orca()?).await?;
        Ok(tabs
            .into_iter()
            .filter_map(|t| match t.worktree_path.clone() {
                None => Some(t.into_tab(None, false)),
                Some(w) if !repo.is_empty() && same(&w, repo) => Some(t.into_tab(None, true)),
                Some(w) => {
                    let card = cards.iter().find(|(_, wt)| same(&w, wt)).map(|(id, _)| id.clone())?;
                    Some(t.into_tab(Some(card), false))
                }
            })
            .collect())
    }

    /// The agent asked for a sign-in (`[LOGIN] <url> …`): park the card on a login wait that
    /// points at the agent's tab, so the human can sign in remotely and then answer.
    async fn ask_login(&self, card: &CardRt, rest: &str, message_id: Option<String>) {
        let url = rest
            .split_whitespace()
            .find(|w| w.starts_with("http://") || w.starts_with("https://"))
            .map(|u| u.trim_end_matches(|c: char| matches!(c, ',' | '.' | ')' | '"' | '\'' | ';')).to_string());
        let page = self.login_page(card, url.as_deref()).await;
        let text = if rest.is_empty() { "Agent cần bạn đăng nhập.".to_string() } else { redact_line(rest) };
        self.update_card(&card.card_id, |c| c.waiting_kind = Some("login".into())).await;
        self.sys(&card.card_id, format!("Agent cần đăng nhập: {}", text.replace('\n', " "))).await;
        let mut patch = CardStatePatch::new(&card.card_id);
        patch.run_state = Some(RUN_WAITING.into());
        patch.status = Some("needs_input".into());
        patch.waiting = Some(Some(WaitingInfo {
            kind: "login".into(),
            text,
            message_id,
            page_id: page,
            url,
            ..Default::default()
        }));
        self.emit(patch).await;
    }

    /// The agent's tab for that page (same origin first, then its active tab); opens one in the
    /// card's worktree when the agent has none.
    async fn login_page(&self, card: &CardRt, url: Option<&str>) -> Option<String> {
        let orca = self.orca().ok()?;
        let wt = card.worktree_path.as_deref()?;
        let tabs = crate::browser::tabs_of(orca, wt).await.ok().unwrap_or_default();
        let origin = |u: &str| u.splitn(4, '/').take(3).collect::<Vec<_>>().join("/");
        if let Some(u) = url {
            if let Some(t) = tabs.iter().find(|t| origin(&t.url) == origin(u)) {
                return Some(t.page_id.clone());
            }
        }
        if let Some(t) = tabs.first() {
            return Some(t.page_id.clone());
        }
        crate::browser::open(orca, url?, Some(wt)).await.ok()
    }

    fn emit_project_preview(&self, project_id: &str, info: Option<crate::preview::PreviewInfo>) {
        self.send_event("project.preview", json!({ "projectId": project_id, "preview": info }));
    }

    fn project_progress(&self, project_id: &str) -> impl Fn(String) + Sync + use<> {
        let out = self.out.clone();
        let project_id = project_id.to_string();
        move |msg: String| {
            let info = crate::preview::PreviewInfo {
                status: "starting".into(),
                local_url: None,
                url: None,
                username: None,
                password: None,
                command: None,
                message: Some(msg),
                started_at: None,
            };
            let _ = out.send(Outgoing::Event {
                event: "project.preview".into(),
                data: json!({ "projectId": project_id, "preview": info }),
            });
        }
    }

    /// The project folder on this machine (registered path, or the one the server sent).
    async fn project_dir(&self, p: &ProjectPreview) -> Result<String> {
        let repo = match self.project(&p.project_id).await {
            Some(pr) if !pr.children.is_empty() => {
                let names: Vec<(&str, &str)> = pr.children.iter().map(|c| (c.name.as_str(), c.path.as_str())).collect();
                let i = multi::pick_app(&names).ok_or_else(|| anyhow!("Không thấy repo nào có script dev hoặc start để xem trước."))?;
                pr.children[i].path.clone()
            }
            Some(pr) => pr.repo_path,
            None => git::expand_path(&p.repo_path),
        };
        if repo.is_empty() || !Path::new(&repo).is_dir() {
            bail!("Không thấy thư mục dự án trên máy này.");
        }
        Ok(repo)
    }

    async fn project_preview_start(&self, p: ProjectPreview) -> Result<Value> {
        let repo = self.project_dir(&p).await?;
        let key = project_key(&p.project_id);
        let progress = self.project_progress(&p.project_id);
        progress("Đang chuẩn bị xem trước thư mục dự án…".into());
        match self.previews.start(&key, &repo, &repo, p.tunnel, &progress).await {
            Ok(info) => {
                self.emit_project_preview(&p.project_id, Some(info.clone()));
                Ok(serde_json::to_value(info)?)
            }
            Err(e) => {
                self.emit_project_preview(
                    &p.project_id,
                    Some(crate::preview::PreviewInfo {
                        status: "error".into(),
                        local_url: None,
                        url: None,
                        username: None,
                        password: None,
                        command: None,
                        message: Some(format!("{e:#}")),
                        started_at: None,
                    }),
                );
                Err(e)
            }
        }
    }

    async fn emit_preview(&self, card_id: &str, info: Option<crate::preview::PreviewInfo>) {
        let mut patch = CardStatePatch::new(card_id);
        patch.preview = Some(info);
        self.emit(patch).await;
    }

    /// A progress callback that shows live steps on the card while a preview starts.
    fn preview_progress(&self, card_id: &str) -> impl Fn(String) + Sync + use<> {
        let out = self.out.clone();
        let card_id = card_id.to_string();
        move |msg: String| {
            let mut patch = CardStatePatch::new(&card_id);
            patch.preview = Some(Some(crate::preview::PreviewInfo {
                status: "starting".into(),
                local_url: None,
                url: None,
                username: None,
                password: None,
                command: None,
                message: Some(msg),
                started_at: None,
            }));
            let _ = out.send(Outgoing::Event { event: "card.state".into(), data: serde_json::to_value(&patch).unwrap_or_default() });
        }
    }

    async fn card_paths(&self, card_id: &str) -> Result<(String, String)> {
        let card = self.card(card_id).await?;
        if !card.children.is_empty() {
            // Multi-repo task: preview the app repo (one with a dev/start script).
            let dirs: Vec<&ChildWt> = card.children.iter().filter(|c| Path::new(&c.worktree).exists()).collect();
            let names: Vec<(&str, &str)> = dirs.iter().map(|c| (c.name.as_str(), c.worktree.as_str())).collect();
            let i = multi::pick_app(&names).ok_or_else(|| anyhow!("Không thấy repo nào có script dev hoặc start để xem trước."))?;
            return Ok((dirs[i].repo_path.clone(), dirs[i].worktree.clone()));
        }
        let wt = card.worktree_path.clone().filter(|w| Path::new(w).exists()).ok_or_else(|| anyhow!("Thẻ không còn worktree để xem trước."))?;
        let repo = self.project(&card.project_id).await.map(|p| p.repo_path).ok_or_else(|| anyhow!("Không tìm thấy bảng"))?;
        Ok((repo, wt))
    }

    async fn preview_start(&self, p: CardPreview) -> Result<Value> {
        let (repo, wt) = self.card_paths(&p.card_id).await?;
        let progress = self.preview_progress(&p.card_id);
        progress("Đang chuẩn bị xem trước…".into());
        match self.previews.start(&p.card_id, &repo, &wt, p.tunnel, &progress).await {
            Ok(info) => {
                self.sys(
                    &p.card_id,
                    match &info.url {
                        Some(u) => format!("Xem trước đang chạy: {u} (local {})", info.local_url.clone().unwrap_or_default()),
                        None => format!("Xem trước đang chạy trên máy: {}", info.local_url.clone().unwrap_or_default()),
                    },
                )
                .await;
                self.emit_preview(&p.card_id, Some(info.clone())).await;
                Ok(serde_json::to_value(info)?)
            }
            Err(e) => {
                let info = crate::preview::PreviewInfo {
                    status: "error".into(),
                    local_url: None,
                    url: None,
                    username: None,
                    password: None,
                    command: None,
                    message: Some(format!("{e:#}")),
                    started_at: None,
                };
                self.emit_preview(&p.card_id, Some(info)).await;
                Err(e)
            }
        }
    }

    async fn screenshot(&self, p: CardScreenshot) -> Result<Value> {
        let (repo, wt) = self.card_paths(&p.card_id).await?;
        let progress = self.preview_progress(&p.card_id);
        let shots = self.previews.screenshots(&p.card_id, &repo, &wt, p.path.as_deref().unwrap_or("/"), &progress).await;
        // The dev server keeps running after a screenshot; report its state on the card.
        let info = self.previews.info(&p.card_id).await;
        self.emit_preview(&p.card_id, info).await;
        Ok(json!({ "shots": shots? }))
    }

    /// Download the card's images into `<worktree>/.localkan/attachments/` (git-ignored for
    /// this repo) and return their worktree-relative paths for the task spec.
    async fn fetch_attachments(&self, card_id: &str, wt: &str, list: &[AttachmentRef]) -> Vec<String> {
        if list.is_empty() {
            return Vec::new();
        }
        let Some((server, token)) = &self.server else {
            self.sys(card_id, "Không tải được ảnh: bridge không biết địa chỉ server.").await;
            return Vec::new();
        };
        let dir = Path::new(wt).join(".localkan").join("attachments");
        if let Err(e) = std::fs::create_dir_all(&dir) {
            self.sys(card_id, format!("Không tạo được thư mục ảnh: {e}")).await;
            return Vec::new();
        }
        if let Err(e) = git::exclude_locally(wt, ".localkan/attachments/").await {
            tracing::warn!("exclude attachments: {e:#}");
        }
        let client = reqwest::Client::new();
        let mut files = Vec::new();
        for (i, a) in list.iter().enumerate() {
            let file = format!("{:02}-{}", i + 1, attachment_file_name(&a.name, &a.mime));
            let url = format!("{}/api/bridge/attachments/{}", server.trim_end_matches('/'), a.id);
            let res = async {
                let r = client.get(&url).bearer_auth(token).send().await?.error_for_status()?;
                r.bytes().await
            }
            .await;
            match res {
                Ok(bytes) => match std::fs::write(dir.join(&file), &bytes) {
                    Ok(()) => files.push(format!(".localkan/attachments/{file}")),
                    Err(e) => self.sys(card_id, format!("Không lưu được ảnh {}: {e}", a.name)).await,
                },
                Err(e) => self.sys(card_id, format!("Không tải được ảnh {}: {e}", a.name)).await,
            }
        }
        if !files.is_empty() {
            self.sys(card_id, format!("Đã chép {} ảnh vào .localkan/attachments/ cho agent.", files.len())).await;
        }
        files
    }

    /// Native "choose folder" dialog on this machine (macOS).
    async fn pick_folder(&self, p: FsPick) -> Result<Value> {
        if !cfg!(target_os = "macos") {
            bail!("Hộp chọn thư mục hiện chỉ hỗ trợ macOS. Hãy nhập đường dẫn.");
        }
        let esc = |v: &str| v.replace('\\', "\\\\").replace('"', "\\\"");
        let prompt = p.prompt.unwrap_or_else(|| "Chọn thư mục".into());
        let start = p
            .start_path
            .map(|s| git::expand_path(&s))
            .filter(|s| Path::new(s).is_dir())
            .unwrap_or_else(|| crate::paths::home().to_string_lossy().into_owned());
        let script = format!(
            "POSIX path of (choose folder with prompt \"{}\" default location (POSIX file \"{}\"))",
            esc(&prompt),
            esc(&start)
        );
        // `activate` brings the dialog in front of other windows.
        let out = crate::paths::command("osascript").args(["-e", "activate", "-e", &script]).output().await?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            if err.contains("-128") || err.to_lowercase().contains("cancel") {
                return Ok(json!({ "path": null, "info": null }));
            }
            bail!("Không mở được hộp chọn thư mục: {}", err.trim());
        }
        let mut path = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if path.len() > 1 {
            path = path.trim_end_matches('/').to_string();
        }
        let info = git::folder_info(&path).await;
        Ok(json!({ "path": path, "info": info }))
    }

    async fn prelaunch_agent(&self, card: &CardRt, wt: &str, spec: &str) -> Result<()> {
        let orca = self.orca()?;
        let title = format!("{} · {}", card.agent, card.title);
        let t = orca
            .call(&["terminal", "create", "--worktree", &format!("path:{wt}"), "--title", &title, "--command", &card.agent])
            .await
            .context("không mở được terminal cho agent")?;
        let h = s(&t["terminal"]["handle"]).ok_or_else(|| anyhow!("Orca không trả handle terminal"))?;
        self.update_card(&card.card_id, |c| {
            c.startup_terminal = Some(h.clone());
            c.agent_terminal = Some(h.clone());
            c.pending_spec = Some(spec.to_string());
        })
        .await;
        self.sys(&card.card_id, format!("Đã mở {} trong worktree; chờ agent sẵn sàng.", card.agent)).await;
        self.advance_startup(&card.card_id).await
    }

    /// Watch the pre-launched agent until it is ready (then dispatch into it), parks on a
    /// dialog (surface it to the human), or exits (fail the card).
    async fn advance_startup(&self, card_id: &str) -> Result<()> {
        let card = self.card(card_id).await?;
        let Some(h) = card.startup_terminal.clone() else { return Ok(()) };
        let started = std::time::Instant::now();
        loop {
            let lines = self.screen_of(&h).await.unwrap_or_default();
            match classify_startup(&lines) {
                Startup::Ready => {
                    let spec = card.pending_spec.clone().unwrap_or_else(|| compose_spec(&card.title, "", &card.mode, &[], ""));
                    self.update_card(card_id, |c| {
                        c.startup_terminal = None;
                        c.pending_spec = None;
                        c.waiting_kind = None;
                    })
                    .await;
                    // Boxed: try_dispatch -> prelaunch_agent -> advance_startup -> try_dispatch.
                    return Box::pin(self.try_dispatch(card_id, &spec, Some(h), None)).await;
                }
                Startup::Dialog => {
                    self.update_card(card_id, |c| {
                        c.waiting_kind = Some("prompt".into());
                        c.running = false;
                    })
                    .await;
                    self.sys(card_id, "Agent hiện hộp hỏi khi khởi động; chờ bạn trả lời.").await;
                    let mut patch = CardStatePatch::new(card_id);
                    patch.run_state = Some(RUN_WAITING.into());
                    patch.status = Some("needs_input".into());
                    patch.waiting = Some(Some(WaitingInfo {
                        kind: "prompt".into(),
                        text: "Agent hỏi trước khi bắt đầu. Đọc kỹ nội dung trên màn hình rồi chọn Đồng ý hoặc Từ chối; Localkan giao việc ngay khi agent sẵn sàng.".into(),
                        message_id: None,
                        screen: Some(lines),
                        ..Default::default()
                    }));
                    self.emit(patch).await;
                    return Ok(());
                }
                Startup::Exited => {
                    self.update_card(card_id, |c| {
                        c.startup_terminal = None;
                        c.waiting_kind = None;
                    })
                    .await;
                    let _ = self.orca()?.call(&["terminal", "close", "--terminal", &h]).await;
                    bail!("Agent đã thoát trước khi nhận việc (thường do chọn \"No\" ở hộp hỏi khởi động). Bấm \"Chạy lại từ đầu\" để được hỏi lại.");
                }
                Startup::Unknown if started.elapsed() > Duration::from_secs(45) => {
                    bail!("Agent chưa sẵn sàng sau 45 giây. Mở tab Terminal để xem nó đang chờ gì.");
                }
                Startup::Unknown => tokio::time::sleep(Duration::from_secs(1)).await,
            }
        }
    }

    /// After the human answered a startup dialog: keep going, surfacing errors on the card.
    async fn continue_startup(self: &Arc<Self>, card_id: &str) {
        tokio::time::sleep(Duration::from_millis(2500)).await;
        if let Err(e) = self.advance_startup(card_id).await {
            self.update_card(card_id, |c| {
                c.running = false;
                c.waiting_kind = None;
            })
            .await;
            self.sys(card_id, format!("Lỗi: {e:#}")).await;
            let mut patch = CardStatePatch::new(card_id);
            patch.run_state = Some(RUN_FAILED.into());
            patch.status = Some("review".into());
            patch.waiting = Some(None);
            patch.error = Some(Some(format!("{e:#}")));
            self.emit(patch).await;
        }
    }

    /// Pick the "yes"/"no" option of the selection prompt on the agent's screen by moving the
    /// highlight with arrow keys, then confirm. Falls back to Enter / Esc.
    async fn choose_option(&self, term: &str, approve: bool) -> Result<()> {
        let lines = self.screen_of(term).await.unwrap_or_default();
        let plan = plan_choice(&lines, approve);
        let orca = self.orca()?;
        match plan {
            Some(delta) => {
                let key = if delta > 0 { "\u{1b}[B" } else { "\u{1b}[A" };
                for _ in 0..delta.unsigned_abs() {
                    orca.call(&["terminal", "send", "--terminal", term, "--text", key]).await?;
                    tokio::time::sleep(Duration::from_millis(120)).await;
                }
                orca.call(&["terminal", "send", "--terminal", term, "--enter"]).await?;
            }
            None if approve => {
                orca.call(&["terminal", "send", "--terminal", term, "--enter"]).await?;
            }
            None => {
                orca.call(&["terminal", "send", "--terminal", term, "--text", "\u{1b}"]).await?;
            }
        }
        Ok(())
    }

    async fn retry_card(self: &Arc<Self>, p: CardStart) -> Result<Value> {
        let existing = self.cards.lock().await.get(&p.card_id).cloned();
        let usable = existing
            .as_ref()
            .is_some_and(|c| c.active && c.worktree_path.as_deref().is_some_and(|w| Path::new(w).exists()));
        if !usable {
            return self.start_card(p).await;
        }
        let card = existing.unwrap();
        if card.running {
            if let Some(d) = &card.dispatch_id {
                let _ = self.orca()?.call(&["orchestration", "worker-stop", "--dispatch", d]).await;
            }
        }
        if let Some(t) = &card.startup_terminal {
            let _ = self.orca()?.call(&["terminal", "close", "--terminal", t]).await;
        }
        self.update_card(&card.card_id, |c| {
            c.running = false;
            c.read_cursor = None;
            c.waiting_kind = None;
            c.pending_retry = None;
            c.startup_terminal = None;
            c.pending_spec = None;
            c.agent = p.agent.clone();
            c.mode = p.mode.clone();
            c.title = p.title.clone();
        })
        .await;
        self.sys(&card.card_id, "Chạy lại nhiệm vụ từ đầu với agent mới trong cùng worktree.").await;
        let mut patch = CardStatePatch::new(&card.card_id);
        patch.run_state = Some(RUN_STARTING.into());
        patch.status = Some("in_progress".into());
        patch.waiting = Some(None);
        patch.error = Some(None);
        patch.summary = Some(None);
        self.emit(patch).await;
        let wt = card.worktree_path.clone().unwrap_or_default();
        let images = self.fetch_attachments(&card.card_id, &wt, &p.attachments).await;
        let repo = self.project(&card.project_id).await.map(|pr| pr.repo_path).unwrap_or_default();
        let ctx = if repo.is_empty() { String::new() } else { context::compose_context(&repo, &card.card_id, p.parent.as_ref()) };
        let prompt = if card.children.is_empty() { p.prompt.clone() } else { multi::with_layout(&p.prompt, &card.children) };
        let spec = compose_spec(&p.title, &prompt, &p.mode, &images, &ctx);
        let me = self.clone();
        let id = card.card_id.clone();
        tokio::spawn(async move { me.dispatch(&id, spec, None, None).await });
        Ok(json!({ "accepted": true }))
    }

    async fn followup(self: &Arc<Self>, p: CardFollowup) -> Result<Value> {
        let card = self.card(&p.card_id).await?;
        if card.worktree_path.is_none() || !card.active {
            bail!("Thẻ không còn worktree để làm tiếp.");
        }
        let terminal = match &card.agent_terminal {
            Some(t) if self.terminal_alive(t).await => Some(t.clone()),
            _ => None,
        };
        self.update_card(&card.card_id, |c| {
            c.running = false;
            c.read_cursor = None;
            c.waiting_kind = None;
            c.pending_retry = None;
            c.last_request = Some(p.text.clone());
        })
        .await;
        self.sys(&card.card_id, "Gửi yêu cầu sửa cho agent.").await;
        let mut patch = CardStatePatch::new(&card.card_id);
        patch.run_state = Some(RUN_STARTING.into());
        patch.status = Some("in_progress".into());
        patch.waiting = Some(None);
        patch.error = Some(None);
        patch.summary = Some(None);
        self.emit(patch).await;
        let spec = compose_followup(&card.title, &p.text, &card.mode);
        let me = self.clone();
        let id = card.card_id.clone();
        tokio::spawn(async move { me.dispatch(&id, spec, terminal, None).await });
        Ok(json!({ "accepted": true }))
    }

    async fn diff(&self, card_id: &str) -> Result<Value> {
        let card = self.card(card_id).await?;
        if !card.children.is_empty() {
            return Ok(serde_json::to_value(self.multi_diff(&card).await?)?);
        }
        let wt = card.worktree_path.clone().ok_or_else(|| anyhow!("Thẻ chưa có worktree"))?;
        if Path::new(&wt).exists() {
            return Ok(serde_json::to_value(git::diff(&wt, &card.base_ref).await?)?);
        }
        // Finished task: the worktree is gone, read the changes back from git history.
        Ok(serde_json::to_value(self.finished_diff(&card).await?)?)
    }

    /// Changes of a finished task: its branch if kept, else the commit that merged it (a local
    /// `Merge <branch>: …` commit, or the squash commit GitHub made for its PR).
    async fn finished_diff(&self, card: &CardRt) -> Result<DiffResult> {
        let project = self.project(&card.project_id).await.ok_or_else(|| anyhow!("Không thấy bảng trên máy này."))?;
        let target = card.merge_target.clone().unwrap_or(card.base_ref.clone());
        let Some(branch) = card.branch.clone() else {
            bail!("Việc đã hoàn tất và nhánh của nó đã được dọn, không còn thay đổi để xem.")
        };
        self.history_diff(&project.repo_path, &branch, &target, card.pr.as_ref().map(|p| p.number)).await
    }

    /// Changes of `branch` from git history once its worktree is gone (see finished_diff).
    async fn history_diff(&self, repo: &str, branch: &str, target: &str, pr: Option<u64>) -> Result<DiffResult> {
        let (branch, target) = (branch.to_string(), target.to_string());
        let gone = || anyhow!("Việc đã hoàn tất và nhánh của nó đã được dọn, không còn thay đổi để xem.");
        if git::branch_exists(repo, &branch).await {
            let mb = git::run(repo, &["merge-base", &target, &branch]).await.map(|s| s.trim().to_string()).unwrap_or(target.clone());
            return git::diff_commits(repo, &mb, &branch, &format!("{target} (nhánh {branch})")).await;
        }
        let find = |rev: String, grep: String| async move {
            git::run(repo, &["log", &rev, "--format=%H", "-n", "1", "--fixed-strings", &format!("--grep={grep}")])
                .await
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        };
        let mut commit = find("--all".into(), format!("Merge {branch}: ")).await;
        if commit.is_none() {
            if let Some(n) = pr.filter(|n| *n > 0) {
                let _ = github::fetch(repo, &target).await;
                commit = find(format!("origin/{target}"), format!("(#{n})")).await;
            }
        }
        let c = commit.ok_or_else(gone)?;
        git::diff_commits(repo, &format!("{c}^1"), &c, &format!("{target} (commit {})", &c[..c.len().min(8)])).await
    }

    async fn screen_of(&self, term: &str) -> Option<Vec<String>> {
        let r = self.orca().ok()?.call(&["terminal", "read", "--terminal", term, "--screen"]).await.ok()?;
        let mut lines: Vec<String> = output_lines(&r).iter().map(|l| redact_line(l.trim_end())).collect();
        while lines.last().is_some_and(|l| l.is_empty()) {
            lines.pop();
        }
        Some(lines)
    }

    async fn screen(&self, card_id: &str) -> Result<Value> {
        let card = self.card(card_id).await?;
        let term = card
            .startup_terminal
            .or(card.pending_retry.map(|r| r.terminal))
            .or(card.agent_terminal)
            .ok_or_else(|| anyhow!("Thẻ chưa có terminal agent."))?;
        let lines = self.screen_of(&term).await.ok_or_else(|| anyhow!("Không đọc được terminal (có thể đã đóng)."))?;
        Ok(json!({ "lines": lines }))
    }

    async fn stop(&self, card_id: &str) -> Result<Value> {
        let card = self.card(card_id).await?;
        if let Some(d) = &card.dispatch_id {
            if card.running {
                if let Err(e) = self.orca()?.call(&["orchestration", "worker-stop", "--dispatch", d]).await {
                    tracing::warn!("worker-stop: {e}");
                }
            }
        }
        if let Some(t) = &card.agent_terminal {
            let _ = self.orca()?.call(&["terminal", "send", "--terminal", t, "--interrupt"]).await;
        }
        self.update_card(card_id, |c| {
            c.running = false;
            c.waiting_kind = None;
            c.pending_retry = None;
            c.startup_terminal = None;
            c.pending_spec = None;
        })
        .await;
        self.sys(card_id, "Đã dừng agent.").await;
        let mut patch = CardStatePatch::new(card_id);
        patch.run_state = Some(RUN_STOPPED.into());
        patch.status = Some("review".into());
        patch.waiting = Some(None);
        self.emit(patch).await;
        Ok(json!({ "ok": true }))
    }

    async fn focus(&self, card_id: &str) -> Result<Value> {
        let card = self.card(card_id).await?;
        let orca = self.orca()?;
        // No `orca open`: Localkan keeps Orca headless. When the user runs Orca.app
        // themselves, this still brings the card's terminal forward there.
        if let Some(t) = card.agent_terminal {
            orca.call(&["terminal", "focus", "--terminal", &t]).await?;
        }
        Ok(json!({ "ok": true }))
    }

    async fn release(&self, card: &CardRt) {
        let Ok(orca) = self.orca() else { return };
        if let Some(d) = &card.dispatch_id {
            if card.running {
                let _ = orca.call(&["orchestration", "worker-stop", "--dispatch", d]).await;
            }
            let _ = orca.call(&["orchestration", "worker-release", "--dispatch", d]).await;
        }
        if let Some(wt) = &card.worktree_path {
            let _ = orca.call(&["terminal", "close", "--worktree", &format!("path:{wt}"), "--all"]).await;
        }
    }

    async fn finish(&self, p: CardFinish) -> Result<Value> {
        let card = self.card(&p.card_id).await?;
        if !card.active {
            bail!("Thẻ này đã được hoàn tất trước đó.");
        }
        if !card.children.is_empty() {
            return self.finish_multi(p, card).await;
        }
        let wt = card.worktree_path.clone().ok_or_else(|| anyhow!("Thẻ chưa có worktree"))?;
        let branch = card.branch.clone().ok_or_else(|| anyhow!("Thẻ chưa có nhánh"))?;
        let project = self.project(&card.project_id).await.ok_or_else(|| anyhow!("Không tìm thấy bảng"))?;
        let message = if p.commit_message.trim().is_empty() { card.title.clone() } else { p.commit_message.trim().to_string() };
        let action = p.action.as_str();
        // A running dev server holds the worktree open; stop it before cleaning up.
        self.previews.stop(&card.card_id).await;
        self.update_card(&card.card_id, |c| c.last.preview = Some(None)).await;
        let exists = Path::new(&wt).exists();
        let target = card.merge_target.clone().unwrap_or_else(|| card.base_ref.clone());

        let mut committed = false;
        if action != "discard" && exists {
            committed = git::commit_all(&wt, &message).await?;
        }
        let mut pr_url: Option<String> = None;
        let mut merged_pr: Option<u64> = None;
        let mut pushed = false;
        match action {
            "merge_push" => {
                if !exists {
                    bail!("Worktree của thẻ không còn, không merge được.");
                }
                self.merge_and_push(&project.repo_path, &wt, &branch, &target, &message).await?;
                pushed = true;
            }
            "pr" | "merge_pr" => {
                if !exists {
                    bail!("Worktree của thẻ không còn, không đẩy được lên GitHub.");
                }
                let pr = self.ensure_pr(&card, &wt, &branch, &target, false).await?;
                if pr.draft {
                    github::pr_ready(&wt, &pr.number.to_string()).await?;
                }
                if action == "merge_pr" {
                    let method = if card.git.pr_flow() { card.git.merge_method.clone() } else { p.git.merge_method.clone() };
                    github::pr_merge(&wt, &pr.number.to_string(), &method).await.map_err(|e| {
                        anyhow!("GitHub chưa cho merge PR #{}: {e:#}. Xem PR trên GitHub (CI bắt buộc, review, xung đột…).", pr.number)
                    })?;
                    merged_pr = Some(pr.number);
                }
                pr_url = Some(pr.url.clone());
            }
            "merge" => {
                self.local_merge(&project.repo_path, &branch, &target, &message).await?;
            }
            "commit" | "discard" => {}
            other => bail!("Hành động không hợp lệ: {other}"),
        }

        self.release(&card).await;
        if exists {
            let mut args = vec!["worktree", "rm"];
            let sel = format!("path:{wt}");
            args.extend(["--worktree", sel.as_str()]);
            if action == "discard" {
                args.push("--force");
            }
            if let Err(e) = self.orca()?.call(&args).await {
                tracing::warn!("worktree rm: {e}");
                let _ = git::raw(&project.repo_path, &["worktree", "remove", "--force", &wt]).await;
            }
        }
        if action == "discard" {
            if let Some(pr) = card.pr.as_ref().filter(|pr| pr.state == "open") {
                let _ = github::pr_close(&project.repo_path, &pr.number.to_string()).await;
                github::delete_remote_branch(&project.repo_path, &branch).await;
            }
            let _ = git::raw(&project.repo_path, &["branch", "-D", &branch]).await;
        }
        let mut base_note = String::new();
        if pushed {
            let _ = git::raw(&project.repo_path, &["branch", "-D", &branch]).await;
            base_note = self.update_local_base(&project.repo_path, &target).await;
        }
        if merged_pr.is_some() {
            let _ = git::raw(&project.repo_path, &["branch", "-D", &branch]).await;
            github::delete_remote_branch(&project.repo_path, &branch).await;
            base_note = self.update_local_base(&project.repo_path, &target).await;
        }
        self.update_card(&card.card_id, |c| {
            c.active = false;
            c.running = false;
            c.waiting_kind = None;
            c.pending_retry = None;
            c.last.status = Some("done".into());
            c.last.run_state = Some("idle".into());
            c.last.waiting = Some(None);
            c.last.pr = Some(None);
            c.publish_pending = false;
            if merged_pr.is_some() {
                if let Some(pr) = c.pr.as_mut() {
                    pr.state = "merged".into();
                }
            }
        })
        .await;

        let summary = match action {
            "commit" if committed => format!("Đã commit vào nhánh {branch}."),
            "commit" => format!("Không có thay đổi mới để commit; nhánh {branch} được giữ lại."),
            "pr" => format!("Đã mở Pull Request từ nhánh {branch}; merge trên GitHub khi sẵn sàng."),
            "merge_pr" => format!("Đã merge PR #{} vào {target} trên GitHub. {base_note}", merged_pr.unwrap_or(0)).trim().to_string(),
            "merge_push" => format!("Đã merge {branch} vào {target} và push lên origin. {base_note}").trim().to_string(),
            "merge" => format!("Đã merge {branch} vào {target}."),
            _ => format!("Đã hủy thay đổi và xóa nhánh {branch}."),
        };
        let status = match action {
            "commit" => "committed",
            "pr" => "pr",
            "merge" | "merge_pr" | "merge_push" => "merged",
            _ => "discarded",
        };
        if let Err(e) = context::set_status(&project.repo_path, &card.card_id, status, &now()).await {
            tracing::warn!("handoff status: {e:#}");
        }
        if action == "merge" {
            // Cards this one built on are now in the target branch too.
            for n in context::list_handoffs(&project.repo_path) {
                if !matches!(n.status.as_str(), "committed" | "pr") {
                    continue;
                }
                if let Some(b) = n.branch.as_deref() {
                    if git::branch_exists(&project.repo_path, b).await && git::is_ancestor(&project.repo_path, b, &target).await {
                        let _ = context::set_status(&project.repo_path, &n.card_id, "merged", &now()).await;
                    }
                }
            }
        }
        self.sys(&card.card_id, summary.clone()).await;
        Ok(json!({ "prUrl": pr_url, "message": summary }))
    }

    // -- GitHub pull requests (flow "pr") --------------------------------------

    /// Publish finished work and refresh open PRs. Runs every tick; network work is spawned.
    async fn pr_tick(self: &Arc<Self>, n: u64) {
        let cards: Vec<CardRt> = self.cards.lock().await.values().filter(|c| c.active && !c.running).cloned().collect();
        for c in cards {
            let open = c.pr.as_ref().is_some_and(|pr| pr.state == "open")
                || c.children.iter().any(|ch| ch.shipped.is_none() && ch.pr.as_ref().is_some_and(|pr| pr.state == "open"));
            let poll = open && n % 30 == 0;
            if !(c.publish_pending || poll) || !self.pr_claim(&c.card_id) {
                continue;
            }
            let me = self.clone();
            tokio::spawn(async move {
                let id = c.card_id.clone();
                if c.publish_pending {
                    me.update_card(&id, |c| c.publish_pending = false).await;
                    let res = if c.children.is_empty() { me.publish_pr(&id).await } else { me.publish_multi(&id).await };
                    if let Err(e) = res {
                        me.sys(&id, format!("Chưa đẩy được lên GitHub: {e:#}")).await;
                    }
                } else if let Err(e) = me.refresh_pr_inner(&id).await {
                    tracing::debug!(card = id, "pr refresh: {e:#}");
                }
                me.pr_busy.lock().unwrap().remove(&id);
            });
        }
    }

    fn pr_claim(&self, card_id: &str) -> bool {
        self.pr_busy.lock().unwrap().insert(card_id.to_string())
    }

    /// Commit the agent's work, push the task branch, and open a draft PR (or update the PR).
    async fn publish_pr(&self, card_id: &str) -> Result<()> {
        let card = self.card(card_id).await?;
        let wt = card.worktree_path.clone().filter(|w| Path::new(w).exists()).ok_or_else(|| anyhow!("worktree không còn"))?;
        let branch = card.branch.clone().ok_or_else(|| anyhow!("thẻ chưa có nhánh"))?;
        let base = card.merge_target.clone().unwrap_or(card.base_ref.clone());
        let pr = self.ensure_pr(&card, &wt, &branch, &base, true).await?;
        self.sys(card_id, format!("Đã đẩy lên GitHub: PR #{}{} → {}.", pr.number, if pr.draft { " (nháp)" } else { "" }, pr.base)).await;
        Ok(())
    }

    /// Commit leftovers, push, and return the task's open PR (creating it when missing).
    async fn ensure_pr(&self, card: &CardRt, wt: &str, branch: &str, base: &str, draft: bool) -> Result<PrInfo> {
        let pr = self.ensure_pr_at(card, wt, branch, base, card.pr.clone(), draft).await?;
        self.set_pr(&card.card_id, Some(pr.clone())).await;
        Ok(pr)
    }

    /// Commit, push `branch` from `wt`, and return its open PR into `base` (created if missing).
    async fn ensure_pr_at(&self, card: &CardRt, wt: &str, branch: &str, base: &str, current: Option<PrInfo>, draft: bool) -> Result<PrInfo> {
        let message = match (&current, &card.last_request) {
            (Some(_), Some(req)) => format!("Cập nhật theo review: {}", first_line(req, 60)),
            _ => card.title.clone(),
        };
        git::commit_all(wt, &message).await?;
        let existing = match &current {
            Some(pr) if pr.state == "open" => Some(pr.clone()),
            _ => github::pr_for_branch(wt, branch).await,
        };
        if existing.is_none() && github::ahead(wt, &format!("origin/{base}")).await == 0 && github::ahead(wt, base).await == 0 {
            bail!("chưa có thay đổi nào so với {base} để mở PR");
        }
        github::push(wt, branch).await?;
        let pr = match existing {
            Some(pr) => github::pr_view(wt, &pr.number.to_string()).await?,
            None => {
                let body = self.pr_body(card).await;
                let url = github::pr_create(wt, base, branch, &card.title, &body, draft).await?;
                github::pr_view(wt, &url).await?
            }
        };
        Ok(pr)
    }

    /// PR description: the agent's summary and handoff note.
    async fn pr_body(&self, card: &CardRt) -> String {
        let wt = card.worktree_path.clone().unwrap_or_default();
        let mut body = String::new();
        if let Some(summary) = card.last.summary.clone().flatten().filter(|s| !s.trim().is_empty()) {
            body.push_str(&format!("## Tóm tắt\n\n{}\n\n", summary.trim()));
        }
        if let Ok(note) = std::fs::read_to_string(Path::new(&wt).join(context::AGENT_HANDOFF_FILE)) {
            let note: String = note.trim().chars().take(4000).collect();
            if !note.is_empty() {
                body.push_str(&format!("## Ghi chú bàn giao\n\n{note}\n\n"));
            }
        }
        body.push_str(&format!("_Tạo bởi Localkan từ việc “{}”._", card.title));
        body
    }

    /// Store the PR on the card and tell the server when it changed.
    async fn set_pr(&self, card_id: &str, pr: Option<PrInfo>) {
        let before = self.card(card_id).await.ok().and_then(|c| c.pr);
        let changed = match (&before, &pr) {
            (Some(a), Some(b)) => !a.same_as(b),
            (None, None) => false,
            _ => true,
        };
        self.update_card(card_id, |c| c.pr = pr.clone()).await;
        if changed {
            let mut patch = CardStatePatch::new(card_id);
            patch.pr = Some(pr);
            self.emit(patch).await;
        }
    }

    async fn pr_refresh(&self, card_id: &str) -> Result<Value> {
        if !self.pr_claim(card_id) {
            // A refresh or publish is already running; report what we know.
            return Ok(json!({ "pr": self.card(card_id).await?.pr }));
        }
        let res = self.refresh_pr_inner(card_id).await;
        self.pr_busy.lock().unwrap().remove(card_id);
        res?;
        Ok(json!({ "pr": self.card(card_id).await.ok().and_then(|c| c.pr) }))
    }

    /// Read the PR from GitHub; a PR merged there (by you, on github.com) completes the task.
    async fn refresh_pr_inner(&self, card_id: &str) -> Result<()> {
        let card = self.card(card_id).await?;
        if !card.active {
            return Ok(());
        }
        if !card.children.is_empty() {
            return self.refresh_multi(card_id).await;
        }
        let wt = card.worktree_path.clone().filter(|w| Path::new(w).exists());
        let project = self.project(&card.project_id).await.ok_or_else(|| anyhow!("không thấy bảng"))?;
        let dir = wt.clone().unwrap_or(project.repo_path.clone());
        let pr = match &card.pr {
            Some(pr) => github::pr_view(&dir, &pr.number.to_string()).await?,
            None => match card.branch.as_deref() {
                Some(b) => match github::pr_for_branch(&dir, b).await {
                    Some(pr) => pr,
                    None => return Ok(()),
                },
                None => return Ok(()),
            },
        };
        if pr.state == "merged" {
            return self.complete_merged(&card, pr).await;
        }
        self.set_pr(card_id, Some(pr)).await;
        Ok(())
    }

    /// The PR was merged on GitHub: clean up like "Merge PR" would and mark the task done.
    async fn complete_merged(&self, card: &CardRt, pr: PrInfo) -> Result<()> {
        let project = self.project(&card.project_id).await.ok_or_else(|| anyhow!("không thấy bảng"))?;
        let target = card.merge_target.clone().unwrap_or(card.base_ref.clone());
        self.previews.stop(&card.card_id).await;
        self.release(card).await;
        if let Some(wt) = card.worktree_path.clone().filter(|w| Path::new(w).exists()) {
            let sel = format!("path:{wt}");
            if self.orca()?.call(&["worktree", "rm", "--worktree", &sel]).await.is_err() {
                let _ = git::raw(&project.repo_path, &["worktree", "remove", "--force", &wt]).await;
            }
        }
        if let Some(b) = &card.branch {
            let _ = git::raw(&project.repo_path, &["branch", "-D", b]).await;
            github::delete_remote_branch(&project.repo_path, b).await;
        }
        let note = self.update_local_base(&project.repo_path, &target).await;
        let _ = context::set_status(&project.repo_path, &card.card_id, "merged", &now()).await;
        let summary = format!("PR #{} đã được merge vào {target} trên GitHub. {note}", pr.number).trim().to_string();
        self.update_card(&card.card_id, |c| {
            c.active = false;
            c.running = false;
            c.waiting_kind = None;
            c.pr = Some(PrInfo { state: "merged".into(), ..pr.clone() });
            c.publish_pending = false;
        })
        .await;
        self.sys(&card.card_id, summary.clone()).await;
        let mut patch = CardStatePatch::new(&card.card_id);
        patch.status = Some("done".into());
        patch.run_state = Some("idle".into());
        patch.waiting = Some(None);
        patch.preview = Some(None);
        patch.pr = Some(None);
        patch.pr_url = Some(Some(pr.url));
        patch.summary = Some(Some(summary));
        self.emit(patch).await;
        Ok(())
    }

    /// Merge `branch` into `target` in the repo folder itself (it must be on `target` and clean).
    async fn local_merge(&self, repo: &str, branch: &str, target: &str, message: &str) -> Result<()> {
        if git::has_changes(repo).await? {
            bail!("Repo chính ({repo}) còn thay đổi chưa commit. Hãy dọn trước khi merge.");
        }
        let current = git::current_branch(repo).await.unwrap_or_default();
        if current != target {
            bail!("Repo chính ({repo}) đang ở nhánh {current}, không phải {target}. Chuyển về {target} rồi thử lại.");
        }
        let out = git::raw(repo, &["merge", "--no-ff", branch, "-m", &format!("Merge {branch}: {message}")]).await?;
        if !out.ok {
            let detail = format!("{}{}", out.stdout, out.stderr);
            if detail.contains("CONFLICT") || detail.contains("Automatic merge failed") {
                let _ = git::raw(repo, &["merge", "--abort"]).await;
                bail!("Merge bị xung đột với {target}, đã hủy merge. Hãy yêu cầu agent cập nhật theo {target} rồi thử lại, hoặc xử lý thủ công.");
            }
            bail!("Merge thất bại: {}", detail.trim());
        }
        Ok(())
    }

    /// Flow "push": merge the task branch into the latest origin/<base> and push that, without
    /// touching the project folder. Nothing is pushed when the merge conflicts or origin moved.
    async fn merge_and_push(&self, repo: &str, wt: &str, branch: &str, base: &str, message: &str) -> Result<()> {
        let on_origin = github::fetch(repo, base).await.is_ok() && git::raw(repo, &["rev-parse", "--verify", "-q", &format!("refs/remotes/origin/{base}")]).await.map(|o| o.ok).unwrap_or(false);
        // A brand-new remote may not have the base branch yet: start from the local one.
        let start = if on_origin { format!("origin/{base}") } else { base.to_string() };
        git::run(wt, &["checkout", "-q", "--detach", &start]).await.with_context(|| format!("không chuyển được sang {start}"))?;
        let back = || async { let _ = git::raw(wt, &["checkout", "-q", branch]).await; };
        let out = git::raw(wt, &["merge", "--no-ff", branch, "-m", &format!("Merge {branch}: {message}")]).await?;
        if !out.ok {
            let detail = format!("{}{}", out.stdout, out.stderr);
            let _ = git::raw(wt, &["merge", "--abort"]).await;
            back().await;
            if detail.contains("CONFLICT") {
                bail!("Nhánh xung đột với {start}, chưa push gì. Bấm Yêu cầu sửa và nhờ agent: \"merge {start} vào nhánh này và giải quyết xung đột\", rồi duyệt lại.");
            }
            bail!("Merge thất bại: {}", first_line(&detail, 200));
        }
        if let Err(e) = github::push_ref(wt, base).await {
            back().await;
            bail!("{e:#}. Nếu origin/{base} vừa có commit mới, bấm duyệt lại để Localkan lấy bản mới và merge lại.");
        }
        Ok(())
    }

    /// After a merge on GitHub: fast-forward the base branch in the project folder when that is
    /// safe (it is checked out and clean). Returns a note for the summary.
    async fn update_local_base(&self, repo: &str, base: &str) -> String {
        if github::fetch(repo, base).await.is_err() {
            return String::new();
        }
        let current = git::current_branch(repo).await;
        if current.as_deref() != Some(base) {
            return format!("Thư mục dự án đang ở nhánh {}, chưa cập nhật {base}.", current.unwrap_or_default());
        }
        if git::has_changes(repo).await.unwrap_or(true) {
            return format!("Thư mục dự án còn thay đổi chưa commit nên chưa cập nhật {base}.");
        }
        match git::raw(repo, &["merge", "--ff-only", &format!("origin/{base}")]).await {
            Ok(o) if o.ok => format!("Đã cập nhật {base} trong thư mục dự án."),
            _ => format!("Không fast-forward được {base} trong thư mục dự án; hãy git pull bằng tay."),
        }
    }

    /// Bring the task branch up to date with origin/<base>. On conflicts the merge is undone.
    async fn pr_sync(&self, card_id: &str) -> Result<Value> {
        let card = self.card(card_id).await?;
        if !card.children.is_empty() {
            return self.sync_multi(card_id).await;
        }
        let wt = card.worktree_path.clone().filter(|w| Path::new(w).exists()).ok_or_else(|| anyhow!("Worktree của thẻ không còn."))?;
        let base = card.merge_target.clone().unwrap_or(card.base_ref.clone());
        let project = self.project(&card.project_id).await.ok_or_else(|| anyhow!("Không thấy bảng"))?;
        github::fetch(&project.repo_path, &base).await.map_err(|e| anyhow!("Không lấy được origin/{base}: {e:#}"))?;
        git::commit_all(&wt, &format!("Lưu thay đổi trước khi cập nhật theo {base}")).await?;
        let out = git::raw(&wt, &["merge", "--no-edit", &format!("origin/{base}")]).await?;
        if !out.ok {
            let detail = format!("{}{}", out.stdout, out.stderr);
            let _ = git::raw(&wt, &["merge", "--abort"]).await;
            if detail.contains("CONFLICT") {
                return Ok(json!({ "ok": false, "conflict": true, "message": format!("Nhánh xung đột với origin/{base}; đã hủy merge. Nhờ agent xử lý xung đột.") }));
            }
            bail!("Không merge được origin/{base}: {}", first_line(&detail, 200));
        }
        if let Some(branch) = &card.branch {
            if card.pr.is_some() {
                github::push(&wt, branch).await?;
                let _ = self.refresh_pr_inner(card_id).await;
            }
        }
        self.sys(card_id, format!("Đã cập nhật nhánh theo origin/{base}.")).await;
        Ok(json!({ "ok": true, "conflict": false, "message": format!("Đã cập nhật theo origin/{base}.") }))
    }

    // -- supervision ---------------------------------------------------------

    /// One supervision pass: read each board's orchestration mailbox, then each running
    /// card's output and observed state.
    pub async fn tick(self: &Arc<Self>) {
        let n = self.ticks.fetch_add(1, Ordering::Relaxed);
        self.pr_tick(n).await;
        let cards: Vec<CardRt> = self
            .cards
            .lock()
            .await
            .values()
            .filter(|c| c.active && (c.running || matches!(c.waiting_kind.as_deref(), Some("question" | "login"))))
            .cloned()
            .collect();
        if cards.is_empty() || self.orca.is_none() {
            return;
        }
        let projects: HashSet<String> = cards.iter().map(|c| c.project_id.clone()).collect();
        for pid in projects {
            if let Err(e) = self.poll_inbox(&pid).await {
                tracing::debug!(pid, "inbox: {e:#}");
            }
        }
        for c in cards.iter().filter(|c| c.running) {
            if let Err(e) = self.poll_output(&c.card_id).await {
                tracing::debug!(card = c.card_id, "output: {e:#}");
            }
            if n % 2 == 0 {
                if let Err(e) = self.observe(&c.card_id).await {
                    tracing::debug!(card = c.card_id, "observe: {e:#}");
                }
            }
        }
    }

    async fn poll_inbox(&self, project_id: &str) -> Result<()> {
        let p = self.project(project_id).await.ok_or_else(|| anyhow!("no project"))?;
        let (Some(coord), Some(run)) = (p.coord_handle.clone(), p.run_id.clone()) else { return Ok(()) };
        let orca = self.orca()?;
        let mut ack: Option<String> = None;
        for round in 0..6 {
            let mut args: Vec<&str> = vec!["orchestration", "check", "--terminal", &coord, "--run", &run];
            if let Some(a) = &ack {
                args.extend(["--ack", a.as_str()]);
            }
            let r = orca.call(&args).await?;
            let msgs = r["messages"].as_array().cloned().unwrap_or_default();
            if msgs.is_empty() || round == 5 {
                // Either drained, or we acked the last processed batch and will handle the
                // returned (replayed) batch on the next tick.
                break;
            }
            for m in &msgs {
                self.on_message(&p, m).await;
            }
            ack = s(&r["deliveryId"]);
            if ack.is_none() {
                break;
            }
        }
        Ok(())
    }

    async fn on_message(&self, p: &ProjectRt, m: &Value) {
        let typ = m["type"].as_str().unwrap_or("");
        let payload: Value = match &m["payload"] {
            Value::String(st) => serde_json::from_str(st).unwrap_or(Value::Null),
            other => other.clone(),
        };
        let dispatch = s(&payload["dispatchId"]);
        let task = s(&payload["taskId"]);
        let from = s(&m["from_handle"]);
        let card = {
            let cards = self.cards.lock().await;
            cards
                .values()
                .find(|c| {
                    c.project_id == p.project_id
                        && c.active
                        && ((dispatch.is_some() && c.dispatch_id == dispatch)
                            || (task.is_some() && c.task_id == task)
                            || (from.is_some() && c.agent_terminal == from))
                })
                .cloned()
        };
        let Some(card) = card else {
            tracing::debug!(typ, "mailbox message for an unknown card");
            return;
        };
        let subject = m["subject"].as_str().unwrap_or("").to_string();
        let body = m["body"].as_str().unwrap_or("").to_string();

        match typ {
            "worker_done" => {
                if let Some(rej) = payload["_orcaLifecycleRejection"].as_object() {
                    let reason = rej.get("reason").and_then(Value::as_str).unwrap_or("");
                    self.sys(&card.card_id, format!("Orca từ chối báo cáo hoàn thành: {reason}")).await;
                    return;
                }
                if dispatch.is_some() && card.dispatch_id != dispatch {
                    return; // late report from an earlier dispatch
                }
                if !card.running && card.last.status.as_deref() == Some("review") {
                    return; // already settled (replayed delivery)
                }
                let ok = payload["outcome"].as_str() != Some("failed");
                self.settle(&card, ok, Some(if body.is_empty() { subject.clone() } else { body.clone() })).await;
            }
            "question" | "decision_gate" | "escalation" => {
                let mut text = if typ == "escalation" {
                    format!("Agent báo vướng: {subject}\n{body}")
                } else if body.is_empty() {
                    subject.clone()
                } else {
                    body.clone()
                };
                if typ == "question" && text.trim_start().starts_with("[LOGIN]") {
                    self.ask_login(&card, text.trim_start()["[LOGIN]".len()..].trim(), s(&m["id"])).await;
                    return;
                }
                if let Some(opts) = payload["options"].as_array() {
                    let o: Vec<&str> = opts.iter().filter_map(Value::as_str).collect();
                    if !o.is_empty() {
                        text.push_str(&format!("\nLựa chọn: {}", o.join(", ")));
                    }
                }
                self.update_card(&card.card_id, |c| c.waiting_kind = Some("question".into())).await;
                self.sys(&card.card_id, format!("Agent hỏi: {}", text.replace('\n', " "))).await;
                let mut patch = CardStatePatch::new(&card.card_id);
                patch.run_state = Some(RUN_WAITING.into());
                patch.status = Some("needs_input".into());
                patch.waiting = Some(Some(WaitingInfo {
                    kind: "question".into(),
                    text: redact_line(&text),
                    message_id: s(&m["id"]),
                    screen: None,
                    ..Default::default()
                }));
                self.emit(patch).await;
            }
            _ => {
                let line = if body.is_empty() { format!("[{typ}] {subject}") } else { format!("[{typ}] {subject} — {body}") };
                self.sys(&card.card_id, line).await;
            }
        }
    }

    /// The agent finished its dispatch (reported or observed): move the card to Review.
    async fn settle(&self, card: &CardRt, ok: bool, summary: Option<String>) {
        // PR flow: push the work and open (or update) the PR so CI runs while you review.
        let publish = ok
            && card.mode != "ask"
            && if card.children.is_empty() {
                card.git.pr_flow() && (card.git.auto_draft_pr || card.pr.is_some())
            } else {
                card.children.iter().any(|c| c.shipped.is_none() && c.git.pr_flow() && (c.git.auto_draft_pr || c.pr.is_some()))
            };
        self.update_card(&card.card_id, |c| {
            c.running = false;
            c.waiting_kind = None;
            c.pending_retry = None;
            c.publish_pending = publish;
        })
        .await;
        if let (Some(d), Ok(orca)) = (&card.dispatch_id, self.orca()) {
            // Keep the agent's terminal alive for follow-ups and for "open in Orca".
            let _ = orca.call(&["orchestration", "worker-retain", "--dispatch", d]).await;
        }
        // Flush any output that arrived after the last poll.
        let _ = self.poll_output_inner(&card.card_id).await;
        self.record_handoff(card, summary.as_deref()).await;
        self.sys(&card.card_id, if ok { "Agent báo đã xong. Chuyển sang Review." } else { "Agent báo thất bại." }).await;
        let mut patch = CardStatePatch::new(&card.card_id);
        patch.run_state = Some(if ok { RUN_SUCCEEDED } else { RUN_FAILED }.into());
        patch.status = Some("review".into());
        patch.waiting = Some(None);
        patch.summary = Some(summary.clone().map(|s| redact_line(&s)));
        patch.error = Some(if ok { None } else { summary.map(|s| redact_line(&s)) });
        self.emit(patch).await;
    }

    /// Save the agent's handoff note (or its summary) to the repo's .localkan/handoffs/.
    async fn record_handoff(&self, card: &CardRt, summary: Option<&str>) {
        let Some(project) = self.project(&card.project_id).await else { return };
        let written = card
            .worktree_path
            .as_ref()
            .and_then(|wt| std::fs::read_to_string(Path::new(wt).join(context::AGENT_HANDOFF_FILE)).ok())
            .filter(|t| !t.trim().is_empty());
        let from_agent = written.is_some();
        let content = written.or_else(|| summary.map(String::from)).unwrap_or_default();
        if content.trim().is_empty() {
            return;
        }
        let note = context::HandoffNote {
            card_id: card.card_id.clone(),
            title: card.title.clone(),
            agent: card.agent.clone(),
            branch: card.branch.clone(),
            status: "in_review".into(),
            updated_at: now(),
            content: redact_line(&content).to_string(),
        };
        match context::write_handoff(&project.repo_path, &note).await {
            Ok(()) => {
                self.sys(
                    &card.card_id,
                    if from_agent { "Đã lưu ghi chú bàn giao của agent vào .localkan/handoffs/." } else { "Agent không viết ghi chú bàn giao; đã lưu bản tóm tắt thay thế." },
                )
                .await
            }
            Err(e) => tracing::warn!("handoff: {e:#}"),
        }
    }

    async fn poll_output(&self, card_id: &str) -> Result<()> {
        self.poll_output_inner(card_id).await
    }

    async fn poll_output_inner(&self, card_id: &str) -> Result<()> {
        let card = self.card(card_id).await?;
        let Some(d) = card.dispatch_id.clone() else { return Ok(()) };
        let mut args: Vec<&str> = vec!["orchestration", "worker-read", "--dispatch", &d, "--limit", "400"];
        if let Some(c) = &card.read_cursor {
            args.extend(["--cursor", c.as_str()]);
        }
        match self.orca()?.call(&args).await {
            Ok(r) => {
                let cursor = s(&r["cursor"]);
                self.update_card(card_id, |c| {
                    if cursor.is_some() {
                        c.read_cursor = cursor.clone();
                    }
                })
                .await;
                let from_terminal = matches!(r["source"].as_str(), None | Some("terminal"));
                let lines = if from_terminal {
                    // The raw stream of a TUI agent is keystroke-level repaint fragments.
                    // The rendered screen reads like a transcript; the log filter keeps
                    // only lines that have not been seen recently.
                    let term = card.agent_terminal.clone().or_else(|| s(&r["terminal"]["handle"]));
                    match term {
                        Some(t) => self.screen_of(&t).await.unwrap_or_default(),
                        None => Vec::new(),
                    }
                } else {
                    output_lines(&r)
                };
                self.log(card_id, "agent", lines).await;
                Ok(())
            }
            Err(e) if e.code.contains("source_changed") || e.code.contains("cursor") => {
                self.update_card(card_id, |c| c.read_cursor = None).await;
                Ok(())
            }
            Err(e) => Err(e.into()),
        }
    }

    async fn observe(&self, card_id: &str) -> Result<()> {
        let card = self.card(card_id).await?;
        let Some(d) = card.dispatch_id.clone() else { return Ok(()) };
        let r = self.orca()?.call(&["orchestration", "worker-show", "--dispatch", &d]).await?;

        let term = s(&r["worker"]["agentTerminalHandle"]).or_else(|| s(&r["terminal"]["handle"]));
        if card.agent_terminal.is_none() && term.is_some() {
            self.update_card(card_id, |c| c.agent_terminal = term.clone()).await;
        }

        let dstatus = r["dispatch"]["status"].as_str().unwrap_or("");
        if card.running && matches!(dstatus, "completed" | "failed") {
            // Settled without us seeing worker_done in the mailbox (e.g. consumed elsewhere).
            let ok = dstatus == "completed" && r["projection"]["outcome"].as_str() != Some("failed");
            self.settle(&card, ok, None).await;
            return Ok(());
        }
        if card.running && r["projection"]["liveness"]["verdict"].as_str() == Some("exited") {
            self.update_card(card_id, |c| c.running = false).await;
            self.sys(card_id, "Agent đã thoát trước khi báo xong.").await;
            let mut patch = CardStatePatch::new(card_id);
            patch.run_state = Some(RUN_FAILED.into());
            patch.status = Some("review".into());
            patch.error = Some(Some("Agent đã thoát trước khi báo xong.".into()));
            self.emit(patch).await;
            return Ok(());
        }

        let wait = [&r["observation"]["agentWait"], &r["terminal"]["agentWait"]]
            .into_iter()
            .find(|v| v.is_object())
            .cloned();
        match (wait, card.waiting_kind.as_deref()) {
            (Some(w), None) => {
                let screen = match term.as_deref().or(card.agent_terminal.as_deref()) {
                    Some(t) => self.screen_of(t).await,
                    None => None,
                };
                self.update_card(card_id, |c| c.waiting_kind = Some("prompt".into())).await;
                let text = describe_wait(&w);
                self.sys(card_id, format!("Agent đang chờ: {text}")).await;
                let mut patch = CardStatePatch::new(card_id);
                patch.run_state = Some(RUN_WAITING.into());
                patch.status = Some("needs_input".into());
                patch.waiting = Some(Some(WaitingInfo { kind: "prompt".into(), text, message_id: None, screen, ..Default::default() }));
                self.emit(patch).await;
            }
            (None, Some("prompt")) => {
                self.update_card(card_id, |c| c.waiting_kind = None).await;
                let mut patch = CardStatePatch::new(card_id);
                patch.run_state = Some(RUN_RUNNING.into());
                patch.status = Some("in_progress".into());
                patch.waiting = Some(None);
                self.emit(patch).await;
            }
            _ => {}
        }
        Ok(())
    }
}

/// Terminal output from TUI agents arrives as a stream of repaints: spinner frames,
/// borders, status bars and the same lines over and over. Keep what a reader needs.
#[derive(Default)]
struct LogFilter {
    recent: VecDeque<String>,
    last_blank: bool,
}

impl LogFilter {
    const WINDOW: usize = 200;

    fn accept(&mut self, raw: &str) -> Option<String> {
        let line = strip_spinner(raw.trim_end());
        let t = line.trim();
        if t.is_empty() {
            if self.last_blank {
                return None;
            }
            self.last_blank = true;
            return Some(String::new());
        }
        if is_chrome(t) || self.recent.iter().any(|r| r == t) {
            return None;
        }
        self.recent.push_back(t.to_string());
        if self.recent.len() > Self::WINDOW {
            self.recent.pop_front();
        }
        self.last_blank = false;
        Some(line)
    }
}

fn is_spinner(c: char) -> bool {
    ('\u{2800}'..='\u{28FF}').contains(&c) || "◐◓◑◒◴◷◶◵".contains(c)
}

/// Drop a leading spinner frame (and the spaces after it); leave other indentation alone.
fn strip_spinner(s: &str) -> String {
    let trimmed = s.trim_start();
    match trimmed.chars().next() {
        Some(c) if is_spinner(c) => trimmed[c.len_utf8()..].trim_start().to_string(),
        _ => s.to_string(),
    }
}

fn is_chrome(t: &str) -> bool {
    t == ">"
        || t.starts_with("esc to ")
        || t.starts_with("? for shortcuts")
        || t.chars().all(|c| "─━═│┃╭╮╰╯┌┐└┘├┤┬┴┼▔▁▏▕-_ ".contains(c))
}

#[derive(Debug, PartialEq)]
enum Startup {
    /// The agent shows its input prompt and can take a task.
    Ready,
    /// A selection dialog (trust, permission mode, …) waits for an answer.
    Dialog,
    /// The agent quit; the shell prompt is back.
    Exited,
    Unknown,
}

fn classify_startup(lines: &[String]) -> Startup {
    let content: Vec<&str> = lines.iter().map(|l| l.trim_end()).filter(|l| !l.is_empty()).collect();
    let Some(last) = content.last() else { return Startup::Unknown };
    // The shell prompt is back (zsh "%", bash "$", root "#"): the agent quit. Checked first
    // because the old dialog text stays on screen above the prompt.
    if content.len() > 1 && (last.ends_with('%') || last.ends_with('$') || last.ends_with('#')) {
        return Startup::Exited;
    }
    // Only the bottom of the screen reflects the current state.
    let tail = content[content.len().saturating_sub(8)..].join("\n").to_lowercase();
    if tail.contains("enter to confirm") || tail.contains("esc to cancel") || tail.contains("↑/↓ navigate") {
        return Startup::Dialog;
    }
    let ready_marks = ["for shortcuts", "⏵⏵", "permissions on", "auto mode on", "accept edits on", "plan mode on", "shift+tab to cycle"];
    if ready_marks.iter().any(|m| tail.contains(m)) {
        return Startup::Ready;
    }
    Startup::Unknown
}

/// Given a rendered selection prompt, how many lines to move the highlight (+down / -up) to
/// reach the approve or reject option. None when no selection list is recognisable.
fn plan_choice(lines: &[String], approve: bool) -> Option<i64> {
    let strip = |l: &str| -> String {
        let t = l.trim_start().trim_start_matches(['❯', '>', '›', '▸', '●', '○', '◯', '*']).trim_start();
        // drop "1." / "2)" numbering
        let t = t.trim_start_matches(|c: char| c.is_ascii_digit()).trim_start_matches(['.', ')']).trim_start();
        t.to_lowercase()
    };
    let selected = lines.iter().rposition(|l| {
        let t = l.trim_start();
        (t.starts_with('❯') || t.starts_with("> ") || t.starts_with('›')) && strip(l).len() > 1
    })?;
    let yes = ["yes", "allow", "trust", "approve", "accept", "proceed", "continue", "đồng ý", "có"];
    let no = ["no", "deny", "reject", "exit", "cancel", "don't", "từ chối", "không"];
    let words = if approve { &yes[..] } else { &no[..] };
    let lo = selected.saturating_sub(8);
    let hi = (selected + 8).min(lines.len().saturating_sub(1));
    let mut best: Option<usize> = None;
    for i in lo..=hi {
        let t = strip(&lines[i]);
        if t.is_empty() || t.contains("to confirm") || t.contains("navigate") {
            continue;
        }
        if words.iter().any(|w| t.starts_with(w)) {
            // prefer the option closest to the current highlight
            if best.is_none_or(|b| i.abs_diff(selected) < b.abs_diff(selected)) {
                best = Some(i);
            }
        }
    }
    best.map(|b| b as i64 - selected as i64)
}

/// Safe, readable file name for an attachment, with an extension matching its type.
fn attachment_file_name(name: &str, mime: &str) -> String {
    let ext = match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "bin",
    };
    let stem = name.rsplit_once('.').map(|(a, _)| a).unwrap_or(name);
    let mut clean = String::new();
    for ch in stem.to_lowercase().chars().map(fold_vietnamese) {
        if ch.is_ascii_alphanumeric() {
            clean.push(ch);
        } else if !clean.ends_with('-') && !clean.is_empty() {
            clean.push('-');
        }
        if clean.len() >= 48 {
            break;
        }
    }
    let clean = clean.trim_matches('-');
    format!("{}.{ext}", if clean.is_empty() { "image" } else { clean })
}

/// Preview session key for a board's own folder (card previews use the card id).
fn project_key(project_id: &str) -> String {
    format!("project-{project_id}")
}

fn describe_wait(w: &Value) -> String {
    for key in ["prompt", "text", "question", "summary", "reason", "kind"] {
        if let Some(t) = w[key].as_str().filter(|t| !t.is_empty()) {
            return redact_line(t);
        }
    }
    "Agent đang chờ bạn xác nhận trong terminal.".into()
}

/// Map Vietnamese letters with diacritics to their ASCII base letter.
fn fold_vietnamese(ch: char) -> char {
    const GROUPS: [(char, &str); 7] = [
        ('a', "àáạảãâầấậẩẫăằắặẳẵ"),
        ('e', "èéẹẻẽêềếệểễ"),
        ('i', "ìíịỉĩ"),
        ('o', "òóọỏõôồốộổỗơờớợởỡ"),
        ('u', "ùúụủũưừứựửữ"),
        ('y', "ỳýỵỷỹ"),
        ('d', "đ"),
    ];
    GROUPS.iter().find(|(_, set)| set.contains(ch)).map(|(base, _)| *base).unwrap_or(ch)
}

/// Worktree/branch name: unique per card, readable when the title is ASCII.
pub fn branch_name(card_id: &str, title: &str) -> String {
    let short: String = card_id.chars().filter(|c| c.is_ascii_alphanumeric()).take(8).collect();
    let slug = slug(title, 24);
    if slug.is_empty() { format!("lk-{short}") } else { format!("lk-{short}-{slug}") }
}

/// Lowercase ASCII slug of a title (Vietnamese accents folded), at most about `max` chars.
pub fn slug(title: &str, max: usize) -> String {
    let mut slug = String::new();
    for ch in title.to_lowercase().chars().map(fold_vietnamese) {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
        } else if !slug.ends_with('-') && !slug.is_empty() {
            slug.push('-');
        }
        if slug.len() >= max {
            break;
        }
    }
    slug.trim_matches('-').to_string()
}

const COMMON_RULES: &str = "Rules from Localkan (the reviewer's Kanban board):
- Work only inside this worktree. Do not commit, push, merge or open pull requests; the reviewer does that after reviewing your diff.
- If you need a decision from the human reviewer, use the `orca orchestration ask` command from your instructions. Do not open interactive prompts.
- To open or check web pages, use Orca's built-in browser through the `orca` CLI. It is shared with the reviewer and keeps their sign-ins: `orca tab create --url <url> --json` (keep the browserPageId), then `orca snapshot --page <id>`, `orca click --element @e1 --page <id>`, `orca fill --element @e2 --value <text> --page <id>`, `orca screenshot --page <id>`, `orca eval --expression <js> --page <id>`; `orca skills get orca-cli` has the full browser reference. Do not start a separate browser (Playwright, Puppeteer, Chrome DevTools, headless Chrome) for pages that need a signed-in session: it would not have the sign-in.
- Never type passwords, one-time codes or other credentials, and never look for them in files, env vars or keychains, except test accounts for this project's own local app that the task or project memory gives you. When a page needs a sign-in, keep it open in its Orca tab and run the `orca orchestration ask` command from your instructions with `--timeout-ms 3600000` and a question that starts with `[LOGIN]`, then the page URL, then which site or account is needed (for example `[LOGIN] https://admin.example.com/login needs an admin account`). The reviewer signs in remotely in that tab. When the reply arrives, reload the page and continue. If the ask times out, resume it with its message id instead of asking again.
- Before you report done, write a handoff note to `.localkan/handoff.md` (Markdown, at most about 300 words): what you changed and why, decisions you made, anything the next task must know (gotchas, follow-ups), and the main files touched. Later tasks on this project read it. Git ignores it.
- When finished, send worker_done exactly as instructed, with a short summary of what you changed and how you verified it.";

const ASK_RULES: &str = "- This card is a QUESTION, not a change request. Do not modify any project files.
- Write your complete answer in Markdown to `.localkan/answer.md` (create the folder). That file is how the reviewer reads your answer.";

pub fn compose_spec(title: &str, prompt: &str, mode: &str, images: &[String], context: &str) -> String {
    let mut out = format!("Task: {title}\n");
    if !prompt.trim().is_empty() {
        out.push_str(&format!("\n{}\n", prompt.trim()));
    }
    if !images.is_empty() {
        out.push_str(
            "\nReference images from the reviewer. Open each file and look at it before you start; \
             they are task context, not project files, and git ignores them:\n",
        );
        for img in images {
            out.push_str(&format!("- {img}\n"));
        }
    }
    if !context.trim().is_empty() {
        out.push_str(&format!(
            "\n# Project context from Localkan (shared memory and notes from earlier tasks)\n\n{}\n",
            context.trim()
        ));
    }
    out.push_str(&format!("\n{COMMON_RULES}\n"));
    if mode == "ask" {
        out.push_str(&format!("{ASK_RULES}\n"));
    }
    out
}

pub fn compose_followup(title: &str, text: &str, mode: &str) -> String {
    let mut out = format!(
        "Follow-up on the task \"{title}\" in this same worktree. Your earlier changes are still here.\n\n{}\n\n{COMMON_RULES}\n",
        text.trim()
    );
    if mode == "ask" {
        out.push_str(&format!("{ASK_RULES}\n"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_filter_drops_tui_noise() {
        let mut f = LogFilter::default();
        let input = ["⢿  Running command...", "", "", "⣾  Running command...", "──────", ">", "● Ran (ls -la)", "  indented code", "⣟  Running command..."];
        let out: Vec<String> = input.iter().filter_map(|l| f.accept(l)).collect();
        assert_eq!(out, vec!["Running command...", "", "● Ran (ls -la)", "  indented code"]);
    }

    #[test]
    fn startup_classification() {
        let v = |xs: &[&str]| xs.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(classify_startup(&v(&["user@mac wt % claude", " ❯ No, exit", "   Yes, I accept", " Enter to confirm · Esc to cancel"])), Startup::Dialog);
        assert_eq!(classify_startup(&v(&["❯ Try \"fix lint\"", "───", "  ⏵⏵ bypass permissions on (shift+tab to cycle)"])), Startup::Ready);
        assert_eq!(classify_startup(&v(&["user@mac wt % claude '--dangerously-skip-permissions'", "", "user@mac wt %"])), Startup::Exited);
        assert_eq!(classify_startup(&v(&["user@mac wt % claude"])), Startup::Unknown);
        // Dialog text left above the prompt after choosing "No, exit".
        assert_eq!(
            classify_startup(&v(&["  ❯ No, exit", "    Yes, I accept", "  Enter to confirm · Esc to cancel", "admin@Mac wt %"])),
            Startup::Exited
        );
    }

    #[test]
    fn choice_planning() {
        let claude: Vec<String> = [
            " Quick safety check: Is this a project you created or one you trust?",
            " ❯ No, exit",
            "   Yes, I trust this folder",
            " Enter to confirm · Esc to cancel",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(plan_choice(&claude, true), Some(1));
        assert_eq!(plan_choice(&claude, false), Some(0));
        let agy: Vec<String> = ["Do you trust the contents of this project?", "> Yes, I trust this folder", "  No, exit"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(plan_choice(&agy, true), Some(0));
        assert_eq!(plan_choice(&agy, false), Some(1));
        let perm: Vec<String> = ["Do you want to proceed?", "❯ 1. Yes", "  2. Yes, and don't ask again", "  3. No, and tell Claude what to do differently"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(plan_choice(&perm, true), Some(0));
        assert_eq!(plan_choice(&perm, false), Some(2));
        assert_eq!(plan_choice(&["plain output".to_string()], true), None);
    }

    #[test]
    fn attachment_names() {
        assert_eq!(attachment_file_name("Ảnh chụp màn hình 2026.PNG", "image/png"), "anh-chup-man-hinh-2026.png");
        assert_eq!(attachment_file_name("", "image/jpeg"), "image.jpg");
        let spec = compose_spec("T", "p", "act", &[".localkan/attachments/01-a.png".to_string()], "## Project memory\nUse pnpm.");
        assert!(spec.contains("Use pnpm."));
        assert!(spec.contains("- .localkan/attachments/01-a.png"));
    }

    #[test]
    fn branch_names() {
        assert_eq!(branch_name("3f2a9c1d-aaaa", "Add login page!"), "lk-3f2a9c1d-add-login-page");
        assert_eq!(branch_name("3f2a9c1d-aaaa", "Sửa lỗi đăng nhập"), "lk-3f2a9c1d-sua-loi-dang-nhap");
        assert_eq!(branch_name("3f2a9c1d-aaaa", "!!!"), "lk-3f2a9c1d");
    }
}

/// First non-empty line, cut to `max` characters.
fn first_line(s: &str, max: usize) -> String {
    let line = s.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    if line.chars().count() > max { format!("{}…", line.chars().take(max).collect::<String>()) } else { line.to_string() }
}
