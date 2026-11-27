//! Shared context between cards, kept on this machine as Markdown in the repo's
//! `.localkan/` folder (excluded from git through `.git/info/exclude`, never committed):
//!
//!   .localkan/memory.md            project memory: conventions, stack, decisions (human-edited)
//!   .localkan/handoffs/<date>_<time>_<card>.md   one handoff note per card, written when its
//!                                  agent finishes; the time prefix (local) sorts them in order
//!
//! Every new card's task spec gets the memory, the full note of the card it continues from,
//! and short excerpts of recent notes. The server never stores any of this.

use crate::git;
use crate::protocol::ParentRef;
use anyhow::{Context as _, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// Paths under `.localkan/` that must never be committed.
pub const EXCLUDES: [&str; 5] = [
    ".localkan/memory.md",
    ".localkan/skills/",
    ".localkan/handoffs/",
    ".localkan/handoff.md",
    ".localkan/attachments/",
];

/// The file an agent writes in its worktree before reporting done.
pub const AGENT_HANDOFF_FILE: &str = ".localkan/handoff.md";

/// What a question card (`answer.md`) or a planning card (`plan.json`) produces. The web reads
/// them from the card's diff, so they are never excluded from git; but a repo whose
/// `.gitignore` hides `.localkan/` (agents often add it) would drop them, so the diff adds
/// them back from the worktree.
pub const AGENT_OUTPUT_FILES: [&str; 2] = [".localkan/plan.json", ".localkan/answer.md"];

const MEMORY_MAX_CHARS: usize = 12_000;
const PARENT_MAX_CHARS: usize = 6_000;
const RECENT_NOTES: usize = 8;
const RECENT_NOTE_MAX_CHARS: usize = 1_200;

fn memory_path(repo: &str) -> PathBuf {
    Path::new(repo).join(".localkan").join("memory.md")
}

fn handoffs_dir(repo: &str) -> PathBuf {
    Path::new(repo).join(".localkan").join("handoffs")
}

fn safe_id(card_id: &str) -> String {
    card_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect()
}

/// `2026-11-27_1102_<card>.md`: the note's time (local) first, so a listing sorts in order.
fn handoff_name(card_id: &str, updated_at: &str) -> String {
    let at = chrono::DateTime::parse_from_rfc3339(updated_at)
        .map(|t| t.with_timezone(&chrono::Local))
        .unwrap_or_else(|_| chrono::Local::now());
    format!("{}_{}.md", at.format("%Y-%m-%d_%H%M"), safe_id(card_id))
}

fn has_time_prefix(name: &str) -> bool {
    let b = name.as_bytes();
    b.len() > 16
        && b[..16].iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            10 => *c == b'_',
            15 => *c == b'_',
            _ => c.is_ascii_digit(),
        })
}

/// Notes from before the time prefix (`<card>.md`) get it, from the time written in them.
fn add_time_prefixes(repo: &str) {
    let Ok(rd) = std::fs::read_dir(handoffs_dir(repo)) else { return };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if has_time_prefix(&name) || !name.ends_with(".md") {
            continue;
        }
        let Some(note) = std::fs::read_to_string(e.path()).ok().and_then(|t| parse(&t)) else { continue };
        // Only Localkan's own notes (named after their card), not other files kept there.
        if name != format!("{}.md", safe_id(&note.card_id)) {
            continue;
        }
        let to = handoffs_dir(repo).join(handoff_name(&note.card_id, &note.updated_at));
        if !to.exists() {
            let _ = std::fs::rename(e.path(), to);
        }
    }
}

/// The card's note file, whichever time it carries.
fn handoff_path(repo: &str, card_id: &str) -> Option<PathBuf> {
    add_time_prefixes(repo);
    let tail = format!("_{}.md", safe_id(card_id));
    let rd = std::fs::read_dir(handoffs_dir(repo)).ok()?;
    rd.flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy().ends_with(&tail)))
        .max()
}

pub async fn ensure_excluded(repo: &str) {
    for pattern in EXCLUDES {
        if let Err(e) = git::exclude_locally(repo, pattern).await {
            tracing::warn!("exclude {pattern}: {e:#}");
        }
    }
}

pub fn memory_file(repo: &str) -> String {
    memory_path(repo).to_string_lossy().into_owned()
}

pub fn read_memory(repo: &str) -> String {
    std::fs::read_to_string(memory_path(repo)).unwrap_or_default()
}

pub async fn write_memory(repo: &str, content: &str) -> Result<()> {
    let path = memory_path(repo);
    std::fs::create_dir_all(path.parent().unwrap()).context("không tạo được thư mục .localkan")?;
    ensure_excluded(repo).await;
    std::fs::write(&path, content).with_context(|| format!("không ghi được {}", path.display()))?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffNote {
    pub card_id: String,
    pub title: String,
    pub agent: String,
    pub branch: Option<String>,
    /// in_review | committed | merged | pr | discarded
    pub status: String,
    pub updated_at: String,
    pub content: String,
}

fn one_line(s: &str) -> String {
    s.replace(['\r', '\n'], " ").trim().to_string()
}

fn render(note: &HandoffNote) -> String {
    format!(
        "---\ncard: {}\ntitle: {}\nagent: {}\nbranch: {}\nstatus: {}\nupdated: {}\n---\n\n{}\n",
        note.card_id,
        one_line(&note.title),
        note.agent,
        note.branch.clone().unwrap_or_else(|| "-".into()),
        note.status,
        note.updated_at,
        note.content.trim()
    )
}

fn parse(text: &str) -> Option<HandoffNote> {
    let rest = text.strip_prefix("---\n")?;
    let (head, body) = rest.split_once("\n---\n")?;
    let mut note = HandoffNote {
        card_id: String::new(),
        title: String::new(),
        agent: String::new(),
        branch: None,
        status: "in_review".into(),
        updated_at: String::new(),
        content: body.trim().to_string(),
    };
    for line in head.lines() {
        let Some((k, v)) = line.split_once(':') else { continue };
        let v = v.trim().to_string();
        match k.trim() {
            "card" => note.card_id = v,
            "title" => note.title = v,
            "agent" => note.agent = v,
            "branch" => note.branch = (v != "-" && !v.is_empty()).then_some(v),
            "status" => note.status = v,
            "updated" => note.updated_at = v,
            _ => {}
        }
    }
    (!note.card_id.is_empty()).then_some(note)
}

/// Write the card's note as of now: a new file named with its time, replacing the card's earlier
/// note (a reopened card's new round lands at the end of the listing).
pub async fn write_handoff(repo: &str, note: &HandoffNote) -> Result<()> {
    std::fs::create_dir_all(handoffs_dir(repo)).context("không tạo được thư mục .localkan/handoffs")?;
    ensure_excluded(repo).await;
    let to = handoffs_dir(repo).join(handoff_name(&note.card_id, &note.updated_at));
    if let Some(old) = handoff_path(repo, &note.card_id).filter(|p| *p != to) {
        let _ = std::fs::remove_file(old);
    }
    std::fs::write(to, render(note))?;
    Ok(())
}

pub fn read_handoff(repo: &str, card_id: &str) -> Option<HandoffNote> {
    std::fs::read_to_string(handoff_path(repo, card_id)?).ok().and_then(|t| parse(&t))
}

/// Record how the card ended (committed, merged, PR, discarded), in the same file: the name keeps
/// the time the agent finished.
pub async fn set_status(repo: &str, card_id: &str, status: &str, now: &str) -> Result<()> {
    let Some(path) = handoff_path(repo, card_id) else { return Ok(()) };
    if let Some(mut note) = std::fs::read_to_string(&path).ok().and_then(|t| parse(&t)) {
        note.status = status.to_string();
        note.updated_at = now.to_string();
        std::fs::write(path, render(&note))?;
    }
    Ok(())
}

/// All notes of the repo, newest first.
pub fn list_handoffs(repo: &str) -> Vec<HandoffNote> {
    add_time_prefixes(repo);
    let mut notes: Vec<HandoffNote> = std::fs::read_dir(handoffs_dir(repo))
        .map(|it| {
            it.filter_map(|e| e.ok())
                .filter(|e| e.path().extension().is_some_and(|x| x == "md"))
                .filter_map(|e| std::fs::read_to_string(e.path()).ok())
                .filter_map(|t| parse(&t))
                .collect()
        })
        .unwrap_or_default();
    notes.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    notes
}

fn clip(text: &str, max: usize) -> String {
    let t = text.trim();
    if t.chars().count() <= max {
        return t.to_string();
    }
    let cut: String = t.chars().take(max).collect();
    format!("{cut}…")
}

fn status_label(status: &str) -> &'static str {
    match status {
        "merged" => "merged into the base branch",
        "committed" => "committed on its own branch (not merged)",
        "pr" => "pull request opened (not merged)",
        "discarded" => "discarded",
        _ => "awaiting review",
    }
}

/// The "project context" section of a task spec. Empty when there is nothing to share.
pub fn compose_context(repo: &str, card_id: &str, parent: Option<&ParentRef>) -> String {
    let mut out = String::new();

    let memory = read_memory(repo);
    if !memory.trim().is_empty() {
        out.push_str("## Project memory (from the reviewer; follow it)\n\n");
        out.push_str(&clip(&memory, MEMORY_MAX_CHARS));
        out.push_str("\n\n");
    }

    if let Some(p) = parent {
        out.push_str(&format!("## This task continues the earlier task \"{}\"\n\n", one_line(&p.title)));
        match read_handoff(repo, &p.card_id) {
            Some(note) => {
                out.push_str(&format!("Status: {}.", status_label(&note.status)));
                if let Some(b) = &note.branch {
                    out.push_str(&format!(" Branch: {b}."));
                }
                out.push_str(" Its handoff note:\n\n");
                out.push_str(&clip(&note.content, PARENT_MAX_CHARS));
                out.push_str("\n\n");
            }
            None => out.push_str("No handoff note was recorded for it; read its changes in the code.\n\n"),
        }
    }

    let recent: Vec<HandoffNote> = list_handoffs(repo)
        .into_iter()
        .filter(|n| n.card_id != card_id && n.status != "discarded")
        .filter(|n| parent.is_none_or(|p| p.card_id != n.card_id))
        .take(RECENT_NOTES)
        .collect();
    if !recent.is_empty() {
        out.push_str("## Recent work on this project (handoff notes of earlier tasks, newest first)\n\n");
        for n in recent {
            out.push_str(&format!("### {} — {}\n{}\n\n", one_line(&n.title), status_label(&n.status), clip(&n.content, RECENT_NOTE_MAX_CHARS)));
        }
    }
    out.trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handoff_round_trip() {
        let note = HandoffNote {
            card_id: "abc-123".into(),
            title: "Thêm trang: đăng nhập\nmới".into(),
            agent: "claude".into(),
            branch: Some("lk-abc".into()),
            status: "in_review".into(),
            updated_at: "2026-11-13T10:00:00Z".into(),
            content: "- Đã thêm form\n- Dùng zod".into(),
        };
        let parsed = parse(&render(&note)).unwrap();
        assert_eq!(parsed.card_id, "abc-123");
        assert_eq!(parsed.title, "Thêm trang: đăng nhập mới");
        assert_eq!(parsed.branch.as_deref(), Some("lk-abc"));
        assert_eq!(parsed.content, "- Đã thêm form\n- Dùng zod");
    }

    #[test]
    fn context_includes_memory_parent_and_recent() {
        let dir = std::env::temp_dir().join(format!("lk-ctx-{}", std::process::id()));
        let repo = dir.to_string_lossy().to_string();
        std::fs::create_dir_all(dir.join(".localkan/handoffs")).unwrap();
        std::fs::write(dir.join(".localkan/memory.md"), "Use pnpm.").unwrap();
        let mk = |id: &str, status: &str, t: &str| HandoffNote {
            card_id: id.into(),
            title: format!("Task {id}"),
            agent: "claude".into(),
            branch: Some(format!("lk-{id}")),
            status: status.into(),
            updated_at: t.into(),
            content: format!("did {id}"),
        };
        // Written the old way (`<card>.md`): read through the renaming to `<time>_<card>.md`.
        for n in [mk("a", "merged", "1"), mk("b", "discarded", "2"), mk("c", "committed", "3")] {
            std::fs::write(dir.join(format!(".localkan/handoffs/{}.md", n.card_id)), render(&n)).unwrap();
        }
        let parent = ParentRef { card_id: "c".into(), title: "Task c".into(), branch: Some("lk-c".into()) };
        let ctx = compose_context(&repo, "new", Some(&parent));
        assert!(ctx.contains("Use pnpm."));
        assert!(ctx.contains("continues the earlier task \"Task c\""));
        assert!(ctx.contains("did a"));
        assert!(!ctx.contains("did b"), "discarded notes are left out");
        assert_eq!(ctx.matches("did c").count(), 1, "parent is not repeated in recent notes");
        std::fs::remove_dir_all(dir).ok();
    }

    #[tokio::test]
    async fn handoff_files_sort_by_time() {
        let dir = std::env::temp_dir().join(format!("lk-handoff-names-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let repo = dir.to_string_lossy().to_string();
        std::fs::create_dir_all(dir.join(".localkan/handoffs")).unwrap();
        let note = |id: &str, t: &str| HandoffNote {
            card_id: id.into(),
            title: format!("Task {id}"),
            agent: "claude".into(),
            branch: None,
            status: "in_review".into(),
            updated_at: t.into(),
            content: format!("did {id}"),
        };
        let names = || {
            let mut v: Vec<String> = std::fs::read_dir(dir.join(".localkan/handoffs")).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
            v.sort();
            v
        };
        let local = |t: &str| chrono::DateTime::parse_from_rfc3339(t).unwrap().with_timezone(&chrono::Local).format("%Y-%m-%d_%H%M").to_string();
        // An old note named after its card gets the time prefix; other files stay as they are.
        std::fs::write(dir.join(".localkan/handoffs/old-1.md"), render(&note("old-1", "2026-11-10T09:00:00Z"))).unwrap();
        std::fs::write(dir.join(".localkan/handoffs/README.md"), "notes").unwrap();
        write_handoff(&repo, &note("new-2", "2026-11-27T04:02:00Z")).await.unwrap();
        assert_eq!(names(), [format!("{}_old-1.md", local("2026-11-10T09:00:00Z")), format!("{}_new-2.md", local("2026-11-27T04:02:00Z")), "README.md".to_string()]);
        // A status change keeps the name; a new note for the card replaces it with the new time.
        set_status(&repo, "new-2", "merged", "2026-11-28T01:00:00Z").await.unwrap();
        assert_eq!(read_handoff(&repo, "new-2").unwrap().status, "merged");
        assert!(names().contains(&format!("{}_new-2.md", local("2026-11-27T04:02:00Z"))));
        write_handoff(&repo, &note("new-2", "2026-11-29T05:00:00Z")).await.unwrap();
        let n = names();
        assert_eq!(n.iter().filter(|x| x.ends_with("_new-2.md")).count(), 1);
        assert!(n.contains(&format!("{}_new-2.md", local("2026-11-29T05:00:00Z"))));
        assert_eq!(list_handoffs(&repo).len(), 2);
        std::fs::remove_dir_all(dir).ok();
    }
}
