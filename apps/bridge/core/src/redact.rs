//! Secret redaction applied to everything the bridge sends off this machine
//! (agent logs, terminal screens, diffs).

use regex::Regex;
use std::sync::OnceLock;

pub const MASK: &str = "***REDACTED***";

struct Rules {
    /// `KEY=value` / `"token": "value"` style assignments: keep the key, mask the value.
    assignment: Regex,
    /// Well-known token formats that are secrets wherever they appear.
    tokens: Vec<Regex>,
    /// Private network addresses (logs and screens only, not diffs).
    private_ip: Regex,
}

fn rules() -> &'static Rules {
    static R: OnceLock<Rules> = OnceLock::new();
    R.get_or_init(|| Rules {
        assignment: Regex::new(
            r#"(?i)\b([A-Z0-9_\-]*(?:api[_\-]?key|secret|token|passw(?:or)?d|pwd|auth|credential|private[_\-]?key)[A-Z0-9_\-]*)(\s*["']?\s*[:=]\s*["']?)([^\s"',;]{6,})"#,
        )
        .unwrap(),
        tokens: [
            r"sk-(?:ant-|proj-)?[A-Za-z0-9_\-]{20,}",
            r"gh[pousr]_[A-Za-z0-9]{30,}",
            r"github_pat_[A-Za-z0-9_]{40,}",
            r"AKIA[0-9A-Z]{16}",
            r"xox[abprs]-[A-Za-z0-9\-]{10,}",
            r"AIza[0-9A-Za-z_\-]{35}",
            r"(?i)bearer\s+[A-Za-z0-9._\-]{20,}",
            r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
        ]
        .iter()
        .map(|p| Regex::new(p).unwrap())
        .collect(),
        private_ip: Regex::new(
            r"\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b",
        )
        .unwrap(),
    })
}

fn redact_secrets(input: &str) -> String {
    let r = rules();
    let mut out = r.assignment.replace_all(input, format!("${{1}}${{2}}{MASK}")).into_owned();
    for t in &r.tokens {
        out = t.replace_all(&out, MASK).into_owned();
    }
    out
}

/// For agent logs and terminal screens.
pub fn redact_line(input: &str) -> String {
    let out = redact_secrets(input);
    rules().private_ip.replace_all(&out, MASK).into_owned()
}

/// For diffs: mask secrets but keep addresses, which reviewers often need to see.
pub fn redact_patch(input: &str) -> String {
    redact_secrets(input)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_assignments_and_tokens() {
        assert_eq!(redact_line("OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx"), format!("OPENAI_API_KEY={MASK}"));
        assert_eq!(redact_line(r#""password": "hunter2hunter2""#), format!(r#""password": "{MASK}""#));
        assert!(redact_line("token ghp_abcdefghijklmnopqrstuvwxyz0123456789").contains(MASK));
        assert_eq!(redact_line("host 192.168.1.20 up"), format!("host {MASK} up"));
        assert_eq!(redact_patch("host 192.168.1.20 up"), "host 192.168.1.20 up");
        assert_eq!(redact_line("normal output line"), "normal output line");
    }
}
