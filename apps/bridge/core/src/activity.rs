//! What the agent is doing, step by step, for the card's log: the files it reads and edits,
//! the commands it runs and what it says, read from the agent CLI's session record (the same
//! files `usage` reads) instead of its terminal screen, which a full-screen TUI redraws.
//!
//! - Claude Code: `~/.claude/projects/<folder>/<session>.jsonl`, one content block per line
//!   (`text`, `tool_use` with the tool's input).
//! - Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` whose first line names the folder;
//!   `response_item` lines hold the assistant's messages and its tool calls.
//!
//! Each poll reads only what was appended since the last one (byte offsets per file, kept on
//! the card so a bridge restart does not repeat lines).

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde_json::Value;

use crate::redact::redact_line;
use crate::usage::{claude_folder, claude_home, codex_home};

/// Longest text of one log line.
const MAX_LINE: usize = 240;
/// At most this many steps per poll; older ones are summed up in one line.
const MAX_STEPS: usize = 150;

/// New steps of the agent working in `cwd`, as log lines. `offsets` (file path -> bytes
/// read) is updated in place.
pub fn read_new(agent: &str, cwd: &Path, offsets: &mut HashMap<String, u64>) -> Vec<String> {
    let files = match agent {
        "claude" => claude_files(cwd),
        "codex" => codex_files(cwd),
        _ => return Vec::new(),
    };
    let cx = Cx { cwd };
    let mut out = Vec::new();
    for f in files {
        let key = f.to_string_lossy().to_string();
        let from = offsets.get(&key).copied().unwrap_or(0);
        let Some((text, upto)) = read_from(&f, from) else { continue };
        offsets.insert(key, upto);
        for line in text.lines() {
            let steps = if agent == "claude" { claude_steps(line, &cx) } else { codex_steps(line, &cx) };
            out.extend(steps);
        }
    }
    if out.len() > MAX_STEPS {
        let skipped = out.len() - MAX_STEPS;
        out.drain(..skipped);
        out.insert(0, format!("… {skipped} bước trước đó không hiện"));
    }
    out.into_iter().map(|l| redact_line(&clip(&l))).collect()
}

/// Text appended to `path` after byte `from`, up to the last complete line, and the new offset.
/// A file shorter than `from` was replaced: read it again from the start.
fn read_from(path: &Path, from: u64) -> Option<(String, u64)> {
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let from = if from > len { 0 } else { from };
    if from == len {
        return None;
    }
    f.seek(SeekFrom::Start(from)).ok()?;
    let mut buf = Vec::with_capacity((len - from) as usize);
    f.take(len - from).read_to_end(&mut buf).ok()?;
    let end = buf.iter().rposition(|b| *b == b'\n')? + 1;
    buf.truncate(end);
    Some((String::from_utf8_lossy(&buf).into_owned(), from + end as u64))
}

fn clip(s: &str) -> String {
    let one: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() <= MAX_LINE {
        return one;
    }
    format!("{}…", one.chars().take(MAX_LINE).collect::<String>())
}

/// The card's worktree, to shorten what is shown.
struct Cx<'a> {
    cwd: &'a Path,
}

impl Cx<'_> {
    /// What the agent says, with worktree paths made relative.
    fn said(&self, text: &str) -> String {
        let root = self.cwd.to_string_lossy();
        format!("💬 {}", text.replace(&format!("{root}/"), "").replace(root.as_ref(), "."))
    }

    /// `path` relative to the worktree when inside it.
    fn rel(&self, path: &str) -> String {
        Path::new(path).strip_prefix(self.cwd).map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|_| path.to_string())
    }

    /// A shell command as a log line: its first line (a heredoc's body is not news), without
    /// the `cd <worktree>` agents put first and with worktree paths made relative. None for
    /// Orca's own reporting commands (heartbeats, questions, "done"): the log has its own
    /// lines for those, and they carry the dispatch's credentials.
    fn command(&self, cmd: &str) -> Option<String> {
        // Only the first line is shown, so only it decides.
        let first = cmd.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
        if first.contains("orca orchestration") || first.contains("dispatch-capability") {
            return None;
        }
        let more = cmd.trim().lines().count() > 1;
        let root = self.cwd.to_string_lossy();
        let mut c = first.to_string();
        for sep in ["; ", " && ", ";", "&&"] {
            for cd in [format!("cd {root}{sep}"), format!("cd \"{root}\"{sep}"), format!("cd '{root}'{sep}")] {
                if let Some(rest) = c.strip_prefix(&cd) {
                    c = rest.trim_start().to_string();
                }
            }
        }
        if c.is_empty() || c == format!("cd {root}") {
            return None;
        }
        let c = c.replace(&format!("{root}/"), "").replace(root.as_ref(), ".");
        Some(if more { format!("$ {c} …") } else { format!("$ {c}") })
    }
}

// -- Claude Code -------------------------------------------------------------------

fn claude_files(cwd: &Path) -> Vec<PathBuf> {
    let dir = claude_home().join("projects").join(claude_folder(cwd));
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    // Main sessions only: subagents (in `<session>/subagents/`) report back to them.
    let mut files: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "jsonl")).collect();
    files.sort();
    files
}

fn claude_steps(line: &str, cx: &Cx) -> Vec<String> {
    if !line.contains("\"assistant\"") {
        return Vec::new();
    }
    let Ok(v) = serde_json::from_str::<Value>(line) else { return Vec::new() };
    if v["type"].as_str() != Some("assistant") {
        return Vec::new();
    }
    let mut out = Vec::new();
    for b in v["message"]["content"].as_array().into_iter().flatten() {
        match b["type"].as_str() {
            Some("text") => {
                let t = b["text"].as_str().unwrap_or("").trim();
                if !t.is_empty() {
                    out.push(cx.said(t));
                }
            }
            Some("tool_use") => {
                if let Some(s) = claude_tool(b["name"].as_str().unwrap_or(""), &b["input"], cx) {
                    out.push(s);
                }
            }
            _ => {}
        }
    }
    out
}

fn claude_tool(name: &str, i: &Value, cx: &Cx) -> Option<String> {
    let st = |k: &str| i[k].as_str().unwrap_or("").to_string();
    let rel = |p: &str| cx.rel(p);
    let path = || rel(&st("file_path"));
    Some(match name {
        "Bash" => return cx.command(&st("command")),
        "Monitor" => format!("⏱ Theo dõi: {}", if st("description").is_empty() { cx.command(&st("command")).unwrap_or_default() } else { st("description") }),
        "Read" => format!("📖 Đọc {}", path()),
        "Edit" | "MultiEdit" => format!("✏️ Sửa {}", path()),
        "Write" => format!("📝 Ghi {}", path()),
        "NotebookEdit" => format!("✏️ Sửa {}", rel(&st("notebook_path"))),
        "Grep" => {
            let place = st("path");
            if place.is_empty() { format!("🔎 Tìm \"{}\"", st("pattern")) } else { format!("🔎 Tìm \"{}\" trong {}", st("pattern"), rel(&place)) }
        }
        "Glob" => format!("🔎 Tìm file {}", st("pattern")),
        "Agent" | "Task" => format!("🤖 Giao subagent: {}", st("description")),
        "WebFetch" => format!("🌐 Mở {}", st("url")),
        "WebSearch" => format!("🌐 Tìm trên web: {}", st("query")),
        "TodoWrite" => {
            let todos = i["todos"].as_array().cloned().unwrap_or_default();
            let done = todos.iter().filter(|t| t["status"].as_str() == Some("completed")).count();
            let now = todos.iter().find(|t| t["status"].as_str() == Some("in_progress")).and_then(|t| t["content"].as_str());
            match now {
                Some(n) => format!("☑ Việc {done}/{} xong · đang làm: {n}", todos.len()),
                None => format!("☑ Việc {done}/{} xong", todos.len()),
            }
        }
        // Loading tool definitions is bookkeeping, not progress.
        "ToolSearch" => return None,
        "" => return None,
        other => format!("🔧 {other}"),
    })
}

// -- Codex ---------------------------------------------------------------------------

/// Today's and the two days before: a running session writes to the folder of the day it began.
fn codex_files(cwd: &Path) -> Vec<PathBuf> {
    static CWD: OnceLock<Mutex<HashMap<PathBuf, Option<String>>>> = OnceLock::new();
    let cache = CWD.get_or_init(|| Mutex::new(HashMap::new()));
    let root = codex_home().join("sessions");
    let today = chrono::Local::now().date_naive();
    let mut out = Vec::new();
    for d in 0..3 {
        let day = today - chrono::Duration::days(d);
        let dir = root.join(day.format("%Y/%m/%d").to_string());
        let Ok(rd) = std::fs::read_dir(dir) else { continue };
        for p in rd.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "jsonl")) {
            let known = cache.lock().ok().and_then(|c| c.get(&p).cloned());
            let dir = match known {
                Some(d) => d,
                None => {
                    let first = std::fs::read_to_string(&p).ok().and_then(|t| t.lines().next().map(str::to_string));
                    let d = first.and_then(|l| serde_json::from_str::<Value>(&l).ok()).and_then(|v| v["payload"]["cwd"].as_str().map(str::to_string));
                    if let Ok(mut c) = cache.lock() {
                        c.insert(p.clone(), d.clone());
                    }
                    d
                }
            };
            if dir.is_some_and(|d| Path::new(&d) == cwd || Path::new(&d).starts_with(cwd)) {
                out.push(p);
            }
        }
    }
    out.sort();
    out
}

fn codex_steps(line: &str, cx: &Cx) -> Vec<String> {
    if !line.contains("\"response_item\"") {
        return Vec::new();
    }
    let Ok(v) = serde_json::from_str::<Value>(line) else { return Vec::new() };
    let p = &v["payload"];
    match p["type"].as_str().unwrap_or("") {
        "message" if p["role"].as_str() == Some("assistant") => p["content"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|c| c["text"].as_str())
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(|t| cx.said(t))
            .collect(),
        // Newer Codex runs its tools from a small script: `tools.exec_command({cmd: "…"})`.
        "custom_tool_call" | "function_call" => {
            let name = p["name"].as_str().unwrap_or("");
            let input = p["input"].as_str().or_else(|| p["arguments"].as_str()).unwrap_or("");
            codex_tool(name, input, cx)
        }
        _ => Vec::new(),
    }
}

fn codex_tool(name: &str, input: &str, cx: &Cx) -> Vec<String> {
    use regex::Regex;
    static CMD: OnceLock<Regex> = OnceLock::new();
    static FILE: OnceLock<Regex> = OnceLock::new();
    let mut out = Vec::new();
    // Files of a patch: `*** Update File: path`, `*** Add File: …`, `*** Delete File: …`.
    let file = FILE.get_or_init(|| Regex::new(r"\*\*\* (Update|Add|Delete) File: ([^\n\\]+)").expect("regex"));
    for c in file.captures_iter(input) {
        let path = cx.rel(c[2].trim());
        out.push(match &c[1] {
            "Add" => format!("📝 Ghi {path}"),
            "Delete" => format!("🗑 Xóa {path}"),
            _ => format!("✏️ Sửa {path}"),
        });
    }
    if name == "exec_command" || name == "shell" {
        // `{"cmd": "…"}` or `{"command": ["bash", "-lc", "…"]}`.
        if let Ok(v) = serde_json::from_str::<Value>(input) {
            let cmd = v["cmd"]
                .as_str()
                .map(str::to_string)
                .or_else(|| v["command"].as_array().and_then(|a| a.last()).and_then(Value::as_str).map(str::to_string))
                .or_else(|| v["command"].as_str().map(str::to_string));
            if let Some(c) = cmd.and_then(|c| cx.command(&c)) {
                out.push(c);
            }
        }
        return out;
    }
    let cmd = CMD.get_or_init(|| Regex::new(r#"\bcmd\s*:\s*"((?:[^"\\]|\\.)*)""#).expect("regex"));
    for c in cmd.captures_iter(input) {
        let text = serde_json::from_str::<String>(&format!("\"{}\"", &c[1])).unwrap_or_else(|_| c[1].to_string());
        out.extend(cx.command(&text));
    }
    if out.is_empty() && !name.is_empty() && name != "exec" {
        out.push(format!("🔧 {name}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cx() -> Cx<'static> {
        Cx { cwd: Path::new("/wt/a") }
    }

    #[test]
    fn claude_steps_read_well() {
        let tool = |name: &str, input: &str| format!(r#"{{"type":"assistant","message":{{"content":[{{"type":"tool_use","name":"{name}","input":{input}}}]}}}}"#);
        assert_eq!(claude_steps(&tool("Read", r#"{"file_path":"/wt/a/src/x.ts"}"#), &cx()), ["📖 Đọc src/x.ts"]);
        assert_eq!(claude_steps(&tool("Edit", r#"{"file_path":"/wt/a/src/x.ts","old_string":"a","new_string":"b"}"#), &cx()), ["✏️ Sửa src/x.ts"]);
        assert_eq!(claude_steps(&tool("Bash", r#"{"command":"cat > a.txt <<'EOF'\nsecret body\nEOF"}"#), &cx()), ["$ cat > a.txt <<'EOF' …"]);
        assert_eq!(claude_steps(&tool("Grep", r#"{"pattern":"TODO","path":"/wt/a/src"}"#), &cx()), ["🔎 Tìm \"TODO\" trong src"]);
        assert!(claude_steps(&tool("ToolSearch", r#"{"query":"x"}"#), &cx()).is_empty());
        assert_eq!(claude_steps(&tool("Bash", r#"{"command":"cd /wt/a; cat /wt/a/src/x.ts | head"}"#), &cx()), ["$ cat src/x.ts | head"]);
        assert_eq!(claude_steps(&tool("Bash", r#"{"command":"cd /wt/a && pnpm test"}"#), &cx()), ["$ pnpm test"]);
        let orca = r#"{"command":"orca orchestration send --from t --dispatch-capability dcap_x --type heartbeat"}"#;
        assert!(claude_steps(&tool("Bash", orca), &cx()).is_empty(), "Orca's own reporting is not shown");
        let both = r#"{"command":"cd /wt/a; cat > .localkan/plan.json <<'EOF'\n{}\nEOF\norca orchestration send --dispatch-capability dcap_x"}"#;
        assert_eq!(claude_steps(&tool("Bash", both), &cx()), ["$ cat > .localkan/plan.json <<'EOF' …"]);
        let text = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Đã sửa xong, chạy test."}]}}"#;
        assert_eq!(claude_steps(text, &cx()), ["💬 Đã sửa xong, chạy test."]);
        assert!(claude_steps(r#"{"type":"user","message":{"content":"assistant"}}"#, &cx()).is_empty());
    }

    #[test]
    fn codex_steps_read_well() {
        let exec = r#"{"type":"response_item","payload":{"type":"custom_tool_call","name":"exec","input":"const r = await tools.exec_command({cmd:\"pwd && git status --short\",yield_time_ms:10});\nawait tools.exec_command({cmd: \"pnpm test\"})"}}"#;
        assert_eq!(codex_steps(exec, &cx()), ["$ pwd && git status --short", "$ pnpm test"]);
        let patch = r#"{"type":"response_item","payload":{"type":"custom_tool_call","name":"apply_patch","input":"*** Begin Patch\n*** Update File: /wt/a/src/x.ts\n@@\n-a\n+b\n*** Add File: docs/n.md\n+hi\n*** End Patch"}}"#;
        assert_eq!(codex_steps(patch, &cx()), ["✏️ Sửa src/x.ts", "📝 Ghi docs/n.md"]);
        let fc = r#"{"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\"command\":[\"bash\",\"-lc\",\"ls -la\"]}"}}"#;
        assert_eq!(codex_steps(fc, &cx()), ["$ ls -la"]);
        let msg = r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"I'll check the diff."}]}}"#;
        assert_eq!(codex_steps(msg, &cx()), ["💬 I'll check the diff."]);
    }

    #[test]
    fn reads_only_new_complete_lines() {
        let d = std::env::temp_dir().join(format!("lk-activity-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let f = d.join("s.jsonl");
        std::fs::write(&f, "one\ntwo\npart").unwrap();
        let (t, o) = read_from(&f, 0).unwrap();
        assert_eq!((t.as_str(), o), ("one\ntwo\n", 8));
        assert!(read_from(&f, 8).is_none(), "an unfinished line waits");
        std::fs::write(&f, "one\ntwo\npartial\n").unwrap();
        assert_eq!(read_from(&f, 8).unwrap().0, "partial\n");
        std::fs::write(&f, "new\n").unwrap();
        assert_eq!(read_from(&f, 16).unwrap().0, "new\n", "a replaced file is read again");
        let _ = std::fs::remove_dir_all(&d);
    }
}
