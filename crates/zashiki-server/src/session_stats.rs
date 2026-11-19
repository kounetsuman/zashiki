//! What a Claude Session did, for the Session Stats View: its transcript as a flat, chronological
//! event list. Counting is left to the client.

use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::jsonl::parse_iso8601_ms;
use crate::protocol::{SessionEvent, SessionEventDeniedBy, SessionEventKind, SessionEventOutcome};
use crate::session_links::{strip_injected_blocks, urls_in};

const MAX_TEXT_CHARS: usize = 200;
const INTERRUPT_PREFIX: &str = "[Request interrupted by user";
const USER_REJECTED_PREFIX: &str = "The user doesn't want to proceed";
const USER_REJECTED_RESULT: &str = "User rejected tool use";
const HOOK_ERROR_PREFIX: &str = "PreToolUse:";
const TOOL_USE_ERROR_TAG: &str = "<tool_use_error>";

/// Every prompt, tool call, interrupt and compaction in the main transcript, oldest first. Paths
/// under `cwd` are written relative to it.
pub fn session_events(jsonl: &str, cwd: &str) -> Vec<SessionEvent> {
    let mut events: Vec<SessionEvent> = Vec::new();
    let mut calls: HashMap<String, usize> = HashMap::new();
    let mut last_at = 0;
    for line in jsonl.lines() {
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if ["isMeta", "isCompactSummary", "isSidechain"]
            .iter()
            .any(|flag| entry.get(flag).and_then(Value::as_bool) == Some(true))
        {
            continue;
        }
        let at = entry
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_iso8601_ms)
            .unwrap_or(last_at);
        last_at = at;
        let content = entry.get("message").and_then(|m| m.get("content"));
        match entry.get("type").and_then(Value::as_str) {
            Some("user") => {
                if let Some(content) = content {
                    read_user(&entry, content, at, &mut events, &calls);
                }
            }
            Some("assistant") => {
                let tool_uses = content
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter(|item| item.get("type").and_then(Value::as_str) == Some("tool_use"));
                for item in tool_uses {
                    if let Some(id) = item.get("id").and_then(Value::as_str) {
                        calls.insert(id.to_string(), events.len());
                    }
                    events.push(tool_call(item, at, cwd));
                }
            }
            Some("system")
                if entry.get("subtype").and_then(Value::as_str) == Some("compact_boundary") =>
            {
                events.push(compaction(&entry, at));
            }
            _ => {}
        }
    }
    events
}

fn event(at: u64, kind: SessionEventKind, text: String) -> SessionEvent {
    SessionEvent {
        at,
        kind,
        text,
        tool: None,
        target: None,
        domains: Vec::new(),
        via: Vec::new(),
        outcome: None,
        denied_by: None,
        duration_ms: None,
        pre_tokens: None,
        post_tokens: None,
    }
}

fn read_user(
    entry: &Value,
    content: &Value,
    at: u64,
    events: &mut Vec<SessionEvent>,
    calls: &HashMap<String, usize>,
) {
    let results: Vec<&Value> = content
        .as_array()
        .into_iter()
        .flatten()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("tool_result"))
        .collect();
    if !results.is_empty() {
        for result in results {
            let index = result
                .get("tool_use_id")
                .and_then(Value::as_str)
                .and_then(|id| calls.get(id));
            let Some(call) = index.and_then(|&i| events.get_mut(i)) else {
                continue;
            };
            let (outcome, denied_by) = outcome_of(entry, result);
            call.outcome = Some(outcome);
            call.denied_by = denied_by;
            call.duration_ms = Some(at.saturating_sub(call.at));
        }
        return;
    }
    let text = text_of(content);
    if text.trim_start().starts_with(INTERRUPT_PREFIX) {
        events.push(event(at, SessionEventKind::Interrupt, one_line(&text)));
        return;
    }
    if !is_typed_by_a_human(entry, &text) {
        return;
    }
    let prompt = one_line(&strip_injected_blocks(&text));
    if !prompt.is_empty() {
        events.push(event(at, SessionEventKind::Prompt, prompt));
    }
}

/// A transcript without `origin` is read by its text: Claude Code's own messages start with a tag.
fn is_typed_by_a_human(entry: &Value, text: &str) -> bool {
    match entry.get("origin") {
        Some(origin) => origin.get("kind").and_then(Value::as_str) == Some("human"),
        None => !text.trim_start().starts_with('<'),
    }
}

fn text_of(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .filter(|item| item.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|item| item.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn one_line(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .chars()
        .take(MAX_TEXT_CHARS)
        .collect()
}

fn outcome_of(
    entry: &Value,
    result: &Value,
) -> (SessionEventOutcome, Option<SessionEventDeniedBy>) {
    let decision = entry.get("permissionDecision");
    if decision
        .and_then(|d| d.get("decision"))
        .and_then(Value::as_str)
        == Some("reject")
    {
        let by = match decision
            .and_then(|d| d.get("reasonType"))
            .and_then(Value::as_str)
        {
            Some("hook") => SessionEventDeniedBy::Hook,
            Some("classifier") => SessionEventDeniedBy::Classifier,
            _ => SessionEventDeniedBy::Rule,
        };
        return (SessionEventOutcome::Denied, Some(by));
    }
    let text = result.get("content").map(text_of).unwrap_or_default();
    let text = text.trim_start();
    let text = text.strip_prefix(TOOL_USE_ERROR_TAG).unwrap_or(text);
    if text.starts_with(USER_REJECTED_PREFIX)
        || entry.get("toolUseResult").and_then(Value::as_str) == Some(USER_REJECTED_RESULT)
    {
        return (
            SessionEventOutcome::Denied,
            Some(SessionEventDeniedBy::User),
        );
    }
    if text.starts_with(HOOK_ERROR_PREFIX) {
        return (
            SessionEventOutcome::Denied,
            Some(SessionEventDeniedBy::Hook),
        );
    }
    if text.starts_with(INTERRUPT_PREFIX)
        || entry
            .get("toolUseResult")
            .and_then(Value::as_str)
            .is_some_and(|r| r.starts_with(INTERRUPT_PREFIX))
    {
        return (SessionEventOutcome::Interrupted, None);
    }
    if result.get("is_error").and_then(Value::as_bool) == Some(true) {
        (SessionEventOutcome::Failed, None)
    } else {
        (SessionEventOutcome::Ok, None)
    }
}

fn tool_call(item: &Value, at: u64, cwd: &str) -> SessionEvent {
    let name = item.get("name").and_then(Value::as_str).unwrap_or("");
    let input = item.get("input").unwrap_or(&Value::Null);
    let first = |keys: &[&str]| {
        keys.iter()
            .find_map(|key| input.get(key).and_then(Value::as_str))
            .unwrap_or("")
    };
    let mut call = match name {
        "Read" | "NotebookRead" => file_call(
            at,
            SessionEventKind::Read,
            first(&["file_path", "notebook_path"]),
            cwd,
        ),
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => file_call(
            at,
            SessionEventKind::Edit,
            first(&["file_path", "notebook_path"]),
            cwd,
        ),
        "Bash" => {
            let command = first(&["command"]);
            let mut call = event(at, SessionEventKind::Command, one_line(command));
            call.target = Some(command_group(command));
            (call.domains, call.via) = command_domains(command);
            call
        }
        "WebFetch" => web_call(at, first(&["url"])),
        _ if name.ends_with("browser_navigate") => web_call(at, first(&["url"])),
        "Grep" | "Glob" => event(
            at,
            SessionEventKind::Search,
            one_line(first(&["pattern", "query"])),
        ),
        "WebSearch" => event(at, SessionEventKind::Search, one_line(first(&["query"]))),
        "Agent" | "Task" => event(
            at,
            SessionEventKind::Subagent,
            one_line(first(&["description"])),
        ),
        "Skill" => event(at, SessionEventKind::Skill, one_line(first(&["skill"]))),
        _ => event(at, SessionEventKind::Tool, name.to_string()),
    };
    call.tool = Some(name.to_string());
    call
}

fn file_call(at: u64, kind: SessionEventKind, path: &str, cwd: &str) -> SessionEvent {
    let path = relative_to(path, cwd);
    let mut call = event(at, kind, one_line(path));
    call.target = Some(path.to_string());
    call
}

fn relative_to<'a>(path: &'a str, cwd: &str) -> &'a str {
    path.strip_prefix(cwd.trim_end_matches('/'))
        .and_then(|rest| rest.strip_prefix('/'))
        .filter(|rest| !rest.is_empty())
        .unwrap_or(path)
}

fn web_call(at: u64, url: &str) -> SessionEvent {
    let mut call = event(at, SessionEventKind::Web, one_line(url));
    call.domains = domains_of(urls_in(url));
    call
}

fn compaction(entry: &Value, at: u64) -> SessionEvent {
    let metadata = entry.get("compactMetadata");
    let tokens = |key: &str| metadata.and_then(|m| m.get(key)).and_then(Value::as_u64);
    let trigger = metadata
        .and_then(|m| m.get("trigger"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let mut call = event(at, SessionEventKind::Compaction, trigger.to_string());
    call.pre_tokens = tokens("preTokens");
    call.post_tokens = tokens("postTokens");
    call
}

/// The words of each command in a shell line, without leading `VAR=value` assignments.
fn command_words(command: &str) -> impl Iterator<Item = (&str, Vec<&str>)> {
    static SEPARATOR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"&&|\|\||[;|\n]").unwrap());
    static ASSIGNMENT: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*=").unwrap());
    SEPARATOR
        .split(command)
        .map(|segment| {
            let words: Vec<&str> = segment
                .split_whitespace()
                .skip_while(|word| ASSIGNMENT.is_match(word))
                .collect();
            (segment, words)
        })
        .filter(|(_, words)| !words.is_empty())
}

fn program<'a>(words: &[&'a str]) -> &'a str {
    words[0].rsplit('/').next().unwrap_or(words[0])
}

/// The program a shell line runs, after any `cd`, plus its subcommand (`pnpm test`, `git log`).
fn command_group(command: &str) -> String {
    static SUBCOMMAND: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^[a-z][a-z0-9:_-]*$").unwrap());
    let mut only_cd = false;
    for (_, words) in command_words(command) {
        let program = program(&words);
        if program == "cd" {
            only_cd = true;
            continue;
        }
        return match words.get(1) {
            Some(arg) if SUBCOMMAND.is_match(arg) => format!("{program} {arg}"),
            _ => program.to_string(),
        };
    }
    if only_cd {
        "cd".to_string()
    } else {
        String::new()
    }
}

/// The hosts a shell line reaches through `curl` / `wget`, and which of the two reached them.
fn command_domains(command: &str) -> (Vec<String>, Vec<String>) {
    let mut urls = Vec::new();
    let mut via: Vec<String> = Vec::new();
    for (segment, words) in command_words(command) {
        let program = program(&words);
        if !matches!(program, "curl" | "wget") {
            continue;
        }
        let found = urls_in(segment);
        if !found.is_empty() && !via.iter().any(|p| p == program) {
            via.push(program.to_string());
        }
        urls.extend(found);
    }
    (domains_of(urls), via)
}

fn domains_of<'a>(urls: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut domains: Vec<String> = Vec::new();
    for host in urls.into_iter().filter_map(host_of) {
        if !domains.contains(&host) {
            domains.push(host);
        }
    }
    domains
}

fn host_of(url: &str) -> Option<String> {
    let (_, rest) = url.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next()?;
    let host_port = authority.rsplit('@').next()?;
    let host = match host_port.strip_prefix('[') {
        Some(bracketed) => bracketed.split(']').next()?,
        None => host_port.split(':').next()?,
    };
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{SessionEventDeniedBy, SessionEventKind, SessionEventOutcome};
    use serde_json::{json, Value};

    const CWD: &str = "/work/repo";
    const T0: &str = "2026-11-19T04:29:33.787Z";
    const T0_MS: u64 = 1_795_062_573_787;
    const T1: &str = "2026-11-19T04:29:35.287Z";

    fn jsonl(lines: &[Value]) -> String {
        lines
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn events(lines: &[Value]) -> Vec<SessionEvent> {
        session_events(&jsonl(lines), CWD)
    }

    fn user(content: Value) -> Value {
        json!({"type": "user", "timestamp": T0, "message": {"role": "user", "content": content}})
    }

    fn human(content: Value) -> Value {
        let mut line = user(content);
        line["origin"] = json!({"kind": "human"});
        line
    }

    fn tool_use(id: &str, name: &str, input: Value) -> Value {
        json!({"type": "assistant", "timestamp": T0, "message": {"role": "assistant", "content": [
            {"type": "tool_use", "id": id, "name": name, "input": input}
        ]}})
    }

    fn tool_result(id: &str, content: Value, is_error: bool) -> Value {
        json!({"type": "user", "timestamp": T1, "message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": id, "content": content, "is_error": is_error}
        ]}})
    }

    fn one(lines: &[Value]) -> SessionEvent {
        let found = events(lines);
        assert_eq!(found.len(), 1, "{found:?}");
        found.into_iter().next().unwrap()
    }

    fn call(name: &str, input: Value) -> SessionEvent {
        one(&[tool_use("t1", name, input)])
    }

    fn kinds(found: &[SessionEvent]) -> Vec<SessionEventKind> {
        found.iter().map(|e| e.kind).collect()
    }

    #[test]
    fn a_human_prompt_is_its_first_non_empty_line_at_its_timestamp() {
        let event = one(&[human(json!("\n  fix the build  \nand then test"))]);
        assert_eq!(event.kind, SessionEventKind::Prompt);
        assert_eq!(event.text, "fix the build");
        assert_eq!(event.at, T0_MS);
        assert_eq!(event.tool, None);
        assert_eq!(event.outcome, None);
    }

    #[test]
    fn a_prompt_without_origin_is_plain_user_text() {
        let event = one(&[user(json!([{"type": "text", "text": "typed by hand"}]))]);
        assert_eq!(event.kind, SessionEventKind::Prompt);
        assert_eq!(event.text, "typed by hand");
    }

    #[test]
    fn injected_reminders_are_stripped_from_a_prompt() {
        let event = one(&[human(json!(
            "<system-reminder>\nremember\n</system-reminder>\nthe real ask"
        ))]);
        assert_eq!(event.text, "the real ask");
    }

    #[test]
    fn a_prompt_is_cut_to_one_line_of_at_most_200_characters() {
        let event = one(&[human(json!("あ".repeat(300)))]);
        assert_eq!(event.text.chars().count(), 200);
    }

    #[test]
    fn user_text_not_typed_by_a_human_is_not_a_prompt() {
        let found = events(&[
            json!({"type": "user", "timestamp": T0, "origin": {"kind": "task-notification"}, "message": {"content": "done"}}),
            json!({"type": "user", "timestamp": T0, "origin": {"kind": "peer"}, "message": {"content": "hello"}}),
            user(json!("<command-name>/clear</command-name>")),
            user(json!("<bash-input>ls</bash-input>")),
            user(json!("<bash-stdout>a</bash-stdout>")),
            user(json!("<local-command-stdout>ok</local-command-stdout>")),
            user(json!("<task-notification>x</task-notification>")),
            json!({"type": "user", "timestamp": T0, "isMeta": true, "message": {"content": "meta"}}),
        ]);
        assert!(found.is_empty(), "{found:?}");
    }

    #[test]
    fn a_human_prompt_that_is_only_injected_blocks_is_skipped() {
        assert!(events(&[human(json!("<system-reminder>x</system-reminder>"))]).is_empty());
    }

    #[test]
    fn an_interrupt_is_matched_by_its_prefix() {
        let found = events(&[
            user(json!([{"type": "text", "text": "[Request interrupted by user]"}])),
            user(
                json!([{"type": "text", "text": "[Request interrupted by user for tool use]\nthen more"}]),
            ),
        ]);
        assert_eq!(
            kinds(&found),
            vec![SessionEventKind::Interrupt, SessionEventKind::Interrupt]
        );
        assert_eq!(found[1].text, "[Request interrupted by user for tool use]");
    }

    #[test]
    fn a_compaction_carries_its_token_counts() {
        let event = one(&[json!({
            "type": "system", "subtype": "compact_boundary", "timestamp": T0,
            "compactMetadata": {"trigger": "auto", "preTokens": 162_000, "postTokens": 31_000}
        })]);
        assert_eq!(event.kind, SessionEventKind::Compaction);
        assert_eq!(event.pre_tokens, Some(162_000));
        assert_eq!(event.post_tokens, Some(31_000));
        assert_eq!(event.at, T0_MS);
    }

    #[test]
    fn other_system_lines_are_ignored() {
        assert!(
            events(&[json!({"type": "system", "subtype": "informational", "timestamp": T0})])
                .is_empty()
        );
    }

    #[test]
    fn sidechain_meta_and_compact_summary_lines_are_skipped() {
        let found = events(&[
            json!({"type": "user", "timestamp": T0, "isSidechain": true, "message": {"content": "side"}}),
            json!({"type": "user", "timestamp": T0, "isCompactSummary": true, "message": {"content": "summary"}}),
            json!({"type": "assistant", "timestamp": T0, "isSidechain": true, "message": {"content": [
                {"type": "tool_use", "id": "s", "name": "Read", "input": {"file_path": "/x"}}
            ]}}),
            json!({"type": "user", "timestamp": T0, "isSidechain": false, "message": {"content": "main"}}),
        ]);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].text, "main");
    }

    #[test]
    fn reads_and_edits_are_keyed_by_their_path_relative_to_cwd() {
        let cases = [
            (
                "Read",
                json!({"file_path": "/work/repo/src/a.rs"}),
                SessionEventKind::Read,
                "src/a.rs",
            ),
            (
                "NotebookRead",
                json!({"notebook_path": "/work/repo/n.ipynb"}),
                SessionEventKind::Read,
                "n.ipynb",
            ),
            (
                "Edit",
                json!({"file_path": "/work/repo/src/a.rs", "old_string": "a"}),
                SessionEventKind::Edit,
                "src/a.rs",
            ),
            (
                "Write",
                json!({"file_path": "/elsewhere/b.md"}),
                SessionEventKind::Edit,
                "/elsewhere/b.md",
            ),
            (
                "MultiEdit",
                json!({"file_path": "/work/repository/c.ts"}),
                SessionEventKind::Edit,
                "/work/repository/c.ts",
            ),
            (
                "NotebookEdit",
                json!({"notebook_path": "/work/repo/n.ipynb"}),
                SessionEventKind::Edit,
                "n.ipynb",
            ),
        ];
        for (name, input, kind, path) in cases {
            let event = call(name, input);
            assert_eq!(
                (event.kind, event.text.as_str(), event.target.as_deref()),
                (kind, path, Some(path)),
                "{name}"
            );
            assert_eq!(event.tool.as_deref(), Some(name));
            assert_eq!(event.outcome, None);
        }
    }

    #[test]
    fn every_other_tool_kind_takes_its_text_from_its_input() {
        let cases = [
            (
                "Bash",
                json!({"command": "ls -la\necho hi"}),
                SessionEventKind::Command,
                "ls -la",
            ),
            (
                "WebFetch",
                json!({"url": "https://example.com/a", "prompt": "x"}),
                SessionEventKind::Web,
                "https://example.com/a",
            ),
            (
                "mcp__playwright__browser_navigate",
                json!({"url": "https://example.org/"}),
                SessionEventKind::Web,
                "https://example.org/",
            ),
            (
                "Grep",
                json!({"pattern": "fn main"}),
                SessionEventKind::Search,
                "fn main",
            ),
            (
                "Grep",
                json!({"query": "needle"}),
                SessionEventKind::Search,
                "needle",
            ),
            (
                "Glob",
                json!({"pattern": "**/*.ts"}),
                SessionEventKind::Search,
                "**/*.ts",
            ),
            (
                "WebSearch",
                json!({"query": "rust serde"}),
                SessionEventKind::Search,
                "rust serde",
            ),
            (
                "Agent",
                json!({"description": "Explore code", "subagent_type": "Explore"}),
                SessionEventKind::Subagent,
                "Explore code",
            ),
            (
                "Task",
                json!({"description": "Plan it"}),
                SessionEventKind::Subagent,
                "Plan it",
            ),
            (
                "Skill",
                json!({"skill": "simplify"}),
                SessionEventKind::Skill,
                "simplify",
            ),
            (
                "TodoWrite",
                json!({"todos": []}),
                SessionEventKind::Tool,
                "TodoWrite",
            ),
        ];
        for (name, input, kind, text) in cases {
            let event = call(name, input);
            assert_eq!((event.kind, event.text.as_str()), (kind, text), "{name}");
            assert_eq!(event.tool.as_deref(), Some(name));
        }
    }

    #[test]
    fn only_reads_edits_and_commands_have_a_target() {
        assert_eq!(
            call("WebFetch", json!({"url": "https://example.com/"})).target,
            None
        );
        assert_eq!(call("Grep", json!({"pattern": "x"})).target, None);
    }

    #[test]
    fn commands_are_grouped_by_their_leading_program() {
        let cases = [
            ("cd x && pnpm test --run", "pnpm test"),
            ("git -C a status", "git"),
            ("ls -la", "ls"),
            ("FOO=1 cargo test", "cargo test"),
            ("cd a; cd b\n/usr/bin/git log --oneline", "git log"),
            ("gh pr view 5 | head", "gh pr"),
            ("false || npx vitest run", "false"),
            ("pnpm -F client build:web", "pnpm"),
            ("npm run build:web", "npm run"),
            ("./scripts/check.sh", "check.sh"),
            ("cd somewhere", "cd"),
        ];
        for (command, group) in cases {
            assert_eq!(
                call("Bash", json!({"command": command})).target.as_deref(),
                Some(group),
                "{command}"
            );
        }
    }

    #[test]
    fn domains_are_the_lowercased_hosts_without_ports() {
        assert_eq!(
            call(
                "WebFetch",
                json!({"url": "https://Docs.Example.com:8443/a?b"})
            )
            .domains,
            vec!["docs.example.com"]
        );
        assert_eq!(
            call(
                "mcp__playwright__browser_navigate",
                json!({"url": "http://localhost:5173/"})
            )
            .domains,
            vec!["localhost"]
        );
    }

    #[test]
    fn a_command_reaches_domains_only_through_curl_or_wget() {
        let event = call(
            "Bash",
            json!({"command": "curl -s \"https://api.example.com/x\" | jq . && wget https://dl.example.org/f https://dl.example.org/g && gh pr view https://github.com/o/r/pull/1"}),
        );
        assert_eq!(event.domains, vec!["api.example.com", "dl.example.org"]);
        assert!(call("Bash", json!({"command": "echo https://example.com"}))
            .domains
            .is_empty());
        assert_eq!(
            call(
                "Bash",
                json!({"command": "X=1 /usr/bin/curl https://u@h.example.com/"})
            )
            .domains,
            vec!["h.example.com"]
        );
    }

    #[test]
    fn a_command_names_the_programs_that_reached_its_domains() {
        let multi_line = call(
            "Bash",
            json!({"command": format!("echo start\n{}\ncurl https://late.example/", "x".repeat(300))}),
        );
        assert_eq!(multi_line.domains, vec!["late.example"]);
        assert_eq!(multi_line.via, vec!["curl"]);

        let after_echo = call(
            "Bash",
            json!({"command": "echo 'no curl' && wget https://b.example/f"}),
        );
        assert_eq!(after_echo.domains, vec!["b.example"]);
        assert_eq!(after_echo.via, vec!["wget"]);

        let both = call(
            "Bash",
            json!({"command": "curl https://a.example/ && wget https://b.example/ && curl https://c.example/"}),
        );
        assert_eq!(both.via, vec!["curl", "wget"]);

        assert!(call("Bash", json!({"command": "curl --version"}))
            .via
            .is_empty());
        assert!(call("WebFetch", json!({"url": "https://a.example/"}))
            .via
            .is_empty());
    }

    #[test]
    fn other_tools_reach_no_domains() {
        assert!(call("Read", json!({"file_path": "https://example.com"}))
            .domains
            .is_empty());
    }

    #[test]
    fn a_result_sets_the_outcome_and_duration() {
        let event = one(&[
            tool_use("t1", "Bash", json!({"command": "ls"})),
            tool_result("t1", json!("a\nb"), false),
        ]);
        assert_eq!(event.outcome, Some(SessionEventOutcome::Ok));
        assert_eq!(event.duration_ms, Some(1_500));
        assert_eq!(event.denied_by, None);
    }

    #[test]
    fn a_result_without_is_error_is_ok() {
        let event = one(&[
            tool_use("t1", "Bash", json!({"command": "grep x"})),
            json!({"type": "user", "timestamp": T1, "message": {"content": [
                {"type": "tool_result", "tool_use_id": "t1", "content": [{"type": "text", "text": "No matches"}]}
            ]}}),
        ]);
        assert_eq!(event.outcome, Some(SessionEventOutcome::Ok));
    }

    #[test]
    fn an_error_result_is_a_failure() {
        let mut result = tool_result("t1", json!("Exit code 1\nboom"), true);
        result["toolUseResult"] = json!("Error: Exit code 1\nboom");
        let event = one(&[
            tool_use("t1", "Bash", json!({"command": "pnpm test"})),
            result,
        ]);
        assert_eq!(event.outcome, Some(SessionEventOutcome::Failed));
        assert_eq!(event.denied_by, None);
    }

    #[test]
    fn a_call_the_user_interrupted_is_interrupted_not_failed() {
        let event = one(&[
            tool_use("t1", "Bash", json!({"command": "sleep 99"})),
            tool_result(
                "t1",
                json!("[Request interrupted by user for tool use]"),
                true,
            ),
        ]);
        assert_eq!(event.outcome, Some(SessionEventOutcome::Interrupted));
        assert_eq!(event.denied_by, None);

        let mut result = tool_result("t1", json!([{"type": "text", "text": "partial"}]), true);
        result["toolUseResult"] = json!("[Request interrupted by user]");
        let event = one(&[
            tool_use("t1", "Bash", json!({"command": "sleep 99"})),
            result,
        ]);
        assert_eq!(event.outcome, Some(SessionEventOutcome::Interrupted));
    }

    #[test]
    fn a_call_still_running_has_no_outcome() {
        let found = events(&[
            tool_use("t1", "Bash", json!({"command": "sleep 9"})),
            tool_result("other", json!("x"), true),
        ]);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].outcome, None);
        assert_eq!(found[0].duration_ms, None);
    }

    fn denial(result: Value) -> (Option<SessionEventOutcome>, Option<SessionEventDeniedBy>) {
        let event = one(&[
            tool_use("t1", "Bash", json!({"command": "rm -rf x"})),
            result,
        ]);
        (event.outcome, event.denied_by)
    }

    fn denied(
        by: SessionEventDeniedBy,
    ) -> (Option<SessionEventOutcome>, Option<SessionEventDeniedBy>) {
        (Some(SessionEventOutcome::Denied), Some(by))
    }

    #[test]
    fn a_user_rejection_is_denied_by_the_user() {
        assert_eq!(
            denial(tool_result(
                "t1",
                json!("The user doesn't want to proceed with this tool use. The tool use was rejected."),
                true
            )),
            denied(SessionEventDeniedBy::User)
        );
        let mut result = tool_result("t1", json!([{"type": "text", "text": "rejected"}]), true);
        result["toolUseResult"] = json!("User rejected tool use");
        assert_eq!(denial(result), denied(SessionEventDeniedBy::User));
    }

    #[test]
    fn a_hook_block_is_denied_by_a_hook() {
        let mut result = tool_result("t1", json!("PreToolUse:Bash hook error: blocked"), true);
        result["permissionDecision"] =
            json!({"decision": "reject", "source": "hook", "reasonType": "hook"});
        assert_eq!(denial(result), denied(SessionEventDeniedBy::Hook));
        assert_eq!(
            denial(tool_result(
                "t1",
                json!("<tool_use_error>PreToolUse:mcp__x hook error: no</tool_use_error>"),
                true
            )),
            denied(SessionEventDeniedBy::Hook)
        );
    }

    #[test]
    fn a_classifier_rejection_is_denied_by_the_classifier() {
        let mut result = tool_result("t1", json!("denied"), true);
        result["permissionDecision"] = json!({"decision": "reject", "reasonType": "classifier"});
        assert_eq!(denial(result), denied(SessionEventDeniedBy::Classifier));
    }

    #[test]
    fn a_settings_rule_rejection_is_denied_by_a_rule() {
        let mut result = tool_result("t1", json!("denied"), true);
        result["permissionDecision"] = json!({
            "decision": "reject", "reasonType": "subcommandResults", "ruleSource": "userSettings"
        });
        assert_eq!(denial(result), denied(SessionEventDeniedBy::Rule));
    }

    #[test]
    fn an_accepted_permission_decision_is_not_a_denial() {
        let mut result = tool_result("t1", json!("ok"), false);
        result["permissionDecision"] = json!({"decision": "accept", "reasonType": "rule"});
        assert_eq!(denial(result), (Some(SessionEventOutcome::Ok), None));
    }

    #[test]
    fn events_keep_transcript_order() {
        let found = events(&[
            human(json!("go")),
            tool_use("t1", "Read", json!({"file_path": "/work/repo/a"})),
            tool_result("t1", json!("x"), false),
            tool_use("t2", "Edit", json!({"file_path": "/work/repo/a"})),
        ]);
        assert_eq!(
            kinds(&found),
            vec![
                SessionEventKind::Prompt,
                SessionEventKind::Read,
                SessionEventKind::Edit
            ]
        );
    }

    #[test]
    fn assistant_text_and_thinking_are_not_events() {
        assert!(events(&[
            json!({"type": "assistant", "timestamp": T0, "message": {"content": [
                {"type": "text", "text": "hi"}, {"type": "thinking", "thinking": "hm"}
            ]}})
        ])
        .is_empty());
    }

    #[test]
    fn broken_lines_are_ignored() {
        let content = format!("{{not json\n{}", human(json!("ok")));
        assert_eq!(session_events(&content, CWD).len(), 1);
    }

    #[test]
    fn the_wire_shape_is_camel_case_with_snake_case_values() {
        let mut result = tool_result("t1", json!("no"), true);
        result["permissionDecision"] = json!({"decision": "reject", "reasonType": "classifier"});
        let event = one(&[
            tool_use("t1", "WebFetch", json!({"url": "https://a.example/"})),
            result,
        ]);
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            json!({
                "at": T0_MS, "kind": "web", "text": "https://a.example/", "tool": "WebFetch",
                "domains": ["a.example"], "outcome": "denied", "deniedBy": "classifier", "durationMs": 1500
            })
        );
    }
}
