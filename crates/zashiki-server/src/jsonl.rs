//! Claude transcript (jsonl) parser. Ported from TS `packages/shared/src/jsonl.ts`.
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

/// Strips meta tags emitted when running skills/slash commands (command-name keeps its inner /foo).
/// The opening and closing local-command tags match independently, as in the TS regex.
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

/// Collects every background shell launch id (`toolUseResult.backgroundTaskId`) in the transcript
/// (present only for Bash run_in_background, not for foreground). Stays light on huge transcripts by
/// JSON-parsing only candidate lines. Port of TS `backgroundTaskIds`.
pub fn background_task_ids(content: &str) -> std::collections::HashSet<String> {
    let mut ids = std::collections::HashSet::new();
    for line in content.split('\n') {
        if line.is_empty() || !line.contains("\"backgroundTaskId\"") {
            continue;
        }
        let Some(event) = parse_line(line) else {
            continue;
        };
        let id = event
            .get("toolUseResult")
            .and_then(|r| r.get("backgroundTaskId"))
            .and_then(Value::as_str);
        if let Some(id) = id {
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

    // ---- last_user_or_assistant_event (ported from inf_jsonl_last_event) ----

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

    // ---- first_user_title (ported from inf_jsonl_title) ----

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

    #[test]
    fn background_task_ids_collects_ids_from_tool_use_results() {
        let content = [
            user_line(json!("依頼")),
            json!({"type":"user","toolUseResult":{"backgroundTaskId":"bg-1","stdout":""}})
                .to_string(),
            json!({"type":"user","toolUseResult":{"backgroundTaskId":"bg-2"}}).to_string(),
            // duplicate id collapses
            json!({"type":"user","toolUseResult":{"backgroundTaskId":"bg-1"}}).to_string(),
            // foreground result has no backgroundTaskId
            json!({"type":"user","toolUseResult":{"stdout":"done"}}).to_string(),
        ]
        .join("\n");
        let ids = background_task_ids(&content);
        assert_eq!(ids.len(), 2);
        assert!(ids.contains("bg-1") && ids.contains("bg-2"));
    }

    #[test]
    fn background_task_ids_ignores_non_string_or_empty_and_broken_lines() {
        let content = [
            json!({"toolUseResult":{"backgroundTaskId":123}}).to_string(),
            json!({"toolUseResult":{"backgroundTaskId":""}}).to_string(),
            "{ broken json with \"backgroundTaskId\"".to_string(),
        ]
        .join("\n");
        assert!(background_task_ids(&content).is_empty());
    }
}
