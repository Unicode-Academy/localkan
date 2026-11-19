//! Models for the picker shown when assigning a task, as each agent CLI on this machine lists
//! them, and the launch command that runs an agent with a chosen model.
//!
//! Orca adds the user's launch arguments for an agent (by default the flag that stops it asking
//! before every tool) only when the terminal command is exactly the agent's name. A command
//! with `--model` runs verbatim, so it is built here from the same Orca settings.

use std::collections::BTreeMap;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::paths;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AgentModel {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub default: bool,
}

fn model(id: &str, label: &str, default: bool) -> AgentModel {
    AgentModel { id: id.into(), label: label.into(), default }
}

/// Model ids end up in a shell command: letters, digits and `.:/[]_-` only (same rule as the
/// web and server).
pub fn valid_id(id: &str) -> bool {
    let mut chars = id.chars();
    id.len() <= 100
        && chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || "._:/[]-".contains(c))
}

/// The CLI binary behind an agent id.
pub fn binary(agent: &str) -> &str {
    match agent {
        "antigravity" => "agy",
        other => other,
    }
}

const CLI_TIMEOUT: Duration = Duration::from_secs(30);

/// Models of every installed agent. An agent whose CLI cannot list them is left out (the web
/// then offers only the CLI's default).
pub async fn discover() -> BTreeMap<String, Vec<AgentModel>> {
    let (codex, grok, agy) = tokio::join!(
        run("codex", &["debug", "models"]),
        run("grok", &["models"]),
        run("agy", &["models"]),
    );
    let mut all = BTreeMap::new();
    if paths::which("claude").is_some() {
        // Claude Code has no list command; its family aliases always point at the newest model.
        let claude = [("fable", "Fable"), ("opus", "Opus"), ("sonnet", "Sonnet"), ("haiku", "Haiku")];
        all.insert("claude".into(), claude.iter().map(|(id, label)| model(id, label, false)).collect());
    }
    let codex = codex
        .and_then(|out| serde_json::from_str::<Value>(&out).ok())
        .or_else(|| {
            // Older Codex builds: the catalog Codex caches after fetching it.
            let cached = std::fs::read_to_string(paths::home().join(".codex/models_cache.json")).ok()?;
            serde_json::from_str(&cached).ok()
        })
        .map(|v| parse_codex(&v))
        .unwrap_or_default();
    for (agent, list) in [
        ("codex", codex),
        ("grok", grok.map(|o| parse_grok(&o)).unwrap_or_default()),
        ("antigravity", agy.map(|o| parse_agy(&o)).unwrap_or_default()),
    ] {
        if !list.is_empty() {
            all.insert(agent.into(), list);
        }
    }
    all
}

async fn run(bin: &str, args: &[&str]) -> Option<String> {
    let path = paths::which(bin)?;
    let out = tokio::time::timeout(CLI_TIMEOUT, paths::command(path).args(args).output()).await.ok()?.ok()?;
    if !out.status.success() {
        tracing::debug!(bin, "listing models failed: {}", String::from_utf8_lossy(&out.stderr).trim());
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// `codex debug models`: `{"models": [{"slug", "display_name", "visibility", "priority"}…]}`;
/// only models Codex shows in its own picker (`visibility: "list"`).
fn parse_codex(v: &Value) -> Vec<AgentModel> {
    let mut rows: Vec<(i64, AgentModel)> = v["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| m["visibility"].as_str() == Some("list"))
        .filter_map(|m| {
            let id = m["slug"].as_str().filter(|s| valid_id(s))?;
            let label = m["display_name"].as_str().filter(|s| !s.trim().is_empty()).unwrap_or(id);
            Some((m["priority"].as_i64().unwrap_or(i64::MAX), model(id, label, false)))
        })
        .collect();
    rows.sort_by_key(|(p, _)| *p);
    rows.into_iter().map(|(_, m)| m).collect()
}

/// `grok models`: lines like `  * grok-4.7 (default)` and `  - grok-4.6`.
fn parse_grok(out: &str) -> Vec<AgentModel> {
    out.lines()
        .filter_map(|l| {
            let rest = l.trim().strip_prefix("* ").or_else(|| l.trim().strip_prefix("- "))?;
            let mut words = rest.split_whitespace();
            let id = words.next().filter(|s| valid_id(s))?;
            let default = l.trim().starts_with('*') || rest.contains("(default)");
            Some(model(id, id, default))
        })
        .collect()
}

/// `agy models`: one `id<TAB>Label` per line, after a "Fetching…" line.
fn parse_agy(out: &str) -> Vec<AgentModel> {
    out.lines()
        .filter_map(|l| {
            let (id, label) = l.split_once('\t')?;
            let id = id.trim();
            valid_id(id).then(|| model(id, label.trim(), false))
        })
        .collect()
}

/// Orca's built-in launch arguments, for when its settings cannot be read.
fn default_args(agent: &str) -> &'static str {
    match agent {
        "claude" | "antigravity" => "--dangerously-skip-permissions",
        "codex" => "--dangerously-bypass-approvals-and-sandbox",
        "grok" => "--permission-mode bypassPermissions",
        _ => "",
    }
}

/// The command and arguments Orca would launch `agent` with: the user's command override and
/// default arguments from the active Orca profile, else Orca's built-in defaults.
fn orca_launch(agent: &str) -> (String, String) {
    let settings = orca_settings();
    let pick = |key: &str| settings.as_ref().and_then(|s| s[key][agent].as_str()).map(|s| s.trim().to_string());
    let cmd = pick("agentCmdOverrides").filter(|c| !c.is_empty()).unwrap_or_else(|| binary(agent).to_string());
    let args = pick("agentDefaultArgs").unwrap_or_else(|| default_args(agent).to_string());
    (cmd, args)
}

fn orca_settings() -> Option<Value> {
    let root = paths::home().join("Library/Application Support/orca");
    let index: Value = serde_json::from_str(&std::fs::read_to_string(root.join("orca-profile-index.json")).ok()?).ok()?;
    let profile = index["activeProfileId"].as_str().filter(|p| valid_id(p)).unwrap_or("local-default");
    let data: Value =
        serde_json::from_str(&std::fs::read_to_string(root.join("profiles").join(profile).join("orca-data.json")).ok()?).ok()?;
    Some(data["settings"].clone())
}

/// Reasoning effort levels every agent CLI takes (Claude, Codex, Grok, Antigravity).
pub fn valid_effort(e: &str) -> bool {
    matches!(e, "low" | "medium" | "high" | "xhigh" | "max")
}

/// Terminal command that starts `agent` the way Orca would start it otherwise, plus a model,
/// an effort, and for Claude (`lean`) no MCP servers or plugins from the machine's global
/// setup: each adds tool definitions or skills that every request of the task carries.
pub fn launch_command(agent: &str, model: Option<&str>, effort: Option<&str>, lean: bool) -> String {
    let (cmd, args) = orca_launch(agent);
    let lean = (lean && agent == "claude").then(|| claude_lean_args(&global_claude_plugins()));
    compose(&cmd, &args, model, effort, lean.as_deref())
}

fn compose(cmd: &str, args: &str, model: Option<&str>, effort: Option<&str>, extra: Option<&str>) -> String {
    let mut out = cmd.to_string();
    if !args.is_empty() {
        out.push(' ');
        out.push_str(args);
    }
    // `valid_id` already rules out quotes and spaces; quoting keeps `[1m]`-style ids literal.
    if let Some(m) = model {
        out.push_str(&format!(" --model '{m}'"));
    }
    if let Some(e) = effort.filter(|e| valid_effort(e)) {
        out.push_str(&format!(" --effort {e}"));
    }
    if let Some(x) = extra.filter(|x| !x.is_empty()) {
        out.push(' ');
        out.push_str(x);
    }
    out
}

/// Plugins enabled in the user's global Claude Code settings.
fn global_claude_plugins() -> Vec<String> {
    let path = std::env::var_os("CLAUDE_CONFIG_DIR").map(std::path::PathBuf::from).unwrap_or_else(|| paths::home().join(".claude"));
    let Ok(text) = std::fs::read_to_string(path.join("settings.json")) else { return Vec::new() };
    let Ok(v) = serde_json::from_str::<Value>(&text) else { return Vec::new() };
    v["enabledPlugins"]
        .as_object()
        .map(|m| m.iter().filter(|(_, on)| on.as_bool() == Some(true)).map(|(k, _)| k.clone()).collect())
        .unwrap_or_default()
}

/// `--strict-mcp-config` (no MCP server unless given) and settings that turn the global
/// plugins off for this session. The project's own skills and CLAUDE.md still load.
fn claude_lean_args(plugins: &[String]) -> String {
    let mut out = String::from("--strict-mcp-config");
    let safe = |p: &&String| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || "@._-/".contains(c));
    let off: serde_json::Map<String, Value> = plugins.iter().filter(safe).map(|p| (p.clone(), Value::Bool(false))).collect();
    if !off.is_empty() {
        let json = serde_json::json!({ "enabledPlugins": off }).to_string();
        out.push_str(&format!(" --settings '{json}'"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_model_ids() {
        for ok in ["opus", "gpt-5.6-terra", "claude-opus-4-6-thinking", "sonnet[1m]", "a/b:c"] {
            assert!(valid_id(ok), "{ok}");
        }
        for bad in ["", "-x", "a b", "x';rm", "$(id)", "a`b`"] {
            assert!(!valid_id(bad), "{bad}");
        }
    }

    #[test]
    fn parses_codex_catalog() {
        let v = serde_json::json!({"models": [
            {"slug": "hidden", "display_name": "Hidden", "visibility": "hide", "priority": 1},
            {"slug": "gpt-b", "display_name": "GPT-B", "visibility": "list", "priority": 4},
            {"slug": "gpt-a", "display_name": "GPT-A", "visibility": "list", "priority": 2},
        ]});
        let ids: Vec<_> = parse_codex(&v).into_iter().map(|m| (m.id, m.label)).collect();
        assert_eq!(ids, vec![("gpt-a".into(), "GPT-A".into()), ("gpt-b".into(), "GPT-B".into())]);
    }

    #[test]
    fn parses_grok_list() {
        let out = "You are logged in with grok.com.\n\nDefault model: grok-4.7\n\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.6\n";
        assert_eq!(parse_grok(out), vec![model("grok-4.7", "grok-4.7", true), model("grok-4.6", "grok-4.6", false)]);
    }

    #[test]
    fn parses_agy_list() {
        let out = "Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n";
        assert_eq!(
            parse_agy(out),
            vec![
                model("gemini-3.8-flash-high", "Gemini 3.8 Flash (High)", false),
                model("claude-sonnet-4-6", "Claude Sonnet 4.6 (Thinking)", false)
            ]
        );
    }

    #[test]
    fn composes_launch_command() {
        assert_eq!(compose("claude", "--dangerously-skip-permissions", Some("opus"), None, None), "claude --dangerously-skip-permissions --model 'opus'");
        assert_eq!(compose("agy", "", Some("gemini-3.8-flash-low"), None, None), "agy --model 'gemini-3.8-flash-low'");
        assert_eq!(compose("grok", "", None, Some("high"), None), "grok --effort high");
        assert_eq!(compose("claude", "", None, Some("bogus; rm"), None), "claude");
        assert_eq!(binary("antigravity"), "agy");
        let lean = claude_lean_args(&["stitch-build@google-labs".into(), "bad'name".into()]);
        assert_eq!(lean, r#"--strict-mcp-config --settings '{"enabledPlugins":{"stitch-build@google-labs":false}}'"#);
        assert_eq!(claude_lean_args(&[]), "--strict-mcp-config");
        assert_eq!(
            compose("claude", "--x", Some("sonnet"), Some("medium"), Some(&lean)),
            r#"claude --x --model 'sonnet' --effort medium --strict-mcp-config --settings '{"enabledPlugins":{"stitch-build@google-labs":false}}'"#
        );
    }
}
