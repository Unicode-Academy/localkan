//! Spotting an agent CLI that stopped on its usage limit ("5-hour limit reached · resets 3pm",
//! "You've hit your usage limit… try again in 2 hours"), and when it may go on.
//!
//! Only the bottom of the agent's screen is read, and only while the agent is not at work
//! (a working TUI shows "esc to interrupt"), so text about rate limits in the code or test
//! output the agent prints does not count.

use std::sync::OnceLock;

use chrono::{DateTime, Duration, Local, NaiveTime, TimeZone};
use regex::Regex;

#[derive(Debug, Clone, PartialEq)]
pub struct LimitHit {
    /// The CLI's own message, without box-drawing characters.
    pub line: String,
    /// When the limit resets, when the message says so in a form we can read.
    pub reset_at: Option<DateTime<Local>>,
}

/// The notice sits just above the input box and status line.
const TAIL: usize = 16;

fn re(src: &str) -> Regex {
    Regex::new(&format!("(?i){src}")).expect("valid regex")
}

fn limit_patterns() -> &'static [Regex] {
    static P: OnceLock<Vec<Regex>> = OnceLock::new();
    P.get_or_init(|| {
        [
            r"usage limit reached",
            r"\blimit reached\b.*\b(resets?|try again)\b",
            r"\byou(?:'|’)?ve (?:hit|reached) your\b.*\blimit\b",
            r"\byou have (?:hit|reached) your\b.*\blimit\b",
            r"\b(?:quota exceeded|resource[_ ]exhausted|exhausted your (?:quota|capacity))\b",
            r"weekly limit left:\s*0\s*%",
        ]
        .iter()
        .map(|p| re(p))
        .collect()
    })
}

fn is_limit_line(line: &str) -> bool {
    let lower = line.to_lowercase();
    // Warnings before the limit ("Approaching usage limit") do not stop the agent.
    !lower.contains("approaching") && limit_patterns().iter().any(|p| p.is_match(line))
}

/// The usage-limit notice at the bottom of an agent's screen, if it is stopped on one.
pub fn detect(screen: &[String], now: DateTime<Local>) -> Option<LimitHit> {
    let lines: Vec<&str> = screen.iter().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
    let tail = &lines[lines.len().saturating_sub(TAIL)..];
    if tail.iter().any(|l| l.to_lowercase().contains("esc to interrupt")) {
        return None;
    }
    let i = tail.iter().rposition(|l| is_limit_line(l))?;
    // The reset time can wrap onto the next line or two.
    let context = tail[i..(i + 3).min(tail.len())].join(" ");
    Some(LimitHit { line: clean(tail[i]), reset_at: parse_reset(&context, now) })
}

fn clean(line: &str) -> String {
    line.trim_matches(|c: char| c.is_whitespace() || "│┃╭╮╰╯─━⎿⏺●■•*>▌▐".contains(c)).to_string()
}

/// When the limit resets, read from the message: a Unix timestamp (`…reached|1736512000`),
/// a delay (`try again in 4 days 22 hours`, `resets in 2h 30m`) or a clock time
/// (`resets 3pm`, `reset at 15:30`), taken as this machine's local time. None when it is
/// missing, in another form (a date) or already past.
pub fn parse_reset(text: &str, now: DateTime<Local>) -> Option<DateTime<Local>> {
    static TS: OnceLock<Regex> = OnceLock::new();
    static REL: OnceLock<Regex> = OnceLock::new();
    static PART: OnceLock<Regex> = OnceLock::new();
    static CLOCK: OnceLock<Regex> = OnceLock::new();

    let at = if let Some(c) = TS.get_or_init(|| re(r"\|\s*(\d{10})\b")).captures(text) {
        Local.timestamp_opt(c[1].parse().ok()?, 0).single()?
    } else if let Some(c) = REL
        .get_or_init(|| {
            re(r"\b(?:try again|resets?|available(?: again)?)\s+in\s+((?:\d+\s*(?:days?|d|hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)\b[\s,]*(?:and\s+)?)+)")
        })
        .captures(text)
    {
        let mut secs = 0i64;
        for p in PART.get_or_init(|| re(r"(\d+)\s*([a-z]+)")).captures_iter(&c[1]) {
            let n: i64 = p[1].parse().ok()?;
            let unit = p[2].to_lowercase();
            secs += n * match unit.chars().next()? {
                'd' => 86_400,
                'h' => 3_600,
                'm' => 60,
                _ => 1,
            };
        }
        now + Duration::seconds(secs)
    } else if let Some(c) = CLOCK
        .get_or_init(|| re(r"\b(?:resets?|try again|available(?: again)?)(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?(?:\W|$)"))
        .captures(text)
    {
        let mut hour: u32 = c[1].parse().ok()?;
        let minute: u32 = c.get(2).map_or(Some(0), |m| m.as_str().parse().ok())?;
        if let Some(ampm) = c.get(3) {
            if hour == 0 || hour > 12 {
                return None;
            }
            let pm = ampm.as_str().to_lowercase().starts_with('p');
            hour = match (hour, pm) {
                (12, false) => 0,
                (12, true) => 12,
                (h, true) => h + 12,
                (h, false) => h,
            };
        }
        let time = NaiveTime::from_hms_opt(hour, minute, 0)?;
        let today = now.date_naive().and_time(time);
        let mut at = Local.from_local_datetime(&today).earliest()?;
        if at <= now {
            at += Duration::days(1);
        }
        at
    } else {
        return None;
    };
    (at > now).then_some(at)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> DateTime<Local> {
        Local.with_ymd_and_hms(2026, 11, 15, 10, 0, 0).unwrap()
    }

    fn screen(lines: &[&str]) -> Vec<String> {
        lines.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn claude_limit_with_clock_reset() {
        let hit = detect(
            &screen(&[
                "⏺ Updating the checkout controller…",
                "  ⎿  5-hour limit reached ∙ resets 3pm",
                "",
                "╭──────────────────────────╮",
                "│ >                        │",
                "╰──────────────────────────╯",
                "  ⏵⏵ bypass permissions on",
            ]),
            now(),
        )
        .unwrap();
        assert_eq!(hit.line, "5-hour limit reached ∙ resets 3pm");
        assert_eq!(hit.reset_at, Some(Local.with_ymd_and_hms(2026, 11, 15, 15, 0, 0).unwrap()));
    }

    #[test]
    fn codex_limit_with_delay() {
        let hit = detect(
            &screen(&[
                "■ You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again in 1 day 2 hours 30 minutes.",
                "› ",
            ]),
            now(),
        )
        .unwrap();
        assert_eq!(hit.reset_at, Some(now() + Duration::hours(26) + Duration::minutes(30)));
    }

    #[test]
    fn unix_timestamp_and_unreadable_dates() {
        let ts = Local.with_ymd_and_hms(2026, 11, 15, 18, 0, 0).unwrap().timestamp();
        assert_eq!(parse_reset(&format!("Claude AI usage limit reached|{ts}"), now()).map(|t| t.timestamp()), Some(ts));
        assert_eq!(parse_reset("Opus weekly limit reached ∙ resets Nov 20, 9am", now()), None);
        // A clock time already past today means tomorrow.
        assert_eq!(parse_reset("limit reached · resets at 9:30", now()), Some(Local.with_ymd_and_hms(2026, 11, 16, 9, 30, 0).unwrap()));
        assert_eq!(parse_reset("Your limit will reset at 11pm (Asia/Saigon)", now()), Some(Local.with_ymd_and_hms(2026, 11, 15, 23, 0, 0).unwrap()));
    }

    #[test]
    fn grok_and_gemini_wordings() {
        assert!(detect(&screen(&["  ╰── Weekly limit left: 0% · Grok 4.7 (high) · always-approve ─╯"]), now()).is_some());
        assert!(detect(&screen(&["✕ You have exhausted your capacity on this model."]), now()).is_some());
    }

    #[test]
    fn ignores_work_and_warnings() {
        // Still working: whatever the output says, the agent is not stopped.
        assert!(detect(&screen(&["usage limit reached", "✻ Thinking… (esc to interrupt)"]), now()).is_none());
        assert!(detect(&screen(&["Approaching usage limit · resets at 3pm", ">"]), now()).is_none());
        assert!(detect(&screen(&["if (rateLimitReached) { throw new Error('Rate limit exceeded') }", ">"]), now()).is_none());
        assert!(detect(&screen(&["Weekly limit left: 40% · Grok 4.7"]), now()).is_none());
        // Far above the bottom of the screen: an old notice the agent moved past.
        let mut old = vec!["usage limit reached"];
        old.extend(std::iter::repeat_n("● Edited src/app.ts", TAIL));
        assert!(detect(&screen(&old), now()).is_none());
    }
}
