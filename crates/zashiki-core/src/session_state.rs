//! Session state detection (primarily by screen capture of the conversation pane, with a jsonl
//! fallback). Corresponds 1:1 with the TS version `packages/shared/src/session-state.ts`, and the
//! table tests (`session-state.test.ts`) were also ported to `cargo test`. These tests are the
//! canonical spec.
//!
//! Because of the zero-dependency policy, the TS side's regexes (e.g. `❯\s*[0-9]+\.`) are
//! reproduced equivalently by hand-written scanning. Since the detection input is "screen text",
//! it can be fed to this same pure function from either tmux `capture-pane` or the headless vterm
//! reconstruction (the detection side is unchanged even after removing tmux).

/// The state of a conversation session (corresponds to the wire `SessionState`).
/// `detect_state` never returns `Unknown` (if there is no hint on screen, it returns `Idle`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionState {
    WaitingInput,
    Running,
    /// The state where the normal spinner has been pushed out and only the bottom bg-agent group
    /// panel remains (subagents running; runningSubagents is meaningful only in this state).
    RunningBgAgent,
    Idle,
    NoClaude,
    /// The transient where launch was keyed/spawned but claude has not yet appeared in the process
    /// tree. `detect_state` does not return it; the poller carves it out of `NoClaude` via `apply_startup_grace`.
    Starting,
    Unknown,
}

/// The marker for the running-spinner line (Claude Code's wording).
pub const DEFAULT_RUN_MARKER: &str = "(esc to interrupt";
/// The line-start marker for a bg-agent line.
pub const DEFAULT_BG_AGENT_MARKER: &str = "◯";
/// The text marker for the usage-limit-reached banner (Claude Code's phrasing).
pub const DEFAULT_LIMIT_MARKER: &str = "usage limit reached";

/// The last 8 non-empty lines = the absorption width for the real layout where 3 input-box lines + a status line sit below the spinner.
const BOTTOM_WINDOW_LINES: usize = 8;

/// A whitespace test that exactly matches ECMAScript's `\s` (WhiteSpace ∪ LineTerminator).
/// It differs from Rust's `char::is_whitespace` (Unicode White_Space) in just two points:
/// NEL (U+0085) is non-whitespace in JS, and BOM/ZWNBSP (U+FEFF) is whitespace in JS. To keep the
/// decision consistent with the TS version, the non-empty line check, numbered-line scanning, and
/// trim_start all use this predicate.
fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// Equivalent to JS `String.prototype.trimStart` (removes the prefix using the `\s` set).
fn js_trim_start(s: &str) -> &str {
    s.trim_start_matches(is_js_whitespace)
}

fn has_non_whitespace(line: &str) -> bool {
    line.chars().any(|c| !is_js_whitespace(c))
}

/// The last 8 non-empty lines (counted by non-empty because the bottom is filled with blank lines right after rendering).
fn bottom_non_empty_lines(capture: &str) -> Vec<&str> {
    let lines: Vec<&str> = capture
        .split('\n')
        .filter(|l| has_non_whitespace(l))
        .collect();
    let start = lines.len().saturating_sub(BOTTOM_WINDOW_LINES);
    lines[start..].to_vec()
}

/// If `\d+<letter>` matches, returns the position after letter (zero digits does not match; no side effects).
fn match_digits_letter(chars: &[char], start: usize, letter: char) -> Option<usize> {
    let mut i = start;
    while i < chars.len() && chars[i].is_ascii_digit() {
        i += 1;
    }
    if i == start {
        return None;
    }
    (chars.get(i) == Some(&letter)).then_some(i + 1)
}

/// Detects the new UI's live-timer line structurally (a hand-written equivalent of the TS
/// `LIVE_SPINNER_TIMER` `/…\s*\((?:\d+h\s*)?(?:\d+m\s*)?\d+s[^)]*[·↓]/`). Treats a new spinner that
/// lacks the `(esc to interrupt` marker (`✻ …… (8m 10s · ↓ …)`) as running. It requires a `·`/`↓`
/// separator and rejects natural-language text like `… (ctrl+o…)` or `…(30s)` (which closes without a separator).
fn has_live_spinner_timer(line: &str) -> bool {
    let chars: Vec<char> = line.chars().collect();
    (0..chars.len())
        .filter(|&i| chars[i] == '…')
        .any(|i| matches_timer_after(&chars, i + 1))
}

fn matches_timer_after(chars: &[char], start: usize) -> bool {
    let skip_ws = |mut i: usize| {
        while i < chars.len() && is_js_whitespace(chars[i]) {
            i += 1;
        }
        i
    };
    // \s* \(
    let mut i = skip_ws(start);
    if chars.get(i) != Some(&'(') {
        return false;
    }
    i += 1;
    // (?:\d+h\s*)?  (?:\d+m\s*)?
    for unit in ['h', 'm'] {
        if let Some(j) = match_digits_letter(chars, i, unit) {
            i = skip_ws(j);
        }
    }
    // \d+s
    let Some(j) = match_digits_letter(chars, i, 's') else {
        return false;
    };
    i = j;
    // [^)]*[·↓]: true if a separator appears before reaching `)`.
    while let Some(&c) = chars.get(i) {
        if c == ')' {
            return false;
        }
        if c == '·' || c == '↓' {
            return true;
        }
        i += 1;
    }
    false
}

/// Whether the running-spinner line is visible at the bottom of the pane (the last 8 non-empty
/// lines). In addition to a substring match of the marker (default `(esc to interrupt`), it also
/// detects the new UI's live timer structurally (OR). Restricting to the bottom avoids misdetecting
/// a marker quoted in the history body as running.
pub fn is_running(capture: &str, marker: &str) -> bool {
    bottom_non_empty_lines(capture)
        .iter()
        .any(|line| line.contains(marker) || has_live_spinner_timer(line))
}

/// Detects Claude Code's usage-limit reached from the bottom of the screen (the last 8 non-empty
/// lines). A case-insensitive substring match of the marker (default `usage limit reached`). It is
/// an attribute orthogonal to the main state and is not built into `detect_state` (so as not to make
/// the case of a limit banner appearing during running mutually exclusive). Case is ignored because,
/// unlike `is_running`'s marker (stable casing), the leading casing of the limit text can vary. An
/// empty marker falls to false to avoid a false positive (matching every window) (callers are expected to resolve to the default).
pub fn is_limit_reached(capture: &str, marker: &str) -> bool {
    if marker.is_empty() {
        return false;
    }
    let needle = marker.to_lowercase();
    bottom_non_empty_lines(capture)
        .iter()
        .any(|line| line.to_lowercase().contains(&needle))
}

/// Whether background subagents are running. The only hint is the bottom agent-group panel
/// (the heading `⏺ main` + a line-start marker line for each running agent).
/// To avoid false positives: it requires the heading to co-occur, and limits the marker to a match
/// at the line start (the first non-whitespace char) followed immediately by whitespace.
pub fn has_bg_agent(capture: &str, marker: &str) -> bool {
    let window = bottom_non_empty_lines(capture);
    if !window.iter().any(|line| line.contains("⏺ main")) {
        return false;
    }
    let needle = format!("{marker} ");
    window
        .iter()
        .any(|line| js_trim_start(line).starts_with(&needle))
}

/// Whether the line contains a spot where `❯` is followed (optionally with whitespace) by `[0-9]+.` (`/❯\s*[0-9]+\./`).
fn has_cursor_number(line: &str) -> bool {
    let chars: Vec<char> = line.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        if c == '❯' && digits_then_dot(&chars[i + 1..], true) {
            return true;
        }
    }
    false
}

/// Whether the line matches `/^\s*(?:❯\s*)?[0-9]+\./` (the count target for choice lines).
fn is_numbered_line(line: &str) -> bool {
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < chars.len() && is_js_whitespace(chars[i]) {
        i += 1;
    }
    if i < chars.len() && chars[i] == '❯' {
        i += 1;
        while i < chars.len() && is_js_whitespace(chars[i]) {
            i += 1;
        }
    }
    digits_then_dot(&chars[i..], false)
}

/// Whether it matches `\s*[0-9]+\.` (if skip_ws=true, leading whitespace is skipped).
/// Requires that one or more digits are immediately followed by `.`.
fn digits_then_dot(chars: &[char], skip_ws: bool) -> bool {
    let mut i = 0;
    if skip_ws {
        while i < chars.len() && is_js_whitespace(chars[i]) {
            i += 1;
        }
    }
    let start = i;
    while i < chars.len() && chars[i].is_ascii_digit() {
        i += 1;
    }
    if i == start {
        return false; // no digits at all
    }
    chars.get(i) == Some(&'.')
}

/// Whether it is a numbered-choice wizard (awaiting user input). If there is a selection-cursor
/// line with `❯` and two or more choice lines in the `N.` form, it is considered waiting.
pub fn is_wizard(capture: &str) -> bool {
    let lines: Vec<&str> = capture.split('\n').collect();
    if !lines.iter().any(|line| has_cursor_number(line)) {
        return false;
    }
    lines.iter().filter(|line| is_numbered_line(line)).count() >= 2
}

/// Options for `detect_state`. An empty-string marker falls to the default (like zsh `${VAR:-default}`).
pub struct DetectStateOptions<'a> {
    /// Whether claude (with a sid) is in the process tree of the captured pane.
    pub has_claude: bool,
    pub run_marker: Option<&'a str>,
    pub bg_agent_marker: Option<&'a str>,
}

fn resolve<'a>(marker: Option<&'a str>, default: &'a str) -> &'a str {
    match marker {
        Some(m) if !m.is_empty() => m,
        _ => default,
    }
}

/// Capture-primary detection that treats the conversation pane's actual screen as authoritative
/// (priority: wizard > running > bg > no_claude > idle). `Idle` means "no hint on screen", and the
/// caller chains it into the jsonl fallback via `fallback_state`.
pub fn detect_state(capture: &str, opts: &DetectStateOptions) -> SessionState {
    if is_wizard(capture) {
        return SessionState::WaitingInput;
    }
    if is_running(capture, resolve(opts.run_marker, DEFAULT_RUN_MARKER)) {
        return SessionState::Running;
    }
    if has_bg_agent(
        capture,
        resolve(opts.bg_agent_marker, DEFAULT_BG_AGENT_MARKER),
    ) {
        return SessionState::RunningBgAgent;
    }
    if !opts.has_claude {
        return SessionState::NoClaude;
    }
    SessionState::Idle
}

/// The kind of the last event in the transcript (jsonl).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranscriptKind {
    User,
    Assistant,
}

/// The last user/assistant event in the transcript (jsonl).
pub struct TranscriptEvent {
    pub kind: TranscriptKind,
    /// Whether the body contains an interruption marker (an Esc interruption remains as a user line).
    pub interrupted: bool,
}

/// The jsonl fallback for when there is neither a spinner nor a wizard on screen (`Running` or
/// `Idle`). It rescues to running only when the most recent event is a user event (the pre-render
/// race right after sending), and lets a stale, stuck user event fall to idle.
pub fn fallback_state(
    last_event: Option<&TranscriptEvent>,
    mtime_age_sec: Option<f64>,
    poll_sec: f64,
) -> SessionState {
    let poll = if poll_sec.is_finite() && poll_sec > 0.0 {
        poll_sec
    } else {
        2.0
    };
    let max_age_sec = (2.0 * poll).max(30.0);
    let fresh = matches!(mtime_age_sec, Some(age) if age <= max_age_sec);
    match last_event {
        Some(ev) if matches!(ev.kind, TranscriptKind::User) && !ev.interrupted && fresh => {
            SessionState::Running
        }
        _ => SessionState::Idle,
    }
}

/// The mtime freshness threshold (seconds) for the running-subagent count. The larger of twice the
/// poll interval or 30 seconds (the same freshness rule as fallback_state). An invalid poll falls to the default 2 seconds.
pub fn subagent_fresh_within_sec(poll_sec: f64) -> f64 {
    let poll = if poll_sec.is_finite() && poll_sec > 0.0 {
        poll_sec
    } else {
        2.0
    };
    (2.0 * poll).max(30.0)
}

/// An approximation that counts as running the fresh ones within the threshold, from the list of
/// mtime-elapsed seconds for the subagents jsonl (children, grandchildren, and great-grandchildren recorded flat).
pub fn count_running_subagents(mtime_ages_sec: &[f64], fresh_within_sec: f64) -> usize {
    mtime_ages_sec
        .iter()
        .filter(|&&age| age <= fresh_within_sec)
        .count()
}

/// The length of the startup grace (seconds). The width to absorb the cold start (node startup)
/// from keying/spawning claude until it appears in the process tree. Given extra margin because it empirically takes several seconds.
pub const STARTUP_GRACE_SEC: f64 = 8.0;

/// Converts the startup grace into a number of polls (`STARTUP_GRACE_SEC` divided by `poll_sec`,
/// rounded up, minimum 1). An invalid poll falls to the default 2 seconds (the same rule as `fallback_state`).
pub fn startup_grace_polls(poll_sec: f64) -> u32 {
    let poll = if poll_sec.is_finite() && poll_sec > 0.0 {
        poll_sec
    } else {
        2.0
    };
    ((STARTUP_GRACE_SEC / poll).ceil() as u32).max(1)
}

/// Distinguishes the transient right after startup (claude not yet detectable in the process tree)
/// from `NoClaude`. Even if `detect_state` returns `NoClaude`, if the number of polls since
/// no_claude began to be consecutive (`no_claude_polls`; 1 on the first) is within the grace, it
/// falls to `Starting`. If claude still does not appear after the grace, it is finalized as
/// `NoClaude` (so as not to hide a resume failure = a permanent no_claude). Anything other than
/// `NoClaude` is returned as is (even if a live claude disappears, the caller re-counts from
/// streak=1 if the previous state was live, so here we purely look only at "is this an early no_claude").
pub fn apply_startup_grace(
    detected: SessionState,
    no_claude_polls: u32,
    grace_polls: u32,
) -> SessionState {
    if matches!(detected, SessionState::NoClaude) && no_claude_polls <= grace_polls {
        SessionState::Starting
    } else {
        detected
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The fixtures are identical to the TS version session-state.test.ts (the real environment is not read).
    const CAP_RUN: &str =
        "古い履歴行\n✻ Simmering… (esc to interrupt · ctrl+t)\n╭───╮\n│ ❯ │\n╰───╯";
    const CAP_MARKER_AT_8TH: &str = "(esc to interrupt)\n1行\n2行\n3行\n4行\n5行\n6行\n7行";
    const CAP_MARKER_AT_9TH_HISTORY_QUOTE: &str =
        "引用: (esc to interrupt を検出する話\n1行\n2行\n3行\n4行\n5行\n6行\n7行\n8行";
    const CAP_SHORT_RUN: &str = "a\n(esc to interrupt)";
    const CAP_BG: &str = "✻ Waiting for 1 background agent to finish\n\n───\n❯\n───\n  1.4Mトークン/回\n  ⏵⏵ bypass ... ← for agents\n\n  ⏺ main\n  ◯ general-purpose  作業  29s · ↓ 9.7k tokens";
    const CAP_BG_MULTI: &str = "  ⏺ main\n  ◯ general-purpose  A  1s\n  ◯ Explore  B  2s";
    const CAP_BG_INPUT_BOX: &str =
        "✻ Brewed for 1m\n───\n❯ これは ◯ について\n───\n  token\n  ⏵⏵ bypass ... ← for agents";
    const CAP_BG_HEADING_BUT_INLINE_CIRCLE: &str =
        "  ⏺ main\n  作業中です ◯ 印について\n───\n❯\n───";
    const CAP_BG_RADIO: &str = "質問？\n● はい\n◯ いいえ\n◯ 常に許可";
    const CAP_BG_HISTORY_QUOTE: &str =
        "過去メッセージ ◯ を含む\n✻ Brewed for 1m\n───\n❯\n───\n  token\n  ⏵⏵ bypass ... ← for agents";
    const CAP_BG_SHORT: &str = "  ⏺ main\n  ◯ x";
    const CAP_WIZARD_TWO_CHOICE: &str = "❯ 1. Yes\n  2. No";
    const CAP_WIZARD_SINGLE: &str = "❯ 1. Yes";
    const CAP_WIZARD_WITH_MARKER: &str =
        "Do you want to proceed?\n❯ 1. Yes\n  2. No\n✻ Simmering… (esc to interrupt · ctrl+t)";
    const CAP_NUMBERED_LIST_NO_CURSOR: &str = "手順:\n1. ビルドする\n2. テストする\n───\n❯\n───";
    const CAP_IDLE_PLAIN: &str = "待機画面";
    const CAP_SHELL_ONLY: &str = "~/workspace/charlie % ls\nREADME.md\n~/workspace/charlie %";
    const CAP_IDLE_80: &str = "⏺ 完了しました。テストは全て green です。\n\n╭──────────────────────────────────────────────────────────────────────────────╮\n│ ❯                                                                            │\n╰──────────────────────────────────────────────────────────────────────────────╯\n  ? for shortcuts";
    const CAP_RUN_80_WRAPPED_TAIL: &str = "⏺ Bash(pnpm build && pnpm lint && pnpm test)\n  ⎿  Running…\n\n✻ Cogitating… (esc to interrupt · ctrl+t to hide todos · 123s · ↓ 2.3k tokens ·\nesc to undo)\n\n╭──────────────────────────────────────────────────────────────────────────────╮\n│ ❯                                                                            │\n╰──────────────────────────────────────────────────────────────────────────────╯";
    const CAP_WIZARD_80_WRAPPED_OPTION: &str = "Do you want to proceed?\n❯ 1. Yes\n  2. Yes, and don't ask again for pnpm build && pnpm lint && pnpm test commands\n     in /Users/kilo/workspace/kilo/zashiki";
    const CAP_WIZARD_80_WRAP_STARTS_WITH_NUMBER: &str = "Do you want to proceed?\n❯ 1. Yes, and remember this choice for the current session and also for version\n2. 0 of the config file\n  2. No, and tell Claude what to do differently (esc)";
    const CAP_IDLE_80_WITH_OLD_SPINNER_QUOTE: &str = "⏺ ログに \"✻ Simmering… (esc to interrupt · ctrl+t)\" と出ていたのは実行中の表示\n  です。検出ロジックは末尾 8 非空行だけを見ます。\n\n⏺ 修正が完了しました。\n  1行目の説明\n  2行目の説明\n  3行目の説明\n\n╭──────────────────────────────────────────────────────────────────────────────╮\n│ ❯                                                                            │\n╰──────────────────────────────────────────────────────────────────────────────╯\n  ? for shortcuts";
    const CAP_BG_80_FULL: &str = "⏺ サブエージェントに調査を委譲しました。\n\n✻ Waiting for 1 background agent to finish… (ctrl+t to view)\n\n╭──────────────────────────────────────────────────────────────────────────────╮\n│ ❯                                                                            │\n╰──────────────────────────────────────────────────────────────────────────────╯\n  1.4M トークン/回 · ⏵⏵ bypass permissions\n\n  ⏺ main\n  ◯ general-purpose  zashiki の設計調査と既存実装の依存関係の洗い出しをする長い\n    説明が折り返されている  29s · ↓ 9.7k tokens";

    fn with_trailing_blanks(base: &str, n: usize) -> String {
        format!("{base}{}", "\n".repeat(n))
    }

    fn claude() -> DetectStateOptions<'static> {
        DetectStateOptions {
            has_claude: true,
            run_marker: None,
            bg_agent_marker: None,
        }
    }

    fn no_claude() -> DetectStateOptions<'static> {
        DetectStateOptions {
            has_claude: false,
            run_marker: None,
            bg_agent_marker: None,
        }
    }

    // ---- detectState table tests ----

    #[test]
    fn running_spinner_in_bottom_window() {
        assert_eq!(detect_state(CAP_RUN, &claude()), SessionState::Running);
    }

    #[test]
    fn running_ignores_trailing_blank_lines() {
        assert_eq!(
            detect_state(&with_trailing_blanks(CAP_RUN, 8), &claude()),
            SessionState::Running
        );
    }

    #[test]
    fn marker_at_8th_line_is_running() {
        assert_eq!(
            detect_state(CAP_MARKER_AT_8TH, &claude()),
            SessionState::Running
        );
    }

    #[test]
    fn marker_at_9th_line_is_idle() {
        assert_eq!(
            detect_state(CAP_MARKER_AT_9TH_HISTORY_QUOTE, &claude()),
            SessionState::Idle
        );
    }

    #[test]
    fn running_detected_in_short_capture() {
        assert_eq!(
            detect_state(CAP_SHORT_RUN, &claude()),
            SessionState::Running
        );
    }

    #[test]
    fn bg_panel_is_running_bg_agent() {
        assert_eq!(
            detect_state(CAP_BG, &claude()),
            SessionState::RunningBgAgent
        );
    }

    #[test]
    fn bg_panel_trailing_blanks_running_bg_agent() {
        assert_eq!(
            detect_state(&with_trailing_blanks(CAP_BG, 3), &claude()),
            SessionState::RunningBgAgent
        );
    }

    #[test]
    fn bg_multi_agents_running_bg_agent() {
        assert_eq!(
            detect_state(CAP_BG_MULTI, &claude()),
            SessionState::RunningBgAgent
        );
    }

    #[test]
    fn bg_short_running_bg_agent() {
        assert_eq!(
            detect_state(CAP_BG_SHORT, &claude()),
            SessionState::RunningBgAgent
        );
    }

    #[test]
    fn bg_inline_circle_in_input_box_is_idle() {
        assert_eq!(
            detect_state(CAP_BG_INPUT_BOX, &claude()),
            SessionState::Idle
        );
    }

    #[test]
    fn bg_heading_but_inline_circle_is_idle() {
        assert_eq!(
            detect_state(CAP_BG_HEADING_BUT_INLINE_CIRCLE, &claude()),
            SessionState::Idle
        );
    }

    #[test]
    fn bg_radio_without_heading_is_idle() {
        assert_eq!(detect_state(CAP_BG_RADIO, &claude()), SessionState::Idle);
    }

    #[test]
    fn bg_history_quote_is_idle() {
        assert_eq!(
            detect_state(CAP_BG_HISTORY_QUOTE, &claude()),
            SessionState::Idle
        );
    }

    #[test]
    fn wizard_two_choice_is_waiting_input() {
        assert_eq!(
            detect_state(CAP_WIZARD_TWO_CHOICE, &claude()),
            SessionState::WaitingInput
        );
    }

    #[test]
    fn wizard_single_choice_is_idle() {
        assert_eq!(
            detect_state(CAP_WIZARD_SINGLE, &claude()),
            SessionState::Idle
        );
    }

    #[test]
    fn wizard_wins_over_spinner() {
        assert_eq!(
            detect_state(CAP_WIZARD_WITH_MARKER, &claude()),
            SessionState::WaitingInput
        );
    }

    #[test]
    fn numbered_list_without_cursor_is_not_wizard() {
        assert_eq!(
            detect_state(CAP_NUMBERED_LIST_NO_CURSOR, &claude()),
            SessionState::Idle
        );
    }

    #[test]
    fn no_hint_with_claude_is_idle() {
        assert_eq!(detect_state(CAP_IDLE_PLAIN, &claude()), SessionState::Idle);
    }

    #[test]
    fn no_hint_without_claude_is_no_claude() {
        assert_eq!(
            detect_state(CAP_SHELL_ONLY, &no_claude()),
            SessionState::NoClaude
        );
    }

    #[test]
    fn empty_capture_with_claude_is_idle() {
        assert_eq!(detect_state("", &claude()), SessionState::Idle);
    }

    #[test]
    fn empty_capture_without_claude_is_no_claude() {
        assert_eq!(detect_state("", &no_claude()), SessionState::NoClaude);
    }

    #[test]
    fn wizard_wins_over_claude_detection() {
        assert_eq!(
            detect_state(CAP_WIZARD_TWO_CHOICE, &no_claude()),
            SessionState::WaitingInput
        );
    }

    #[test]
    fn wide_idle_is_idle() {
        assert_eq!(detect_state(CAP_IDLE_80, &claude()), SessionState::Idle);
    }

    #[test]
    fn wide_wrapped_spinner_tail_is_running() {
        assert_eq!(
            detect_state(CAP_RUN_80_WRAPPED_TAIL, &claude()),
            SessionState::Running
        );
    }

    #[test]
    fn wide_wrapped_option_is_waiting_input() {
        assert_eq!(
            detect_state(CAP_WIZARD_80_WRAPPED_OPTION, &claude()),
            SessionState::WaitingInput
        );
    }

    #[test]
    fn wide_wrap_starting_with_number_stays_waiting_input() {
        assert_eq!(
            detect_state(CAP_WIZARD_80_WRAP_STARTS_WITH_NUMBER, &claude()),
            SessionState::WaitingInput
        );
    }

    #[test]
    fn wide_old_spinner_quote_out_of_window_is_idle() {
        assert_eq!(
            detect_state(CAP_IDLE_80_WITH_OLD_SPINNER_QUOTE, &claude()),
            SessionState::Idle
        );
    }

    #[test]
    fn wide_bg_full_screen_is_running_bg_agent() {
        assert_eq!(
            detect_state(CAP_BG_80_FULL, &claude()),
            SessionState::RunningBgAgent
        );
    }

    #[test]
    fn run_marker_is_overridable() {
        let cap = "✻ 走行中 [RUNNING-NOW]\n❯ ";
        assert_eq!(detect_state(cap, &claude()), SessionState::Idle);
        assert_eq!(
            detect_state(
                cap,
                &DetectStateOptions {
                    has_claude: true,
                    run_marker: Some("[RUNNING-NOW]"),
                    bg_agent_marker: None,
                }
            ),
            SessionState::Running
        );
    }

    #[test]
    fn bg_marker_is_overridable() {
        let cap = "  ⏺ main\n  ● general-purpose  作業  1s";
        assert_eq!(detect_state(cap, &claude()), SessionState::Idle);
        assert_eq!(
            detect_state(
                cap,
                &DetectStateOptions {
                    has_claude: true,
                    run_marker: None,
                    bg_agent_marker: Some("●"),
                }
            ),
            SessionState::RunningBgAgent
        );
    }

    #[test]
    fn empty_marker_falls_back_to_default() {
        assert_eq!(
            detect_state(
                "待機画面",
                &DetectStateOptions {
                    has_claude: true,
                    run_marker: Some(""),
                    bg_agent_marker: Some(""),
                }
            ),
            SessionState::Idle
        );
    }

    // ---- isRunning / hasBgAgent / isWizard unit tests ----

    #[test]
    fn is_running_false_without_marker() {
        assert!(!is_running(CAP_IDLE_PLAIN, "(esc to interrupt"));
    }

    #[test]
    fn is_running_true_for_new_ui_live_timer() {
        let m = DEFAULT_RUN_MARKER;
        assert!(is_running(
            "✻ Razzle-dazzling… (8m 10s · ↓ 34.3k tokens)",
            m
        ));
        assert!(is_running("✽ Skedaddling… (1m 58s · ↓ 5.1k tokens)", m));
        assert!(is_running(
            "✢ Whirring… (2m 14s · ↓ 5.5k tokens · thought for 2s)",
            m
        ));
        assert!(is_running("✻ Cogitating… (123s · ↓ 2.3k tokens)", m));
    }

    #[test]
    fn is_running_false_for_completed_for_duration_lines() {
        let m = DEFAULT_RUN_MARKER;
        assert!(!is_running("✻ Worked for 5m 42s", m));
        assert!(!is_running("✻ Sautéed for 1m 10s", m));
        assert!(!is_running("✻ Brewed for 1m", m));
    }

    #[test]
    fn is_running_false_for_non_timer_paren_after_ellipsis() {
        assert!(!is_running(
            "⏺ Reading 1 file… (ctrl+o to expand)",
            DEFAULT_RUN_MARKER
        ));
    }

    #[test]
    fn is_running_false_for_ns_without_separator() {
        let m = DEFAULT_RUN_MARKER;
        assert!(!is_running("処理は… (30s で完了しました)", m));
        assert!(!is_running("ログに (30s) と表示された", m));
        assert!(!is_running("完了… (5s)ago", m));
    }

    #[test]
    fn has_bg_agent_requires_line_start_and_trailing_space() {
        assert!(!has_bg_agent("  ⏺ main\n  ◯x詰めた行", "◯"));
        assert!(has_bg_agent("  ⏺ main\n  ◯ x", "◯"));
    }

    // ---- is_limit_reached (usage-limit banner detection) ----

    const CAP_LIMIT: &str = "⏺ 直前の応答\n✗ Claude usage limit reached · /upgrade to increase your limit\n╭───╮\n│ ❯ │\n╰───╯";
    const CAP_LIMIT_HISTORY_QUOTE: &str =
        "過去ログ: usage limit reached の話\n1行\n2行\n3行\n4行\n5行\n6行\n7行\n8行";
    const CAP_RUN_WITH_USAGE_STATUS: &str = "✻ Razzle-dazzling… (8m 10s · ↓ 34.3k tokens)\n───\n❯\n───\n  15% usage/5h(-13m) | 46% usage/week";

    #[test]
    fn limit_reached_detects_bottom_banner() {
        assert!(is_limit_reached(CAP_LIMIT, DEFAULT_LIMIT_MARKER));
    }

    #[test]
    fn limit_reached_is_case_insensitive() {
        assert!(is_limit_reached(
            "✗ Claude Usage Limit Reached",
            DEFAULT_LIMIT_MARKER
        ));
    }

    #[test]
    fn limit_reached_ignores_history_quote_outside_bottom_window() {
        assert!(!is_limit_reached(
            CAP_LIMIT_HISTORY_QUOTE,
            DEFAULT_LIMIT_MARKER
        ));
    }

    #[test]
    fn limit_reached_false_for_usage_percent_status_line() {
        assert!(!is_limit_reached(
            CAP_RUN_WITH_USAGE_STATUS,
            DEFAULT_LIMIT_MARKER
        ));
    }

    #[test]
    fn limit_reached_empty_marker_never_matches() {
        assert!(!is_limit_reached(CAP_LIMIT, ""));
    }

    #[test]
    fn limit_reached_marker_is_overridable() {
        let cap = "◈ RATE_CAP_HIT ◈\n───\n❯\n───";
        assert!(!is_limit_reached(cap, DEFAULT_LIMIT_MARKER));
        assert!(is_limit_reached(cap, "RATE_CAP_HIT"));
    }

    #[test]
    fn is_wizard_counts_cursor_line_itself() {
        assert!(is_wizard("❯ 1. Yes\n  2. No"));
    }

    // A regression for the whitespace test aligned with JS's \s (the two points where it differs from Rust's default is_whitespace).
    #[test]
    fn js_whitespace_bom_is_space_nel_is_not() {
        // BOM (U+FEFF) is JS's \s -> treated as whitespace. It skips over the char right after ❯ as whitespace and reaches "1.".
        assert!(is_wizard("❯\u{FEFF}1. Yes\n  2. No"));
        assert!(has_bg_agent("  ⏺ main\n\u{FEFF}◯ x", "◯"));
        // NEL (U+0085) is not JS's \s -> treated as non-whitespace. The char right after ❯ is not a digit, so it does not match.
        assert!(!is_wizard("❯\u{0085}1. Yes\n  2. No"));
        assert!(!has_bg_agent("  ⏺ main\n\u{0085}◯ x", "◯"));
        // A line with only a BOM is treated as blank (the /\S/ equivalent is false), and a line with only a NEL is treated as non-empty.
        assert!(!has_non_whitespace("\u{FEFF}"));
        assert!(has_non_whitespace("\u{0085}"));
    }

    // ---- fallbackState ----

    fn user(interrupted: bool) -> TranscriptEvent {
        TranscriptEvent {
            kind: TranscriptKind::User,
            interrupted,
        }
    }

    #[test]
    fn fallback_user_fresh_is_running() {
        assert_eq!(
            fallback_state(Some(&user(false)), Some(5.0), 2.0),
            SessionState::Running
        );
    }

    #[test]
    fn fallback_interrupted_user_is_idle() {
        assert_eq!(
            fallback_state(Some(&user(true)), Some(5.0), 2.0),
            SessionState::Idle
        );
    }

    #[test]
    fn fallback_stale_user_is_idle() {
        assert_eq!(
            fallback_state(Some(&user(false)), Some(120.0), 2.0),
            SessionState::Idle
        );
    }

    #[test]
    fn fallback_assistant_is_idle() {
        let ev = TranscriptEvent {
            kind: TranscriptKind::Assistant,
            interrupted: false,
        };
        assert_eq!(
            fallback_state(Some(&ev), Some(5.0), 2.0),
            SessionState::Idle
        );
    }

    #[test]
    fn fallback_no_event_is_idle() {
        assert_eq!(fallback_state(None, Some(5.0), 2.0), SessionState::Idle);
    }

    #[test]
    fn fallback_unknown_mtime_is_idle() {
        assert_eq!(
            fallback_state(Some(&user(false)), None, 2.0),
            SessionState::Idle
        );
    }

    #[test]
    fn fallback_freshness_boundary_poll_2() {
        assert_eq!(
            fallback_state(Some(&user(false)), Some(30.0), 2.0),
            SessionState::Running
        );
        assert_eq!(
            fallback_state(Some(&user(false)), Some(31.0), 2.0),
            SessionState::Idle
        );
    }

    #[test]
    fn fallback_freshness_boundary_poll_20() {
        assert_eq!(
            fallback_state(Some(&user(false)), Some(40.0), 20.0),
            SessionState::Running
        );
        assert_eq!(
            fallback_state(Some(&user(false)), Some(41.0), 20.0),
            SessionState::Idle
        );
    }

    #[test]
    fn fallback_invalid_poll_defaults_to_2() {
        assert_eq!(
            fallback_state(Some(&user(false)), Some(30.0), 0.0),
            SessionState::Running
        );
        assert_eq!(
            fallback_state(Some(&user(false)), Some(31.0), -1.0),
            SessionState::Idle
        );
        assert_eq!(
            fallback_state(Some(&user(false)), Some(30.0), f64::NAN),
            SessionState::Running
        );
    }

    // ---- subagents counting ----

    #[test]
    fn subagent_fresh_within_sec_is_max_of_double_poll_and_30() {
        assert_eq!(subagent_fresh_within_sec(2.0), 30.0);
        assert_eq!(subagent_fresh_within_sec(20.0), 40.0);
    }

    #[test]
    fn subagent_fresh_within_sec_falls_back_to_2_on_invalid_poll() {
        assert_eq!(subagent_fresh_within_sec(0.0), 30.0);
        assert_eq!(subagent_fresh_within_sec(-1.0), 30.0);
        assert_eq!(subagent_fresh_within_sec(f64::NAN), 30.0);
    }

    #[test]
    fn count_running_subagents_counts_fresh_within_threshold() {
        assert_eq!(count_running_subagents(&[1.0, 5.0, 29.0, 30.0], 30.0), 4);
        assert_eq!(count_running_subagents(&[31.0, 60.0, 120.0], 30.0), 0);
    }

    #[test]
    fn count_running_subagents_boundary_is_inclusive() {
        assert_eq!(count_running_subagents(&[30.0, 31.0], 30.0), 1);
    }

    #[test]
    fn count_running_subagents_counts_all_fresh_regardless_of_depth() {
        assert_eq!(
            count_running_subagents(&[2.0, 3.0, 4.0, 100.0, 5.0], 30.0),
            4
        );
    }

    #[test]
    fn count_running_subagents_empty_is_zero() {
        assert_eq!(count_running_subagents(&[], 30.0), 0);
    }

    // -- startup grace --

    #[test]
    fn startup_grace_polls_scales_and_floors_at_one() {
        // STARTUP_GRACE_SEC(8) divided by poll, rounded up.
        assert_eq!(startup_grace_polls(2.0), 4);
        assert_eq!(startup_grace_polls(8.0), 1);
        // ceil(8/3)=3.
        assert_eq!(startup_grace_polls(3.0), 3);
        // Even for a long poll, grant at least 1 poll of grace.
        assert_eq!(startup_grace_polls(100.0), 1);
        // An invalid poll falls to the default 2 seconds (ceil(8/2)=4).
        assert_eq!(startup_grace_polls(0.0), 4);
        assert_eq!(startup_grace_polls(-1.0), 4);
    }

    #[test]
    fn startup_grace_maps_early_no_claude_to_starting() {
        // Within the grace (from the first poll to the boundary) is Starting.
        assert_eq!(
            apply_startup_grace(SessionState::NoClaude, 1, 3),
            SessionState::Starting
        );
        assert_eq!(
            apply_startup_grace(SessionState::NoClaude, 3, 3),
            SessionState::Starting
        );
        // Exceeding the grace is finalized as NoClaude (does not hide a resume failure).
        assert_eq!(
            apply_startup_grace(SessionState::NoClaude, 4, 3),
            SessionState::NoClaude
        );
    }

    #[test]
    fn startup_grace_leaves_non_no_claude_states_untouched() {
        for s in [
            SessionState::Running,
            SessionState::RunningBgAgent,
            SessionState::Idle,
            SessionState::WaitingInput,
            SessionState::Unknown,
        ] {
            assert_eq!(apply_startup_grace(s, 1, 3), s);
        }
    }
}
