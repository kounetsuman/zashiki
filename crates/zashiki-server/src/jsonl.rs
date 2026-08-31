//! Claude transcript (jsonl) parser.
//! Since it involves JSON parsing, it lives in the server crate rather than core (which has zero dependencies).
//! File I/O is infra's responsibility; this module only receives content strings and parses them.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use zashiki_core::session_state::{TranscriptEvent, TranscriptKind};

/// Tail window of 50: still picks up user/assistant events even when noise like attachment/ai-title fills the end.
const LAST_EVENT_TAIL_LINES: usize = 50;

const INTERRUPT_MARKER: &str = "[Request interrupted by user]";

/// Extracts text from message.content (arrays join only text elements with spaces; strings pass through as-is).
fn text_of_content(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(|c| {
                if c.get("type").and_then(Value::as_str) == Some("text") {
                    c.get("text").and_then(Value::as_str)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}

/// Parses a single line as a JSON object (broken lines or non-objects return None).
fn parse_line(line: &str) -> Option<Value> {
    match serde_json::from_str::<Value>(line) {
        Ok(v) if v.is_object() => Some(v),
        _ => None,
    }
}

/// event.message.content (None if there is no message).
fn content_of(event: &Value) -> Option<&Value> {
    let message = event.get("message")?;
    if message.is_object() {
        message.get("content")
    } else {
        None
    }
}

/// The single trailing user/assistant event of the transcript (None if there is none).
/// interrupted = the body text contains the interruption marker (does not look inside tool_result).
pub fn last_user_or_assistant_event(jsonl_tail: &str) -> Option<TranscriptEvent> {
    let lines: Vec<&str> = jsonl_tail.split('\n').filter(|l| !l.is_empty()).collect();
    let start = lines.len().saturating_sub(LAST_EVENT_TAIL_LINES);
    for line in lines[start..].iter().rev() {
        let Some(event) = parse_line(line) else {
            continue;
        };
        let kind = match event.get("type").and_then(Value::as_str) {
            Some("user") => TranscriptKind::User,
            Some("assistant") => TranscriptKind::Assistant,
            _ => continue,
        };
        let text = content_of(&event).map(text_of_content).unwrap_or_default();
        return Some(TranscriptEvent {
            kind,
            interrupted: text.contains(INTERRUPT_MARKER),
        });
    }
    None
}

/// Whether the transcript tail shows a pending self-paced `/loop` wakeup: the newest turn boundary
/// is a `ScheduleWakeup`, not yet superseded by a human prompt or a fired wakeup. Between iterations
/// the pane looks identical to a completed session, so the poller uses this to keep it off the
/// "completed" read. See the tests for the boundary cases.
pub fn loop_wakeup_pending(jsonl_tail: &str) -> bool {
    let lines: Vec<&str> = jsonl_tail.split('\n').filter(|l| !l.is_empty()).collect();
    let start = lines.len().saturating_sub(LAST_EVENT_TAIL_LINES);
    for line in lines[start..].iter().rev() {
        let Some(event) = parse_line(line) else {
            continue;
        };
        if let Some(pending) = classify_loop_boundary(&event) {
            return pending;
        }
    }
    false
}

/// Classifies an event as a loop turn boundary: `Some(true)` schedules a wakeup, `Some(false)` ends
/// the loop (human prompt or fired wakeup), `None` is noise the scan skips.
fn classify_loop_boundary(event: &Value) -> Option<bool> {
    match event.get("type").and_then(Value::as_str) {
        Some("assistant") if has_schedule_wakeup(event) => Some(true),
        Some("user") if is_human_prompt(event) => Some(false),
        Some("system")
            if event.get("subtype").and_then(Value::as_str) == Some("scheduled_task_fire") =>
        {
            Some(false)
        }
        _ => None,
    }
}

/// Whether an assistant message carries a `ScheduleWakeup` tool_use block.
fn has_schedule_wakeup(event: &Value) -> bool {
    let Some(Value::Array(blocks)) = content_of(event) else {
        return false;
    };
    blocks.iter().any(|b| {
        b.get("type").and_then(Value::as_str) == Some("tool_use")
            && b.get("name").and_then(Value::as_str) == Some("ScheduleWakeup")
    })
}

/// Strips meta tags emitted when running skills/slash commands (command-name keeps its inner /foo).
/// The opening and closing local-command tags match independently.
fn strip_command_tags(text: &str) -> String {
    static COMMAND_ARGS: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"<command-args>[^<]*</command-args>").unwrap());
    static COMMAND_MESSAGE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"<command-message>[^<]*</command-message>").unwrap());
    static LOCAL_COMMAND: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"<local-command-(?:caveat|stdout|stderr)>[^<]*</local-command-(?:caveat|stdout|stderr)>")
            .unwrap()
    });
    static COMMAND_NAME: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"</?command-name>").unwrap());

    let t = COMMAND_ARGS.replace_all(text, "");
    let t = COMMAND_MESSAGE.replace_all(&t, "");
    let t = LOCAL_COMMAND.replace_all(&t, "");
    COMMAND_NAME.replace_all(&t, "").into_owned()
}

/// Builds a summary title from the first user utterance (collapses newlines/runs of spaces, takes the first max_chars characters).
pub fn first_user_title(jsonl_head: &str, max_chars: usize) -> Option<String> {
    for line in jsonl_head.split('\n') {
        if line.is_empty() || !line.contains(r#""type":"user""#) {
            continue;
        }
        let Some(event) = parse_line(line) else {
            continue;
        };
        if event.get("type").and_then(Value::as_str) != Some("user") {
            continue;
        }
        let raw = content_of(&event).map(text_of_content).unwrap_or_default();
        let title = strip_command_tags(&raw)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if title.is_empty() {
            return None;
        }
        return Some(title.chars().take(max_chars).collect());
    }
    None
}

/// cwd -> the project directory name under ~/.claude/projects (replaces `/` with `-`).
pub fn claude_project_dir_name(cwd: &str) -> String {
    cwd.replace('/', "-")
}

/// Token/timing rollup for a session's transcript (the material for the session status footer).
/// `turn` counts from the most recent human prompt; `session` counts the whole transcript.
/// `*_at_ms` are epoch-ms starting points (the client renders live elapsed as `now - start`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionUsageData {
    pub turn_tokens: u64,
    pub session_tokens: u64,
    pub turn_started_at_ms: u64,
    pub session_started_at_ms: u64,
}

/// Sum of the tokens the API touched for one assistant response
/// (input + cache_creation + cache_read + output).
fn usage_total(usage: &Value) -> u64 {
    const KEYS: [&str; 4] = [
        "input_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
        "output_tokens",
    ];
    KEYS.iter()
        .map(|k| usage.get(*k).and_then(Value::as_u64).unwrap_or(0))
        .sum()
}

/// A human-typed user line (the boundary of a "turn"): a `user` event whose content is not solely
/// tool_result output (string content is always human; an array counts unless it holds a tool_result block).
fn is_human_prompt(event: &Value) -> bool {
    if event.get("type").and_then(Value::as_str) != Some("user") {
        return false;
    }
    match content_of(event) {
        Some(Value::String(_)) => true,
        Some(Value::Array(blocks)) => !blocks
            .iter()
            .any(|b| b.get("type").and_then(Value::as_str) == Some("tool_result")),
        _ => true,
    }
}

/// Parses Claude's transcript timestamp (`YYYY-MM-DDTHH:MM:SS[.fff]Z`, always UTC) to epoch ms.
/// Dependency-free (no chrono): fixed-layout digits plus the civil-days formula. Fractional seconds
/// and a trailing `Z` are optional; any offset other than `Z` is read as the same wall clock in UTC.
fn parse_iso8601_ms(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() < 19
        || b[4] != b'-'
        || b[7] != b'-'
        || b[10] != b'T'
        || b[13] != b':'
        || b[16] != b':'
    {
        return None;
    }
    let num = |from: usize, to: usize| -> Option<i64> {
        let mut v: i64 = 0;
        for &c in &b[from..to] {
            if !c.is_ascii_digit() {
                return None;
            }
            v = v * 10 + i64::from(c - b'0');
        }
        Some(v)
    };
    let year = num(0, 4)?;
    let month = num(5, 7)?;
    let day = num(8, 10)?;
    let hour = num(11, 13)?;
    let min = num(14, 16)?;
    let sec = num(17, 19)?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let mut ms: i64 = 0;
    if b.get(19) == Some(&b'.') {
        let mut i = 20;
        let mut frac = 0i64;
        let mut digits = 0;
        while i < b.len() && b[i].is_ascii_digit() && digits < 3 {
            frac = frac * 10 + i64::from(b[i] - b'0');
            digits += 1;
            i += 1;
        }
        for _ in digits..3 {
            frac *= 10;
        }
        ms = frac;
    }
    let days = days_from_civil(year, month, day);
    let secs = days * 86_400 + hour * 3_600 + min * 60 + sec;
    u64::try_from(secs * 1_000 + ms).ok()
}

/// Days since the Unix epoch for a proleptic-Gregorian date (Howard Hinnant's `days_from_civil`).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Aggregates per-turn / per-session token totals and their starting timestamps from a full transcript.
/// Returns None when no user/assistant event carries a parseable timestamp (nothing to anchor elapsed on).
/// A turn boundary (`is_human_prompt`) resets the turn total and moves the turn start.
pub fn session_usage(content: &str) -> Option<SessionUsageData> {
    let mut session_tokens: u64 = 0;
    let mut turn_tokens: u64 = 0;
    let mut session_started_at_ms: Option<u64> = None;
    let mut turn_started_at_ms: Option<u64> = None;

    for line in content.split('\n') {
        if !(line.contains("\"type\":\"user\"") || line.contains("\"type\":\"assistant\"")) {
            continue;
        }
        let Some(event) = parse_line(line) else {
            continue;
        };
        let kind = event.get("type").and_then(Value::as_str);
        if kind != Some("user") && kind != Some("assistant") {
            continue;
        }
        let ts = event
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_iso8601_ms);
        if let Some(ts) = ts {
            session_started_at_ms.get_or_insert(ts);
        }
        if is_human_prompt(&event) {
            turn_tokens = 0;
            if let Some(ts) = ts {
                turn_started_at_ms = Some(ts);
            }
            continue;
        }
        if kind == Some("assistant") {
            if let Some(usage) = event.get("message").and_then(|m| m.get("usage")) {
                let t = usage_total(usage);
                session_tokens += t;
                turn_tokens += t;
            }
        }
    }

    let session_started_at_ms = session_started_at_ms?;
    Some(SessionUsageData {
        turn_tokens,
        session_tokens,
        turn_started_at_ms: turn_started_at_ms.unwrap_or(session_started_at_ms),
        session_started_at_ms,
    })
}

/// Collects every background shell launch ID (`toolUseResult.backgroundTaskId`) in the transcript
/// (present only for Bash run_in_background, not for foreground). Stays lightweight even on huge
/// transcripts by JSON-parsing only the candidate lines.
pub fn background_task_ids(content: &str) -> std::collections::HashSet<String> {
    let mut ids = std::collections::HashSet::new();
    for line in content.split('\n') {
        if line.is_empty() || !line.contains("\"backgroundTaskId\"") {
            continue;
        }
        let Some(event) = parse_line(line) else {
            continue;
        };
        if let Some(id) = event
            .get("toolUseResult")
            .filter(|r| r.is_object())
            .and_then(|r| r.get("backgroundTaskId"))
            .and_then(Value::as_str)
        {
            if !id.is_empty() {
                ids.insert(id.to_string());
            }
        }
    }
    ids
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn user_line(content: Value) -> String {
        json!({"type": "user", "message": {"content": content}}).to_string()
    }

    fn assistant_line(content: Value) -> String {
        json!({"type": "assistant", "message": {"content": content}}).to_string()
    }

    fn assert_event(ev: Option<TranscriptEvent>, kind: TranscriptKind, interrupted: bool) {
        let ev = ev.expect("expected an event");
        assert_eq!(ev.kind, kind);
        assert_eq!(ev.interrupted, interrupted);
    }

    // ---- last_user_or_assistant_event ----

    #[test]
    fn picks_trailing_user_event() {
        assert_event(
            last_user_or_assistant_event(&user_line(json!("作業して"))),
            TranscriptKind::User,
            false,
        );
    }

    #[test]
    fn picks_user_past_40_noise_lines() {
        let mut lines = vec![user_line(json!("作業して"))];
        for _ in 0..40 {
            lines.push(json!({"type": "ai-title", "title": "x"}).to_string());
        }
        assert_event(
            last_user_or_assistant_event(&lines.join("\n")),
            TranscriptKind::User,
            false,
        );
    }

    #[test]
    fn drops_user_pushed_out_of_tail_window() {
        let mut lines = vec![user_line(json!("作業して"))];
        for _ in 0..50 {
            lines.push(json!({"type": "ai-title", "title": "x"}).to_string());
        }
        assert!(last_user_or_assistant_event(&lines.join("\n")).is_none());
    }

    #[test]
    fn interrupted_user_sets_flag() {
        let content = user_line(json!([{"type": "text", "text": INTERRUPT_MARKER}]));
        assert_event(
            last_user_or_assistant_event(&content),
            TranscriptKind::User,
            true,
        );
    }

    #[test]
    fn assistant_event_is_not_interrupted() {
        let content = assistant_line(json!([{"type": "text", "text": "ok"}]));
        assert_event(
            last_user_or_assistant_event(&content),
            TranscriptKind::Assistant,
            false,
        );
    }

    #[test]
    fn tool_result_marker_is_not_interruption() {
        let content = user_line(json!([{
            "type": "tool_result",
            "content": "[Request interrupted by user] という文字列を含む出力"
        }]));
        assert_event(
            last_user_or_assistant_event(&content),
            TranscriptKind::User,
            false,
        );
    }

    #[test]
    fn broken_json_line_is_skipped_not_fatal() {
        let content = [
            user_line(json!("作業して")),
            r#"{"type":"ai-title","broken"#.to_string(),
        ]
        .join("\n");
        assert_event(
            last_user_or_assistant_event(&content),
            TranscriptKind::User,
            false,
        );
    }

    #[test]
    fn none_when_no_user_or_assistant() {
        assert!(last_user_or_assistant_event(r#"{"type":"summary","summary":"x"}"#).is_none());
        assert!(last_user_or_assistant_event("").is_none());
    }

    #[test]
    fn picks_last_of_multiple_events() {
        let content = [
            user_line(json!("最初")),
            assistant_line(json!("応答")),
            user_line(json!("次の依頼")),
        ]
        .join("\n");
        assert_event(
            last_user_or_assistant_event(&content),
            TranscriptKind::User,
            false,
        );
    }

    // ---- loop_wakeup_pending ----

    fn schedule_wakeup_line() -> String {
        assistant_line(json!([{
            "type": "tool_use",
            "name": "ScheduleWakeup",
            "input": {"delaySeconds": 1200, "reason": "r", "prompt": "p"},
        }]))
    }

    fn wakeup_result_line() -> String {
        user_line(json!([{"type": "tool_result", "content": "scheduled"}]))
    }

    fn fire_line() -> String {
        json!({
            "type": "system",
            "subtype": "scheduled_task_fire",
            "content": "Claude resuming /loop wakeup (Aug 27 3:46pm)",
        })
        .to_string()
    }

    #[test]
    fn pending_when_latest_boundary_is_schedule_wakeup() {
        let jsonl = [schedule_wakeup_line(), wakeup_result_line()].join("\n");
        assert!(loop_wakeup_pending(&jsonl));
    }

    #[test]
    fn pending_survives_trailing_noise_after_the_wakeup() {
        let jsonl = [
            schedule_wakeup_line(),
            wakeup_result_line(),
            json!({"type": "ai-title", "title": "x"}).to_string(),
            json!({"type": "mode"}).to_string(),
        ]
        .join("\n");
        assert!(loop_wakeup_pending(&jsonl));
    }

    #[test]
    fn not_pending_when_user_took_over_after_the_wakeup() {
        let jsonl = [
            schedule_wakeup_line(),
            wakeup_result_line(),
            user_line(json!("代わりにこうして")),
        ]
        .join("\n");
        assert!(!loop_wakeup_pending(&jsonl));
    }

    #[test]
    fn not_pending_when_last_wakeup_fired_without_rescheduling() {
        let jsonl = [
            schedule_wakeup_line(),
            wakeup_result_line(),
            fire_line(),
            assistant_line(json!([{"type": "text", "text": "loop done, nothing left"}])),
        ]
        .join("\n");
        assert!(!loop_wakeup_pending(&jsonl));
    }

    #[test]
    fn pending_when_rescheduled_after_a_fire() {
        let jsonl = [
            fire_line(),
            assistant_line(json!([{"type": "text", "text": "continuing"}])),
            schedule_wakeup_line(),
            wakeup_result_line(),
        ]
        .join("\n");
        assert!(loop_wakeup_pending(&jsonl));
    }

    #[test]
    fn tool_result_only_tail_is_not_a_boundary() {
        assert!(!loop_wakeup_pending(&wakeup_result_line()));
    }

    #[test]
    fn not_pending_without_any_boundary_or_when_empty() {
        assert!(!loop_wakeup_pending(""));
        assert!(!loop_wakeup_pending(&assistant_line(json!([{"type": "text", "text": "done"}]))));
    }

    // ---- first_user_title ----

    #[test]
    fn title_takes_first_30_chars_of_first_user() {
        let long = "あ".repeat(40);
        let content = [user_line(json!(long)), assistant_line(json!("応答"))].join("\n");
        assert_eq!(
            first_user_title(&content, 30).as_deref(),
            Some("あ".repeat(30).as_str())
        );
    }

    #[test]
    fn title_joins_text_array_elements() {
        let content = user_line(json!([
            {"type": "text", "text": "前半"},
            {"type": "text", "text": "後半"}
        ]));
        assert_eq!(first_user_title(&content, 30).as_deref(), Some("前半 後半"));
    }

    #[test]
    fn title_collapses_newlines_and_runs_of_spaces() {
        let content = user_line(json!("一行目\n二行目   三行目"));
        assert_eq!(
            first_user_title(&content, 30).as_deref(),
            Some("一行目 二行目 三行目")
        );
    }

    #[test]
    fn title_strips_slash_command_tags_but_keeps_command_name_body() {
        let content = user_line(json!(
            "<command-name>/day-closing</command-name>\n<command-message>day-closing</command-message>\n<command-args>今日の分</command-args>"
        ));
        assert_eq!(
            first_user_title(&content, 30).as_deref(),
            Some("/day-closing")
        );
    }

    #[test]
    fn title_removes_local_command_blocks() {
        let content = user_line(json!(
            "<local-command-caveat>注意書き</local-command-caveat>実行結果を見て<local-command-stdout>出力</local-command-stdout><local-command-stderr>エラー</local-command-stderr>"
        ));
        assert_eq!(
            first_user_title(&content, 30).as_deref(),
            Some("実行結果を見て")
        );
    }

    #[test]
    fn title_ignores_events_before_first_user() {
        let content = [
            json!({"type": "summary", "summary": "前セッション要約"}).to_string(),
            user_line(json!("本題の依頼")),
        ]
        .join("\n");
        assert_eq!(
            first_user_title(&content, 30).as_deref(),
            Some("本題の依頼")
        );
    }

    #[test]
    fn title_none_when_no_user() {
        assert!(first_user_title(&assistant_line(json!("応答のみ")), 30).is_none());
        assert!(first_user_title("", 30).is_none());
    }

    #[test]
    fn title_none_when_stripped_to_empty() {
        let content = user_line(json!("<command-args>引数だけ</command-args>"));
        assert!(first_user_title(&content, 30).is_none());
    }

    // ---- claude_project_dir_name ----

    #[test]
    fn project_dir_replaces_slashes_with_dashes() {
        assert_eq!(
            claude_project_dir_name("/Users/kilo/workspace/charlie"),
            "-Users-kilo-workspace-charlie"
        );
    }

    // ---- background_task_ids ----

    fn bg(id: &str) -> String {
        json!({"type": "user", "toolUseResult": {"backgroundTaskId": id}}).to_string()
    }

    fn ids(list: &[&str]) -> std::collections::HashSet<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn background_task_ids_returns_deduplicated_set() {
        let jsonl = [
            bg("bush20ok3"),
            json!({"type": "user", "toolUseResult": {"stdout": "x"}}).to_string(),
            bg("b48tqxha9"),
            bg("bush20ok3"),
        ]
        .join("\n");
        assert_eq!(background_task_ids(&jsonl), ids(&["bush20ok3", "b48tqxha9"]));
    }

    #[test]
    fn background_task_ids_foreground_only_is_empty() {
        let jsonl = json!({"type": "user", "toolUseResult": {"stdout": "ok"}}).to_string();
        assert!(background_task_ids(&jsonl).is_empty());
    }

    #[test]
    fn background_task_ids_skips_broken_lines_and_continues() {
        let jsonl = format!("not json\n{}\n{{\"broken", bg("bcyiin1lh"));
        assert_eq!(background_task_ids(&jsonl), ids(&["bcyiin1lh"]));
    }

    #[test]
    fn background_task_ids_empty_string_is_empty() {
        assert!(background_task_ids("").is_empty());
    }

    // ---- parse_iso8601_ms ----

    #[test]
    fn iso_epoch_zero_and_millis() {
        assert_eq!(parse_iso8601_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(parse_iso8601_ms("1970-01-01T00:00:01.500Z"), Some(1500));
    }

    #[test]
    fn iso_known_date_and_optional_fraction() {
        assert_eq!(
            parse_iso8601_ms("2000-01-01T00:00:00Z"),
            Some(946_684_800_000)
        );
        assert_eq!(
            parse_iso8601_ms("2000-01-01T00:00:00.250Z"),
            Some(946_684_800_250)
        );
    }

    #[test]
    fn iso_rejects_malformed() {
        assert_eq!(parse_iso8601_ms("not-a-date"), None);
        assert_eq!(parse_iso8601_ms("2000-13-01T00:00:00Z"), None);
        assert_eq!(parse_iso8601_ms(""), None);
    }

    // ---- session_usage ----

    fn user_at(ts: &str, content: Value) -> String {
        json!({"type": "user", "timestamp": ts, "message": {"content": content}}).to_string()
    }

    fn assistant_usage(ts: &str, input: u64, cache_read: u64, output: u64) -> String {
        json!({
            "type": "assistant",
            "timestamp": ts,
            "message": {"content": [{"type": "text", "text": "ok"}], "usage": {
                "input_tokens": input,
                "cache_read_input_tokens": cache_read,
                "output_tokens": output,
            }},
        })
        .to_string()
    }

    #[test]
    fn usage_sums_session_and_resets_turn_on_human_prompt() {
        let jsonl = [
            user_at("2000-01-01T00:00:00Z", json!("最初")),
            assistant_usage("2000-01-01T00:00:05Z", 10, 20, 5),
            assistant_usage("2000-01-01T00:00:10Z", 1, 2, 3),
            user_at("2000-01-01T00:01:00Z", json!("次")),
            assistant_usage("2000-01-01T00:01:05Z", 100, 0, 7),
        ]
        .join("\n");
        let u = session_usage(&jsonl).unwrap();
        assert_eq!(u.session_tokens, 10 + 20 + 5 + 1 + 2 + 3 + 100 + 7);
        assert_eq!(u.turn_tokens, 100 + 7);
        assert_eq!(u.session_started_at_ms, 946_684_800_000);
        assert_eq!(u.turn_started_at_ms, 946_684_800_000 + 60_000);
    }

    #[test]
    fn usage_tool_result_user_is_not_a_turn_boundary() {
        let jsonl = [
            user_at("2000-01-01T00:00:00Z", json!("依頼")),
            assistant_usage("2000-01-01T00:00:05Z", 10, 0, 0),
            user_at(
                "2000-01-01T00:00:06Z",
                json!([{"type": "tool_result", "content": "out"}]),
            ),
            assistant_usage("2000-01-01T00:00:10Z", 5, 0, 0),
        ]
        .join("\n");
        let u = session_usage(&jsonl).unwrap();
        assert_eq!(u.turn_tokens, 15);
        assert_eq!(u.turn_started_at_ms, 946_684_800_000);
    }

    #[test]
    fn usage_turn_start_falls_back_to_session_start_without_human_prompt() {
        let jsonl = assistant_usage("2000-01-01T00:00:05Z", 4, 0, 1);
        let u = session_usage(&jsonl).unwrap();
        assert_eq!(u.session_tokens, 5);
        assert_eq!(u.turn_tokens, 5);
        assert_eq!(u.turn_started_at_ms, u.session_started_at_ms);
        assert_eq!(u.session_started_at_ms, 946_684_800_000 + 5_000);
    }

    #[test]
    fn usage_none_without_timestamped_event() {
        assert!(session_usage("").is_none());
        assert!(session_usage(r#"{"type":"summary","summary":"x"}"#).is_none());
    }

    #[test]
    fn usage_skips_broken_lines() {
        let jsonl = [
            r#"{"type":"user","broken"#.to_string(),
            assistant_usage("2000-01-01T00:00:05Z", 2, 0, 3),
        ]
        .join("\n");
        let u = session_usage(&jsonl).unwrap();
        assert_eq!(u.session_tokens, 5);
    }
}
