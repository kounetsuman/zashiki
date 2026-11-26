//! URLs a Claude Session's transcript has seen, for the session links popover.
//! Only the content string is parsed here; reading the transcript is `claude_projects`' job.

use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::protocol::{
    GithubLinkRef, SessionEventOutcome, SessionLink, SessionLinkKind, SessionLinkTab,
};
use crate::session_stats::{outcome_of, reads_a_page};

const USER_SOURCE: &str = "user";
const ASSISTANT_SOURCE: &str = "assistant";
const WEB_SEARCH_TOOL: &str = "WebSearch";

/// Every link in the transcript, deduplicated per tab and ordered newest appearance first. A repeated
/// link keeps the source it first appeared with.
pub fn session_links(jsonl: &str) -> Vec<SessionLink> {
    let mut collector = Collector::default();
    let mut tool_names: HashMap<String, String> = HashMap::new();
    let mut page_urls: HashMap<String, String> = HashMap::new();
    for line in jsonl.lines() {
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if is_flagged(&entry, "isMeta") || is_flagged(&entry, "isCompactSummary") {
            continue;
        }
        let Some(content) = entry.get("message").and_then(|m| m.get("content")) else {
            continue;
        };
        match entry.get("type").and_then(Value::as_str) {
            Some("user") => {
                collect_user_text(&mut collector, content);
                collect_web_search_results(&mut collector, &entry, content, &tool_names);
                if !is_flagged(&entry, "isSidechain") {
                    collect_failed_page_reads(&mut collector, &entry, content, &tool_names, &page_urls);
                }
            }
            Some("assistant") => {
                collect_assistant(&mut collector, content, &mut tool_names, &mut page_urls);
            }
            _ => {}
        }
    }
    collector.into_links()
}

fn is_flagged(entry: &Value, flag: &str) -> bool {
    entry.get(flag).and_then(Value::as_bool) == Some(true)
}

fn collect_user_text(collector: &mut Collector, content: &Value) {
    let texts: Vec<&str> = match content {
        Value::String(text) => vec![text],
        Value::Array(items) => items
            .iter()
            .filter(|item| item.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|item| item.get("text").and_then(Value::as_str))
            .collect(),
        _ => Vec::new(),
    };
    for text in texts {
        for url in urls_in(&strip_injected_blocks(text)) {
            collector.add(SessionLinkTab::Conversation, url, USER_SOURCE, None);
        }
    }
}

fn collect_assistant(
    collector: &mut Collector,
    content: &Value,
    tool_names: &mut HashMap<String, String>,
    page_urls: &mut HashMap<String, String>,
) {
    let Value::Array(items) = content else {
        return;
    };
    for item in items {
        match item.get("type").and_then(Value::as_str) {
            Some("text") => {
                for url in urls_in(item.get("text").and_then(Value::as_str).unwrap_or("")) {
                    collector.add(SessionLinkTab::Conversation, url, ASSISTANT_SOURCE, None);
                }
            }
            Some("tool_use") => {
                let name = item.get("name").and_then(Value::as_str).unwrap_or("");
                if let Some(id) = item.get("id").and_then(Value::as_str) {
                    tool_names.insert(id.to_string(), name.to_string());
                    let url = item.get("input").and_then(|i| i.get("url")).and_then(Value::as_str);
                    if let Some(url) = url.filter(|_| reads_a_page(name)) {
                        page_urls.insert(id.to_string(), url.to_string());
                    }
                }
                let mut strings = Vec::new();
                if let Some(input) = item.get("input") {
                    strings_in(input, &mut strings);
                }
                for text in strings {
                    for url in urls_in(text) {
                        collector.add(SessionLinkTab::AiReferenced, url, name, None);
                    }
                }
            }
            _ => {}
        }
    }
}

/// The `{title, url}` hits of a WebSearch, read from the structured `toolUseResult` of the entry that
/// answers a WebSearch tool_use.
fn collect_web_search_results(
    collector: &mut Collector,
    entry: &Value,
    content: &Value,
    tool_names: &HashMap<String, String>,
) {
    let answers_web_search = content.as_array().is_some_and(|items| {
        items.iter().any(|item| {
            item.get("tool_use_id")
                .and_then(Value::as_str)
                .and_then(|id| tool_names.get(id))
                .is_some_and(|name| name == WEB_SEARCH_TOOL)
        })
    });
    if !answers_web_search {
        return;
    }
    let Some(results) = entry
        .get("toolUseResult")
        .and_then(|r| r.get("results"))
        .and_then(Value::as_array)
    else {
        return;
    };
    let hits = results
        .iter()
        .filter_map(|result| result.get("content").and_then(Value::as_array))
        .flatten();
    for hit in hits {
        let Some(url) = hit.get("url").and_then(Value::as_str) else {
            continue;
        };
        let title = hit.get("title").and_then(Value::as_str);
        for url in urls_in(url).into_iter().take(1) {
            collector.add(SessionLinkTab::AiReferenced, url, WEB_SEARCH_TOOL, title);
        }
    }
}

/// A page read that failed or was denied lands in the failed tab under its latest tool and reason; a
/// later read of the same page that succeeds takes it out again.
fn collect_failed_page_reads(
    collector: &mut Collector,
    entry: &Value,
    content: &Value,
    tool_names: &HashMap<String, String>,
    page_urls: &HashMap<String, String>,
) {
    let Value::Array(items) = content else {
        return;
    };
    for result in items {
        let Some(id) = result.get("tool_use_id").and_then(Value::as_str) else {
            continue;
        };
        let (Some(tool), Some(raw_url)) = (tool_names.get(id), page_urls.get(id)) else {
            continue;
        };
        let Some(url) = urls_in(raw_url).into_iter().next() else {
            continue;
        };
        match outcome_of(entry, result) {
            (SessionEventOutcome::Ok, _) => collector.remove(SessionLinkTab::Failed, url),
            (SessionEventOutcome::Failed | SessionEventOutcome::Denied, denied_by) => {
                let link = collector.add(SessionLinkTab::Failed, url, tool, None);
                link.source = tool.clone();
                link.denied_by = denied_by;
            }
            _ => {}
        }
    }
}

fn strings_in<'a>(value: &'a Value, out: &mut Vec<&'a str>) {
    match value {
        Value::String(s) => out.push(s),
        Value::Array(items) => items.iter().for_each(|v| strings_in(v, out)),
        Value::Object(map) => map.values().for_each(|v| strings_in(v, out)),
        _ => {}
    }
}

/// Removes the blocks Claude Code injects into a user message (reminders, command output, background
/// task notices), keeping what the user typed (slash-command arguments and `!` shell input included).
pub(crate) fn strip_injected_blocks(text: &str) -> std::borrow::Cow<'_, str> {
    static INJECTED: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r"(?s)<system-reminder>.*?</system-reminder>|<command-(?:name|message)>.*?</command-(?:name|message)>|<local-command-[a-z]+>.*?</local-command-[a-z]+>|<bash-(?:stdout|stderr)>.*?</bash-(?:stdout|stderr)>|<task-notification>.*?</task-notification>",
        )
        .unwrap()
    });
    INJECTED.replace_all(text, " ")
}

/// URLs as written in prose: a URL ends at whitespace, a quote, `<>`, a backtick, or the first non-ASCII
/// character, since Japanese text often follows one with no space between.
pub(crate) fn urls_in(text: &str) -> Vec<&str> {
    static URL: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#"https?://[\x21-\x7E--["'<>`]]+"#).unwrap());
    URL.find_iter(text)
        .map(|m| {
            let url = m.as_str();
            trim_url(url.split_once("](").map_or(url, |(target, _)| target))
        })
        .filter(|url| url.split_once("://").is_some_and(|(_, rest)| !rest.is_empty()))
        .collect()
}

fn trim_url(mut url: &str) -> &str {
    while let Some(last) = url.chars().last() {
        let unbalanced = |open: char| {
            url.matches(open).count() < url.matches(last).count()
        };
        let trailing = match last {
            '.' | ',' | ';' | ':' | '!' | '?' => true,
            ')' => unbalanced('('),
            ']' => unbalanced('['),
            _ => false,
        };
        if !trailing {
            break;
        }
        url = &url[..url.len() - last.len_utf8()];
    }
    url
}

/// The link a URL is listed as: a GitHub pull request or issue, whatever sub-page or letter case,
/// collapses to its canonical lowercase URL.
fn classify(url: &str) -> (String, SessionLinkKind, Option<GithubLinkRef>) {
    match github_ref(url) {
        Some((kind, path, github)) => (
            format!(
                "https://github.com/{}/{}/{path}/{}",
                github.owner, github.repo, github.number
            ),
            kind,
            Some(github),
        ),
        None => (url.to_string(), SessionLinkKind::Other, None),
    }
}

fn github_ref(url: &str) -> Option<(SessionLinkKind, &'static str, GithubLinkRef)> {
    let (_, rest) = url.split_once("://")?;
    let rest = rest.split(['?', '#']).next().unwrap_or("");
    let mut segments = rest.split('/');
    let host = segments.next()?.to_ascii_lowercase();
    if host != "github.com" && host != "www.github.com" {
        return None;
    }
    let owner = segments.next().filter(|s| !s.is_empty())?;
    let repo = segments.next().filter(|s| !s.is_empty())?;
    let (kind, path) = match segments.next()? {
        "pull" => (SessionLinkKind::Pr, "pull"),
        "issues" => (SessionLinkKind::Issue, "issues"),
        _ => return None,
    };
    let number = segments.next()?.parse::<u64>().ok()?;
    let github = GithubLinkRef {
        owner: owner.to_ascii_lowercase(),
        repo: repo.to_ascii_lowercase(),
        number,
        ..Default::default()
    };
    Some((kind, path, github))
}

struct Seen {
    link: SessionLink,
    last_seen_at: usize,
}

#[derive(Default)]
struct Collector {
    seen: HashMap<(SessionLinkTab, String), Seen>,
    appearances: usize,
}

impl Collector {
    fn add(
        &mut self,
        tab: SessionLinkTab,
        raw_url: &str,
        source: &str,
        title: Option<&str>,
    ) -> &mut SessionLink {
        self.appearances += 1;
        let (url, kind, github) = classify(raw_url);
        let seen = self.seen.entry((tab, url.clone())).or_insert_with(|| Seen {
            link: SessionLink {
                url,
                tab,
                kind,
                source: source.to_string(),
                title: None,
                github,
                page_title: None,
                favicon_origin: None,
                denied_by: None,
            },
            last_seen_at: 0,
        });
        seen.last_seen_at = self.appearances;
        if seen.link.title.is_none() {
            seen.link.title = title.map(str::to_string);
        }
        &mut seen.link
    }

    fn remove(&mut self, tab: SessionLinkTab, raw_url: &str) {
        self.seen.remove(&(tab, classify(raw_url).0));
    }

    fn into_links(self) -> Vec<SessionLink> {
        let mut seen: Vec<Seen> = self.seen.into_values().collect();
        seen.sort_by(|a, b| b.last_seen_at.cmp(&a.last_seen_at));
        seen.into_iter().map(|s| s.link).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{GithubLinkRef, SessionEventDeniedBy, SessionLinkKind, SessionLinkTab};
    use serde_json::{json, Value};

    fn jsonl(lines: &[Value]) -> String {
        lines.iter().map(Value::to_string).collect::<Vec<_>>().join("\n")
    }

    fn user(content: Value) -> Value {
        json!({"type": "user", "message": {"role": "user", "content": content}})
    }

    fn assistant(content: Value) -> Value {
        json!({"type": "assistant", "message": {"role": "assistant", "content": content}})
    }

    fn urls(links: &[SessionLink], tab: SessionLinkTab) -> Vec<&str> {
        links
            .iter()
            .filter(|l| l.tab == tab)
            .map(|l| l.url.as_str())
            .collect()
    }

    fn conversation(content: &str) -> Vec<String> {
        urls(&session_links(&jsonl(&[user(json!(content))])), SessionLinkTab::Conversation)
            .into_iter()
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn user_text_and_assistant_text_land_in_the_conversation_tab() {
        let links = session_links(&jsonl(&[
            user(json!("see https://example.com/a")),
            assistant(json!([{"type": "text", "text": "try https://example.com/b"}])),
        ]));
        let sources: Vec<(&str, &str)> = links
            .iter()
            .map(|l| (l.url.as_str(), l.source.as_str()))
            .collect();
        assert_eq!(
            sources,
            vec![
                ("https://example.com/b", "assistant"),
                ("https://example.com/a", "user"),
            ]
        );
        assert!(links.iter().all(|l| l.tab == SessionLinkTab::Conversation));
    }

    #[test]
    fn user_text_items_count_but_tool_results_do_not() {
        let links = session_links(&jsonl(&[user(json!([
            {"type": "text", "text": "https://example.com/typed"},
            {"type": "tool_result", "tool_use_id": "t1", "content": "https://example.com/output"},
        ]))]));
        assert_eq!(
            urls(&links, SessionLinkTab::Conversation),
            vec!["https://example.com/typed"]
        );
        assert!(urls(&links, SessionLinkTab::AiReferenced).is_empty());
    }

    #[test]
    fn meta_and_compact_summary_entries_are_skipped() {
        let links = session_links(&jsonl(&[
            json!({"type": "user", "isMeta": true, "message": {"content": "https://example.com/meta"}}),
            json!({"type": "user", "isCompactSummary": true, "message": {"content": "https://example.com/summary"}}),
        ]));
        assert!(links.is_empty());
    }

    #[test]
    fn injected_reminders_and_command_output_are_stripped_before_scanning() {
        assert_eq!(
            conversation(
                "<system-reminder>\nhttps://example.com/reminder\n</system-reminder>mine https://example.com/mine"
            ),
            vec!["https://example.com/mine"]
        );
        assert!(conversation(
            "<local-command-stdout>https://example.com/stdout</local-command-stdout>"
        )
        .is_empty());
        assert!(conversation(
            "<command-message>https://example.com/message</command-message>"
        )
        .is_empty());
    }

    #[test]
    fn background_task_notifications_are_not_written_by_the_user() {
        assert!(conversation(
            "<task-notification>\n<task-id>b1</task-id>\n<summary>Monitor event: \"CI\"</summary>\n<event>https://github.com/o/r/actions/runs/1</event>\n<result>see https://example.com/result</result>\n</task-notification>"
        )
        .is_empty());
        assert_eq!(
            conversation("<task-notification>https://example.com/n</task-notification> and https://example.com/mine"),
            vec!["https://example.com/mine"]
        );
    }

    #[test]
    fn slash_command_arguments_are_written_by_the_user() {
        assert_eq!(
            conversation(
                "<command-name>/review</command-name> <command-message>review</command-message> <command-args>https://github.com/o/r/pull/5</command-args>"
            ),
            vec!["https://github.com/o/r/pull/5"]
        );
    }

    fn page_read(id: &str, tool: &str, url: &str) -> Value {
        assistant(json!([{"type": "tool_use", "id": id, "name": tool, "input": {"url": url}}]))
    }

    fn result(id: &str, content: &str, is_error: bool) -> Value {
        user(json!([{"type": "tool_result", "tool_use_id": id, "content": content, "is_error": is_error}]))
    }

    fn failed(links: &[SessionLink]) -> Vec<(&str, &str, Option<SessionEventDeniedBy>)> {
        links
            .iter()
            .filter(|l| l.tab == SessionLinkTab::Failed)
            .map(|l| (l.url.as_str(), l.source.as_str(), l.denied_by))
            .collect()
    }

    #[test]
    fn pages_a_tool_could_not_read_land_in_the_failed_tab_with_the_reason() {
        let links = session_links(&jsonl(&[
            page_read("t1", "WebFetch", "https://a.example/"),
            result("t1", "Request failed with status code 403", true),
            page_read("t2", "mcp__playwright__browser_navigate", "https://b.example/"),
            result("t2", "PreToolUse:mcp__playwright__browser_navigate hook error: blocked", true),
            page_read("t3", "WebFetch", "https://c.example/"),
            result("t3", "fine", false),
        ]));
        assert_eq!(
            failed(&links),
            vec![
                (
                    "https://b.example/",
                    "mcp__playwright__browser_navigate",
                    Some(SessionEventDeniedBy::Hook)
                ),
                ("https://a.example/", "WebFetch", None),
            ]
        );
    }

    #[test]
    fn a_page_read_again_successfully_leaves_the_failed_tab() {
        let links = session_links(&jsonl(&[
            page_read("t1", "WebFetch", "https://a.example/"),
            result("t1", "Request failed with status code 500", true),
            page_read("t2", "mcp__playwright__browser_navigate", "https://a.example/"),
            result("t2", "ok", false),
        ]));
        assert!(failed(&links).is_empty());
    }

    #[test]
    fn a_page_that_failed_more_than_once_shows_its_latest_tool_and_reason() {
        let links = session_links(&jsonl(&[
            page_read("t1", "WebFetch", "https://a.example/"),
            result("t1", "PreToolUse:WebFetch hook error: blocked", true),
            page_read("t2", "mcp__playwright__browser_navigate", "https://a.example/"),
            result("t2", "net::ERR_NAME_NOT_RESOLVED", true),
        ]));
        assert_eq!(
            failed(&links),
            vec![("https://a.example/", "mcp__playwright__browser_navigate", None)]
        );
    }

    #[test]
    fn a_subagent_page_read_is_left_to_the_subagent() {
        let mut failure = result("t1", "Request failed with status code 403", true);
        failure["isSidechain"] = json!(true);
        let links = session_links(&jsonl(&[
            page_read("t1", "WebFetch", "https://a.example/"),
            failure,
        ]));
        assert!(failed(&links).is_empty());
    }

    #[test]
    fn a_failed_command_that_mentions_a_url_is_not_a_failed_page() {
        let links = session_links(&jsonl(&[
            assistant(json!([{"type": "tool_use", "id": "t1", "name": "Bash",
                "input": {"command": "curl https://a.example/"}}])),
            result("t1", "exit 7", true),
        ]));
        assert!(failed(&links).is_empty());
    }

    #[test]
    fn tool_use_inputs_land_in_the_ai_tab_under_the_tool_name() {
        let links = session_links(&jsonl(&[assistant(json!([
            {"type": "tool_use", "id": "t1", "name": "WebFetch",
             "input": {"url": "https://example.com/fetch", "prompt": "summarize"}},
            {"type": "tool_use", "id": "t2", "name": "Bash",
             "input": {"command": "gh pr view https://github.com/o/r/pull/9", "nested": [{"deep": "https://example.com/deep"}]}},
        ]))]));
        let sources: Vec<(&str, &str)> = links
            .iter()
            .map(|l| (l.url.as_str(), l.source.as_str()))
            .collect();
        assert_eq!(
            sources,
            vec![
                ("https://example.com/deep", "Bash"),
                ("https://github.com/o/r/pull/9", "Bash"),
                ("https://example.com/fetch", "WebFetch"),
            ]
        );
        assert!(links.iter().all(|l| l.tab == SessionLinkTab::AiReferenced));
    }

    #[test]
    fn websearch_results_carry_their_titles() {
        let links = session_links(&jsonl(&[
            assistant(json!([{"type": "tool_use", "id": "ws1", "name": "WebSearch", "input": {"query": "rust"}}])),
            json!({
                "type": "user",
                "message": {"content": [{"type": "tool_result", "tool_use_id": "ws1", "content": "Links: https://ignored.example/"}]},
                "toolUseResult": {"query": "rust", "results": [
                    {"tool_use_id": "srv1", "content": [
                        {"title": "Rust Lang", "url": "https://www.rust-lang.org/"},
                        {"title": "Docs", "url": "https://doc.rust-lang.org/"},
                    ]},
                    "a text summary https://summary.example/",
                ]},
            }),
        ]));
        let found: Vec<(&str, &str, Option<&str>)> = links
            .iter()
            .map(|l| (l.url.as_str(), l.source.as_str(), l.title.as_deref()))
            .collect();
        assert_eq!(
            found,
            vec![
                ("https://doc.rust-lang.org/", "WebSearch", Some("Docs")),
                ("https://www.rust-lang.org/", "WebSearch", Some("Rust Lang")),
            ]
        );
    }

    #[test]
    fn results_of_a_tool_other_than_websearch_are_not_read() {
        let links = session_links(&jsonl(&[
            assistant(json!([{"type": "tool_use", "id": "t1", "name": "Other", "input": {}}])),
            json!({
                "type": "user",
                "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "content": ""}]},
                "toolUseResult": {"results": [{"content": [{"title": "X", "url": "https://x.example/"}]}]},
            }),
        ]));
        assert!(links.is_empty());
    }

    #[test]
    fn trailing_punctuation_is_trimmed() {
        assert_eq!(
            conversation("a https://example.com/a. b https://example.com/b, c https://example.com/c!? d https://example.com/d;:"),
            vec![
                "https://example.com/d",
                "https://example.com/c",
                "https://example.com/b",
                "https://example.com/a",
            ]
        );
    }

    #[test]
    fn cjk_punctuation_ends_a_url() {
        assert_eq!(
            conversation("「https://example.com/a」と https://example.com/b。次は（https://example.com/c）、"),
            vec![
                "https://example.com/c",
                "https://example.com/b",
                "https://example.com/a",
            ]
        );
    }

    #[test]
    fn japanese_prose_right_after_a_url_ends_it() {
        assert_eq!(
            conversation("https://github.com/o/r/pull/12を見て"),
            vec!["https://github.com/o/r/pull/12"]
        );
        assert_eq!(
            conversation("https://example.comをご覧ください"),
            vec!["https://example.com"]
        );
        assert_eq!(
            conversation("（詳細は https://example.com/detail/1819)と書いた"),
            vec!["https://example.com/detail/1819"]
        );
        assert_eq!(
            conversation("https://example.com/runs/91974)：失敗"),
            vec!["https://example.com/runs/91974"]
        );
    }

    #[test]
    fn quotes_angle_brackets_and_backticks_end_a_url() {
        assert_eq!(
            conversation(r#"`https://example.com/a` "https://example.com/b" <https://example.com/c>"#),
            vec![
                "https://example.com/c",
                "https://example.com/b",
                "https://example.com/a",
            ]
        );
    }

    #[test]
    fn unbalanced_closing_brackets_are_trimmed_but_balanced_ones_kept() {
        assert_eq!(
            conversation("(see https://example.com/a) and [https://example.com/b] https://en.wikipedia.org/wiki/Rust_(language)"),
            vec![
                "https://en.wikipedia.org/wiki/Rust_(language)",
                "https://example.com/b",
                "https://example.com/a",
            ]
        );
    }

    #[test]
    fn markdown_links_yield_only_the_url() {
        assert_eq!(
            conversation("[the docs](https://example.com/docs) and [https://example.com/x](https://example.com/x)"),
            vec!["https://example.com/x", "https://example.com/docs"]
        );
    }

    #[test]
    fn github_pull_requests_and_issues_collapse_to_one_canonical_link() {
        let links = session_links(&jsonl(&[user(json!(
            "https://github.com/o/r/pull/12/files#diff-1 https://github.com/o/r/pull/12?w=1 https://github.com/o/r/issues/3#issuecomment-9 https://github.com/o/r/pulls https://github.com/o/r"
        ))]));
        let kinds: Vec<(&str, SessionLinkKind, Option<&GithubLinkRef>)> = links
            .iter()
            .map(|l| (l.url.as_str(), l.kind, l.github.as_ref()))
            .collect();
        assert_eq!(
            kinds,
            vec![
                ("https://github.com/o/r", SessionLinkKind::Other, None),
                ("https://github.com/o/r/pulls", SessionLinkKind::Other, None),
                (
                    "https://github.com/o/r/issues/3",
                    SessionLinkKind::Issue,
                    Some(&GithubLinkRef { owner: "o".into(), repo: "r".into(), number: 3, ..Default::default() })
                ),
                (
                    "https://github.com/o/r/pull/12",
                    SessionLinkKind::Pr,
                    Some(&GithubLinkRef { owner: "o".into(), repo: "r".into(), number: 12, ..Default::default() })
                ),
            ]
        );
    }

    #[test]
    fn github_owner_and_repo_are_matched_without_regard_to_case() {
        let links = session_links(&jsonl(&[user(json!(
            "https://github.com/Kounetsuman/Zashiki/pull/5 https://GitHub.com/kounetsuman/zashiki/pull/5/files"
        ))]));
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].url, "https://github.com/kounetsuman/zashiki/pull/5");
        assert_eq!(
            links[0].github,
            Some(GithubLinkRef { owner: "kounetsuman".into(), repo: "zashiki".into(), number: 5, ..Default::default() })
        );
    }

    #[test]
    fn a_repeated_link_keeps_its_first_source_and_moves_to_its_newest_appearance() {
        let links = session_links(&jsonl(&[
            user(json!("https://github.com/o/r/pull/1")),
            user(json!("https://example.com/between")),
            assistant(json!([{"type": "text", "text": "https://github.com/o/r/pull/1/files"}])),
        ]));
        let found: Vec<(&str, &str)> = links
            .iter()
            .map(|l| (l.url.as_str(), l.source.as_str()))
            .collect();
        assert_eq!(
            found,
            vec![
                ("https://github.com/o/r/pull/1", "user"),
                ("https://example.com/between", "user"),
            ]
        );
    }

    #[test]
    fn the_same_url_is_listed_once_per_tab() {
        let links = session_links(&jsonl(&[
            user(json!("https://example.com/both")),
            assistant(json!([{"type": "tool_use", "id": "t", "name": "WebFetch", "input": {"url": "https://example.com/both"}}])),
            assistant(json!([{"type": "text", "text": "https://example.com/both"}])),
        ]));
        assert_eq!(links.len(), 2);
        assert_eq!(urls(&links, SessionLinkTab::Conversation), vec!["https://example.com/both"]);
        assert_eq!(urls(&links, SessionLinkTab::AiReferenced), vec!["https://example.com/both"]);
    }

    #[test]
    fn broken_lines_and_other_entry_types_are_ignored() {
        let content = format!(
            "{{not json\n{}\n{}",
            json!({"type": "summary", "summary": "https://example.com/summary"}),
            user(json!("https://example.com/ok")),
        );
        assert_eq!(
            urls(&session_links(&content), SessionLinkTab::Conversation),
            vec!["https://example.com/ok"]
        );
    }
}
