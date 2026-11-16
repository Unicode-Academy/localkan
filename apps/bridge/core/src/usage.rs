//! What a card's agent spent: token counts per model, read from the agent CLI's own record
//! of the sessions it ran in the card's worktree.
//!
//! - Claude Code writes every model call to `~/.claude/projects/<folder>/*.jsonl` (subagents
//!   under `<session>/subagents/`), one folder per working directory.
//! - Codex writes `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`; the first line names the
//!   working directory, `token_usage_record` lines carry each call's tokens.
//! - Grok keeps sessions under `~/.grok/sessions/<url-encoded folder>/<id>/` and reports a
//!   session's tokens and cost with `grok usage <id>`.
//! - Antigravity keeps no record we can read: its cards are marked `unsupported`.
//!
//! Prices are not applied here: the web turns tokens into dollars, so a price change needs
//! no new bridge. Records survive the worktree, so a finished card can still be measured.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::paths;

/// Tokens of one model at one price tier.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageBucket {
    /// Model id as the CLI recorded it (`claude-opus-5-5`, `gpt-6-luna`, `grok-4.7`).
    pub model: String,
    /// "standard", "long" (prompt above the provider's long-context threshold) or "fast".
    pub tier: String,
    pub requests: u64,
    /// Input tokens not served from the cache.
    pub input: u64,
    pub cache_read: u64,
    /// Written to the short-lived cache (Claude 5 minutes, OpenAI 30 minutes).
    pub cache_write: u64,
    /// Written to the long-lived cache (Claude 1 hour, OpenAI 12 hours).
    pub cache_write_long: u64,
    /// Output tokens, reasoning included.
    pub output: u64,
    /// Cost the CLI reported itself (Grok); otherwise the web prices the tokens.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardUsage {
    pub agent: String,
    pub buckets: Vec<UsageBucket>,
    /// Agent sessions found for the card.
    pub sessions: u32,
    /// The agent keeps no record of its usage that can be read.
    #[serde(default)]
    pub unsupported: bool,
}

/// Claude bills prompts above this (Haiku 5.5) at its long-context rate.
const CLAUDE_LONG: u64 = 100_000;
/// OpenAI bills prompts above this at its long-context rate.
const OPENAI_LONG: u64 = 272_000;
/// Codex session folders are per day; a card older than this is not looked for.
const CODEX_DAYS: i64 = 60;

/// One model call, as counted.
#[derive(Debug, Clone, Default)]
struct Call {
    /// Same call seen twice (a resumed session repeats its history) counts once.
    key: String,
    model: String,
    tier: &'static str,
    input: u64,
    cache_read: u64,
    cache_write: u64,
    cache_write_long: u64,
    output: u64,
}

#[derive(Default)]
struct Acc {
    buckets: BTreeMap<(String, String), UsageBucket>,
    seen: HashSet<String>,
}

impl Acc {
    fn add(&mut self, c: &Call) {
        if !c.key.is_empty() && !self.seen.insert(c.key.clone()) {
            return;
        }
        let b = self.buckets.entry((c.model.clone(), c.tier.to_string())).or_insert_with(|| UsageBucket {
            model: c.model.clone(),
            tier: c.tier.to_string(),
            ..Default::default()
        });
        b.requests += 1;
        b.input += c.input;
        b.cache_read += c.cache_read;
        b.cache_write += c.cache_write;
        b.cache_write_long += c.cache_write_long;
        b.output += c.output;
    }

    fn add_bucket(&mut self, b: UsageBucket) {
        let e = self.buckets.entry((b.model.clone(), b.tier.clone())).or_insert_with(|| UsageBucket {
            model: b.model.clone(),
            tier: b.tier.clone(),
            ..Default::default()
        });
        e.requests += b.requests;
        e.input += b.input;
        e.cache_read += b.cache_read;
        e.cache_write += b.cache_write;
        e.cache_write_long += b.cache_write_long;
        e.output += b.output;
        e.cost_usd = match (e.cost_usd, b.cost_usd) {
            (None, None) => None,
            (a, b) => Some(a.unwrap_or(0.0) + b.unwrap_or(0.0)),
        };
    }
}

/// What the card's agent spent in `cwd` (its worktree or multi-repo task folder).
pub async fn read(agent: &str, cwd: &Path) -> CardUsage {
    let cwd = cwd.to_path_buf();
    let mut usage = CardUsage { agent: agent.to_string(), ..Default::default() };
    match agent {
        "claude" | "codex" => {
            let agent = agent.to_string();
            let found = tokio::task::spawn_blocking(move || {
                let mut acc = Acc::default();
                let n = if agent == "claude" { claude(&cwd, &mut acc) } else { codex(&cwd, &mut acc) };
                (n, acc)
            })
            .await;
            if let Ok((n, acc)) = found {
                usage.sessions = n;
                usage.buckets = acc.buckets.into_values().collect();
            }
        }
        "grok" => {
            let (n, acc) = grok(&cwd).await;
            usage.sessions = n;
            usage.buckets = acc.buckets.into_values().collect();
        }
        _ => usage.unsupported = true,
    }
    usage
}

// -- shared ----------------------------------------------------------------------

fn num(v: &Value) -> u64 {
    v.as_u64().or_else(|| v.as_f64().map(|f| f.max(0.0) as u64)).unwrap_or(0)
}

/// Parsed calls of one session file, kept until the file changes.
struct Parsed {
    stamp: (SystemTime, u64),
    /// Working directory the file belongs to (Codex), when known.
    cwd: Option<String>,
    calls: Vec<Call>,
}

fn cache() -> &'static Mutex<HashMap<PathBuf, Parsed>> {
    static C: OnceLock<Mutex<HashMap<PathBuf, Parsed>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

fn stamp(p: &Path) -> Option<(SystemTime, u64)> {
    let m = std::fs::metadata(p).ok()?;
    Some((m.modified().ok()?, m.len()))
}

/// Calls of a session file, parsed once per version of the file.
fn calls_of(path: &Path, parse: impl FnOnce(&str) -> (Option<String>, Vec<Call>)) -> Option<(Option<String>, Vec<Call>)> {
    let st = stamp(path)?;
    if let Some(p) = cache().lock().ok()?.get(path).filter(|p| p.stamp == st) {
        return Some((p.cwd.clone(), p.calls.clone()));
    }
    let text = std::fs::read_to_string(path).ok()?;
    let (cwd, calls) = parse(&text);
    if let Ok(mut c) = cache().lock() {
        c.insert(path.to_path_buf(), Parsed { stamp: st, cwd: cwd.clone(), calls: calls.clone() });
    }
    Some((cwd, calls))
}

fn jsonl_files(dir: &Path, out: &mut Vec<PathBuf>, depth: u32) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            if depth > 0 {
                jsonl_files(&p, out, depth - 1);
            }
        } else if p.extension().is_some_and(|x| x == "jsonl") {
            out.push(p);
        }
    }
}

fn same_or_inside(dir: &str, cwd: &Path) -> bool {
    let d = Path::new(dir);
    d == cwd || d.starts_with(cwd)
}

// -- Claude Code -------------------------------------------------------------------

/// Claude Code's folder name for a working directory: every character other than a letter
/// or digit becomes `-`.
pub fn claude_folder(cwd: &Path) -> String {
    cwd.to_string_lossy().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

fn claude_home() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from).unwrap_or_else(|| paths::home().join(".claude"))
}

fn claude(cwd: &Path, acc: &mut Acc) -> u32 {
    let dir = claude_home().join("projects").join(claude_folder(cwd));
    let mut files = Vec::new();
    jsonl_files(&dir, &mut files, 3);
    files.sort();
    let mut sessions = 0;
    for f in &files {
        let Some((_, calls)) = calls_of(f, |t| (None, parse_claude(t))) else { continue };
        // Subagent transcripts belong to their parent session.
        if !f.components().any(|c| c.as_os_str() == "subagents") && !calls.is_empty() {
            sessions += 1;
        }
        for c in &calls {
            acc.add(c);
        }
    }
    sessions
}

fn parse_claude(text: &str) -> Vec<Call> {
    let mut out = Vec::new();
    for line in text.lines() {
        if !line.contains("\"usage\"") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if v["type"].as_str() != Some("assistant") {
            continue;
        }
        let m = &v["message"];
        let u = &m["usage"];
        let model = m["model"].as_str().unwrap_or("");
        if !u.is_object() || model.is_empty() || model.starts_with('<') {
            continue;
        }
        let cc = &u["cache_creation"];
        let (write, write_long) = if cc.is_object() {
            (num(&cc["ephemeral_5m_input_tokens"]), num(&cc["ephemeral_1h_input_tokens"]))
        } else {
            (num(&u["cache_creation_input_tokens"]), 0)
        };
        let input = num(&u["input_tokens"]);
        let read = num(&u["cache_read_input_tokens"]);
        let tier = if u["speed"].as_str() == Some("fast") {
            "fast"
        } else if input + read + write + write_long > CLAUDE_LONG {
            "long"
        } else {
            "standard"
        };
        // A streamed reply is written as several lines carrying the same message and usage.
        let key = format!("c:{}:{}", m["id"].as_str().unwrap_or(""), v["requestId"].as_str().unwrap_or(""));
        out.push(Call {
            key,
            model: model.to_string(),
            tier,
            input,
            cache_read: read,
            cache_write: write,
            cache_write_long: write_long,
            output: num(&u["output_tokens"]),
        });
    }
    out
}

// -- Codex ---------------------------------------------------------------------------

fn codex_home() -> PathBuf {
    std::env::var_os("CODEX_HOME").map(PathBuf::from).unwrap_or_else(|| paths::home().join(".codex"))
}

fn codex(cwd: &Path, acc: &mut Acc) -> u32 {
    let root = codex_home().join("sessions");
    let today = chrono::Local::now().date_naive();
    let mut files = Vec::new();
    for d in 0..=CODEX_DAYS {
        let day = today - chrono::Duration::days(d);
        let dir = root.join(day.format("%Y").to_string()).join(day.format("%m").to_string()).join(day.format("%d").to_string());
        jsonl_files(&dir, &mut files, 0);
    }
    files.sort();
    let mut sessions = 0;
    for f in &files {
        let Some((Some(dir), calls)) = calls_of(f, parse_codex) else { continue };
        if !same_or_inside(&dir, cwd) {
            continue;
        }
        sessions += 1;
        for c in &calls {
            acc.add(c);
        }
    }
    sessions
}

/// The session's working directory and its calls. Each `token_usage_record` is one model
/// call; files written before those records existed fall back to the session total.
fn parse_codex(text: &str) -> (Option<String>, Vec<Call>) {
    let mut cwd = None;
    let mut model = String::new();
    let mut calls = Vec::new();
    let mut total: Option<Value> = None;
    for (i, line) in text.lines().enumerate() {
        // Only the lines below matter; skip the rest without parsing them.
        if i > 0 && !(line.contains("token_usage_record") || line.contains("turn_context") || line.contains("token_count")) {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        let p = &v["payload"];
        match v["type"].as_str().unwrap_or("") {
            "session_meta" => cwd = p["cwd"].as_str().map(str::to_string),
            "turn_context" => {
                if let Some(m) = p["model"].as_str() {
                    model = m.to_string();
                }
            }
            "token_usage_record" => {
                let key = format!("x:{}", p["response_id"].as_str().unwrap_or(""));
                calls.push(codex_call(&p["usage"], &model, key));
            }
            "event_msg" if p["type"].as_str() == Some("token_count") => {
                if p["info"]["total_token_usage"].is_object() {
                    total = Some(p["info"]["total_token_usage"].clone());
                }
            }
            _ => {}
        }
    }
    if calls.is_empty() {
        if let Some(t) = total {
            calls.push(codex_call(&t, &model, String::new()));
        }
    }
    (cwd, calls)
}

/// OpenAI counts cached and cache-write tokens inside `input_tokens`, and reasoning inside
/// `output_tokens`.
fn codex_call(u: &Value, model: &str, key: String) -> Call {
    let input = num(&u["input_tokens"]);
    let read = num(&u["cached_input_tokens"]);
    let write = num(&u["cache_write_input_tokens"]);
    Call {
        key,
        model: if model.is_empty() { "codex".into() } else { model.to_string() },
        tier: if input > OPENAI_LONG { "long" } else { "standard" },
        input: input.saturating_sub(read + write),
        cache_read: read,
        cache_write: write,
        cache_write_long: 0,
        output: num(&u["output_tokens"]),
    }
}

// -- Grok ----------------------------------------------------------------------------

fn grok_home() -> PathBuf {
    std::env::var_os("GROK_HOME").map(PathBuf::from).unwrap_or_else(|| paths::home().join(".grok"))
}

fn percent_decode(s: &str) -> String {
    let hex = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `grok usage <id>` per session, cached while the session folder is unchanged.
fn grok_cache() -> &'static Mutex<HashMap<PathBuf, ((SystemTime, u64), Vec<UsageBucket>)>> {
    static C: OnceLock<Mutex<HashMap<PathBuf, ((SystemTime, u64), Vec<UsageBucket>)>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

async fn grok(cwd: &Path) -> (u32, Acc) {
    let mut acc = Acc::default();
    let root = grok_home().join("sessions");
    let Ok(rd) = std::fs::read_dir(&root) else { return (0, acc) };
    let mut sessions = Vec::new();
    for e in rd.flatten() {
        let dir = percent_decode(&e.file_name().to_string_lossy());
        if !e.path().is_dir() || !same_or_inside(&dir, cwd) {
            continue;
        }
        if let Ok(inner) = std::fs::read_dir(e.path()) {
            sessions.extend(inner.flatten().map(|s| s.path()).filter(|p| p.is_dir()));
        }
    }
    let Some(bin) = paths::which("grok") else { return (0, acc) };
    let mut n = 0;
    for s in sessions {
        let Some(id) = s.file_name().map(|x| x.to_string_lossy().to_string()) else { continue };
        if !crate::models::valid_id(&id) {
            continue;
        }
        // The session changes as its log grows.
        let st = stamp(&s.join("updates.jsonl")).or_else(|| stamp(&s.join("summary.json")));
        let cached = st.and_then(|st| grok_cache().lock().ok()?.get(&s).filter(|(k, _)| *k == st).map(|(_, b)| b.clone()));
        let buckets = match cached {
            Some(b) => b,
            None => {
                let hint = std::fs::read_to_string(s.join("summary.json"))
                    .ok()
                    .and_then(|t| serde_json::from_str::<Value>(&t).ok())
                    .and_then(|v| v["current_model_id"].as_str().map(str::to_string))
                    .unwrap_or_else(|| "grok".into());
                let out = tokio::time::timeout(Duration::from_secs(20), paths::command(&bin).args(["usage", &id]).output()).await;
                let b = match out {
                    Ok(Ok(o)) if o.status.success() => serde_json::from_slice::<Value>(&o.stdout).map(|v| parse_grok(&v, &hint)).unwrap_or_default(),
                    // "No usage recorded" for a session that never reached the model.
                    _ => Vec::new(),
                };
                if let (Some(st), Ok(mut c)) = (st, grok_cache().lock()) {
                    c.insert(s.clone(), (st, b.clone()));
                }
                b
            }
        };
        if !buckets.is_empty() {
            n += 1;
        }
        for b in buckets {
            acc.add_bucket(b);
        }
    }
    (n, acc)
}

/// First of `keys` present in `v` (Grok writes both camelCase and snake_case shapes).
fn pick(v: &Value, keys: &[&str]) -> u64 {
    keys.iter().map(|k| num(&v[*k])).find(|n| *n > 0).unwrap_or(0)
}

fn grok_bucket(v: &Value, model: &str) -> UsageBucket {
    let ticks = v["costUsdTicks"].as_f64().or_else(|| v["cost_usd_ticks"].as_f64()).or_else(|| v["total_cost_usd_ticks"].as_f64());
    let usd = ticks
        .map(|t| t / 1e10)
        .or_else(|| ["costUSD", "costUsd", "cost_usd", "total_cost_usd"].iter().find_map(|k| v[*k].as_f64()));
    // Some shapes nest the counts under `usage`.
    let u = if v["usage"].is_object() { &v["usage"] } else { v };
    UsageBucket {
        model: model.to_string(),
        tier: "standard".into(),
        requests: pick(v, &["modelCalls", "model_calls", "num_turns", "turns"]).max(1),
        input: pick(u, &["inputTokens", "input_tokens"]),
        cache_read: pick(u, &["cacheReadInputTokens", "cache_read_input_tokens", "cachedInputTokens", "cached_input_tokens"]),
        cache_write: pick(u, &["cacheCreationInputTokens", "cache_creation_input_tokens"]),
        cache_write_long: 0,
        output: pick(u, &["outputTokens", "output_tokens"]),
        cost_usd: usd,
    }
}

/// `grok usage <id>`: `{sessionId, updatedAt, session, turns}`; `session` carries the
/// totals, per model under `modelUsage` when present.
fn parse_grok(v: &Value, model_hint: &str) -> Vec<UsageBucket> {
    let s = if v["session"].is_object() { &v["session"] } else { v };
    if let Some(per) = s["modelUsage"].as_object().or_else(|| s["model_usage"].as_object()) {
        let b: Vec<UsageBucket> = per.iter().map(|(m, mu)| grok_bucket(mu, m)).collect();
        if !b.is_empty() {
            return b;
        }
    }
    let model = s["model"].as_str().or_else(|| s["modelId"].as_str()).unwrap_or(model_hint);
    let b = grok_bucket(s, model);
    if b.input + b.output + b.cache_read == 0 && b.cost_usd.is_none() {
        return Vec::new();
    }
    vec![b]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_counts_each_call_once() {
        let line = |id: &str, req: &str, speed: &str| {
            format!(
                r#"{{"type":"assistant","requestId":"{req}","message":{{"id":"{id}","model":"claude-opus-5-5","usage":{{"input_tokens":10,"cache_creation_input_tokens":300,"cache_read_input_tokens":2000,"output_tokens":50,"cache_creation":{{"ephemeral_5m_input_tokens":100,"ephemeral_1h_input_tokens":200}},"speed":"{speed}"}}}}}}"#
            )
        };
        let text = [line("m1", "r1", "standard"), line("m1", "r1", "standard"), line("m2", "r2", "fast"), r#"{"type":"user","message":{"content":"usage"}}"#.into()].join("\n");
        let calls = parse_claude(&text);
        assert_eq!(calls.len(), 3);
        let mut acc = Acc::default();
        calls.iter().for_each(|c| acc.add(c));
        let std = &acc.buckets[&("claude-opus-5-5".to_string(), "standard".to_string())];
        assert_eq!((std.requests, std.input, std.cache_write, std.cache_write_long, std.cache_read, std.output), (1, 10, 100, 200, 2000, 50));
        assert_eq!(acc.buckets[&("claude-opus-5-5".to_string(), "fast".to_string())].requests, 1);
    }

    #[test]
    fn claude_folder_names() {
        assert_eq!(
            claude_folder(Path::new("/Users/admin/orca/workspaces/savemua/lk-3bd7324d-sau-khi.x")),
            "-Users-admin-orca-workspaces-savemua-lk-3bd7324d-sau-khi-x"
        );
    }

    #[test]
    fn codex_records_and_fallback() {
        let text = r#"{"type":"session_meta","payload":{"cwd":"/wt/a"}}
{"type":"turn_context","payload":{"model":"gpt-6-luna"}}
{"type":"token_usage_record","payload":{"response_id":"r1","usage":{"input_tokens":17276,"cached_input_tokens":10624,"cache_write_input_tokens":0,"output_tokens":81}}}
{"type":"token_usage_record","payload":{"response_id":"r2","usage":{"input_tokens":300000,"cached_input_tokens":0,"output_tokens":5}}}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1}}}}"#;
        let (cwd, calls) = parse_codex(text);
        assert_eq!(cwd.as_deref(), Some("/wt/a"));
        assert_eq!(calls.len(), 2);
        assert_eq!((calls[0].input, calls[0].cache_read, calls[0].output, calls[0].tier), (6652, 10624, 81, "standard"));
        assert_eq!(calls[1].tier, "long");
        let old = r#"{"type":"session_meta","payload":{"cwd":"/wt/b"}}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":7}}}}"#;
        let (_, calls) = parse_codex(old);
        assert_eq!((calls.len(), calls[0].input, calls[0].model.as_str()), (1, 60, "codex"));
        assert!(same_or_inside("/wt/a/sub", Path::new("/wt/a")) && !same_or_inside("/wt/ab", Path::new("/wt/a")));
    }

    #[test]
    fn grok_usage_shapes() {
        let per_model: Value = serde_json::from_str(
            r#"{"sessionId":"s","session":{"modelUsage":{"grok-4.7":{"inputTokens":7210,"outputTokens":1893,"cacheReadInputTokens":41000,"modelCalls":7,"costUsdTicks":126890500}}},"turns":[]}"#,
        )
        .unwrap();
        let b = parse_grok(&per_model, "x");
        assert_eq!(b.len(), 1);
        assert_eq!((b[0].model.as_str(), b[0].input, b[0].cache_read, b[0].requests), ("grok-4.7", 7210, 41000, 7));
        assert!((b[0].cost_usd.unwrap() - 0.01268905).abs() < 1e-9);
        let flat: Value = serde_json::from_str(r#"{"session":{"usage":{"input_tokens":5,"output_tokens":2},"total_cost_usd":0.5}}"#).unwrap();
        let b = parse_grok(&flat, "grok-4.7");
        assert_eq!((b[0].model.as_str(), b[0].input, b[0].output, b[0].cost_usd), ("grok-4.7", 5, 2, Some(0.5)));
        assert!(parse_grok(&serde_json::json!({"session": {}}), "g").is_empty());
        assert_eq!(percent_decode("%2FUsers%2Fadmin%2Fa%20b"), "/Users/admin/a b");
    }
}
