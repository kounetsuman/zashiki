//! Session state detection (primarily by screen capture of the conversation pane, with a jsonl
//! fallback). `cargo test` (the `session_state` table tests) is the canonical spec.
//!
//! Because of the zero-dependency policy, the detection regexes (e.g. `❯\s*[0-9]+\.`) are
//! implemented by hand-written scanning. Since the detection input is "screen text",
//! it can be fed to this same pure function from any screen source (e.g. the headless vterm
//! reconstruction).

/// The state of a conversation session (corresponds to the wire `CockpitTerminalState`).
/// `detect_state` never returns `Unknown` (if there is no hint on screen, it returns `Idle`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CockpitTerminalState {
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

/// Distinctive header phrases of Claude Code's built-in menu/overlay screens (`/login`, `/status`,
/// `/usage`, `/model`, `/mcp`, and the wider settings family). A session showing one of these is
/// sitting in a menu rather than mid-task, so the session list swaps its state glyph for a settings
/// icon. Best-effort defaults matched case-insensitively; extend or replace via `ZK_MENU_MARKERS`
/// when Claude Code's wording changes (the same escape-hatch idea as the run/limit markers).
pub const DEFAULT_MENU_MARKERS: &[&str] = &[
    "Select login method",
    "Claude Code Status",
    "Current week (all models)",
    "Select Model",
    "Manage MCP servers",
];

/// The last 8 non-empty lines = the absorption width for the real layout where 3 input-box lines + a status line sit below the spinner.
const BOTTOM_WINDOW_LINES: usize = 8;

/// The first 8 non-empty lines = the width that covers FleetView's fixed banner area (logo rows plus
/// the version/model lines) above the counts header.
const TOP_WINDOW_LINES: usize = 8;

/// A whitespace test that exactly matches ECMAScript's `\s` (WhiteSpace ∪ LineTerminator).
/// It differs from Rust's `char::is_whitespace` (Unicode White_Space) in just two points:
/// NEL (U+0085) is non-whitespace in JS, and BOM/ZWNBSP (U+FEFF) is whitespace in JS. So the
/// whitespace decision is well-defined, the non-empty line check, numbered-line scanning, and
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

/// Removes the leading whitespace prefix using the `\s` set (see `is_js_whitespace`).
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

/// The first 8 non-empty lines (the top counterpart of `bottom_non_empty_lines`).
fn top_non_empty_lines(capture: &str) -> impl Iterator<Item = &str> {
    capture
        .split('\n')
        .filter(|l| has_non_whitespace(l))
        .take(TOP_WINDOW_LINES)
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

/// Detects the new UI's live-timer line structurally (a hand-written scan equivalent to
/// `/…\s*\((?:\d+h\s*)?(?:\d+m\s*)?\d+s[^)]*[·↓]/`). Treats a new spinner that
/// lacks the `(esc to interrupt` marker (`✻ …… (8m 10s · ↓ …)`) as running. It requires a `·`/`↓`
/// separator and rejects natural-language text like `… (ctrl+o…)` or `…(30s)` (which closes without a separator).
fn has_live_spinner_timer(line: &str) -> bool {
    let chars: Vec<char> = line.chars().collect();
    (0..chars.len())
        .filter(|&i| chars[i] == '…')
        .any(|i| matches_timer_after(&chars, i + 1))
}

fn matches_timer_after(chars: &[char], start: usize) -> bool {
    // \s* \(
    let mut i = skip_ws(chars, start);
    if chars.get(i) != Some(&'(') {
        return false;
    }
    i += 1;
    // (?:\d+h\s*)?  (?:\d+m\s*)?
    for unit in ['h', 'm'] {
        if let Some(j) = match_digits_letter(chars, i, unit) {
            i = skip_ws(chars, j);
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

/// Leading line decoration (whitespace or a box-border/bullet glyph) stripped before a menu marker
/// is tested at the start of a line, so a centered or box-framed overlay title still matches.
fn is_menu_line_decoration(c: char) -> bool {
    is_js_whitespace(c)
        || matches!(
            c,
            '│' | '┃' | '|' | '╎' | '┆' | '>' | '*' | '•' | '·' | '-' | '─'
        )
}

/// Whether one of Claude Code's built-in menu/overlay screens is open, i.e. a marker heads any line
/// of the captured screen (case-insensitive, after stripping leading whitespace/border glyphs).
/// Requiring the marker to head a line — not merely appear anywhere — keeps a phrase quoted
/// mid-sentence in the conversation body from tripping the flag, while still scanning the whole
/// capture (overlays render centered, not pinned to the bottom like the running/limit banners).
/// Orthogonal to the main state — it only overrides the rendered glyph, so it is not folded into
/// `detect_state`. An empty marker list (or all-empty markers) yields false.
pub fn is_menu_open(capture: &str, markers: &[&str]) -> bool {
    let needles: Vec<String> = markers
        .iter()
        .filter(|m| !m.is_empty())
        .map(|m| m.to_lowercase())
        .collect();
    if needles.is_empty() {
        return false;
    }
    capture.split('\n').any(|line| {
        let head = line.trim_start_matches(is_menu_line_decoration).to_lowercase();
        needles.iter().any(|n| head.starts_with(n.as_str()))
    })
}

/// Whether the live background-agent panel (`⏺ main` heading directly above line-start `◯ ` agent
/// lines, wraps allowed) is anchored at the bottom of the pane, matched by contiguity from the bottom.
pub fn has_bg_agent(capture: &str, marker: &str) -> bool {
    let lines: Vec<&str> = capture
        .split('\n')
        .filter(|l| has_non_whitespace(l))
        .collect();
    let needle = format!("{marker} ");
    let mut saw_agent = false;
    for line in lines.iter().rev() {
        if line.contains("⏺ main") {
            return saw_agent;
        }
        if js_trim_start(line).starts_with(&needle) {
            saw_agent = true;
        } else if line.starts_with(|c: char| !is_js_whitespace(c)) {
            return false;
        }
    }
    false
}

/// The still-running agent count parsed from the skill/workflow agent-tray progress line
/// (`… N/M agents done · …`) in the bottom window: `total - done` when `total > done`, else `None`
/// (a finished tray must not read as busy).
pub fn skill_agents_running(capture: &str) -> Option<usize> {
    bottom_non_empty_lines(capture)
        .iter()
        .find_map(|line| parse_agents_done(line))
}

/// Scans a line for `<done>/<total>\s+agents?\s+done`, returning `total - done` when `total > done`.
fn parse_agents_done(line: &str) -> Option<usize> {
    let chars: Vec<char> = line.chars().collect();
    (0..chars.len()).find_map(|i| match_agents_done_at(&chars, i))
}

fn match_agents_done_at(chars: &[char], start: usize) -> Option<usize> {
    if start > 0 && chars[start - 1].is_ascii_digit() {
        return None;
    }
    let (done, i) = take_number(chars, start)?;
    if chars.get(i) != Some(&'/') {
        return None;
    }
    let (total, i) = take_number(chars, i + 1)?;
    let i = skip_ws_required(chars, i)?;
    let i = take_ascii(chars, i, "agents").or_else(|| take_ascii(chars, i, "agent"))?;
    let i = skip_ws_required(chars, i)?;
    let i = take_ascii(chars, i, "done")?;
    if chars.get(i).is_some_and(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    (total > done).then(|| total - done)
}

/// Parses a run of ASCII digits from `start`, returning (value, index-after); `None` if no digit.
fn take_number(chars: &[char], start: usize) -> Option<(usize, usize)> {
    let mut i = start;
    let mut val: usize = 0;
    while let Some(d) = chars.get(i).and_then(|c| c.to_digit(10)) {
        val = val.saturating_mul(10).saturating_add(d as usize);
        i += 1;
    }
    (i > start).then_some((val, i))
}

/// The index after the run of whitespace at `start` (`\s*`; `start` itself when there is none).
fn skip_ws(chars: &[char], start: usize) -> usize {
    let mut i = start;
    while i < chars.len() && is_js_whitespace(chars[i]) {
        i += 1;
    }
    i
}

fn skip_ws_required(chars: &[char], start: usize) -> Option<usize> {
    let i = skip_ws(chars, start);
    (i > start).then_some(i)
}

/// Matches the literal ASCII `word` at `start` (case-sensitive), returning the index after it.
fn take_ascii(chars: &[char], start: usize, word: &str) -> Option<usize> {
    let mut i = start;
    for wc in word.chars() {
        if chars.get(i) != Some(&wc) {
            return None;
        }
        i += 1;
    }
    Some(i)
}

/// The session counts parsed from the FleetView dashboard header.
pub struct FleetViewCounts {
    pub awaiting_input: usize,
    pub working: usize,
}

/// Parses the FleetView dashboard header (`N awaiting input · N working · N completed`) from the
/// top window of the capture — the dashboard pins it under the banner, and restricting the scan
/// (like the bottom window does for the run/limit markers) keeps a header quoted lower in a
/// conversation body from matching. The canonical spec is the tests.
pub fn fleet_view_counts(capture: &str) -> Option<FleetViewCounts> {
    top_non_empty_lines(capture).find_map(|line| parse_fleet_view_header(js_trim_start(line)))
}

fn parse_fleet_view_header(line: &str) -> Option<FleetViewCounts> {
    let chars: Vec<char> = line.chars().collect();
    let (awaiting_input, i) = take_number(&chars, 0)?;
    let i = take_worded_segment(&chars, i, "awaiting input")?;
    let i = take_separator_dot(&chars, i)?;
    let (working, i) = take_number(&chars, i)?;
    let i = take_worded_segment(&chars, i, "working")?;
    let i = take_separator_dot(&chars, i)?;
    let (_, i) = take_number(&chars, i)?;
    take_worded_segment(&chars, i, "completed")?;
    Some(FleetViewCounts {
        awaiting_input,
        working,
    })
}

/// Matches `\s+<word>` with a clean word boundary after it (`working` must not match `workingly`,
/// `completed5`, or `completedと`).
fn take_worded_segment(chars: &[char], start: usize, word: &str) -> Option<usize> {
    let i = skip_ws_required(chars, start)?;
    let i = take_ascii(chars, i, word)?;
    if chars.get(i).is_some_and(|c| c.is_alphanumeric()) {
        return None;
    }
    Some(i)
}

/// Matches `\s*·\s*` (the header's segment separator).
fn take_separator_dot(chars: &[char], start: usize) -> Option<usize> {
    let i = skip_ws(chars, start);
    if chars.get(i) != Some(&'·') {
        return None;
    }
    Some(skip_ws(chars, i + 1))
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

/// Whether it is a numbered-choice wizard (awaiting user input): the bottom-most `❯` on screen is a
/// selection cursor over a choice (`❯\s*[0-9]+\.`) and there are two or more `N.` choice lines.
///
/// Anchoring on the *bottom-most* `❯` (rather than scanning the whole capture) is what rejects a
/// phantom bell: a live wizard replaces the input box, so its cursor is the lowest `❯`; an idle or
/// running session always renders the input box below any content, whose bare `❯` prompt is the lowest
/// `❯` — so wizard-like text quoted in the history above the input box does not match.
pub fn is_wizard(capture: &str) -> bool {
    let bottom_cursor_is_choice = capture
        .split('\n')
        .rev()
        .find(|line| line.contains('❯'))
        .is_some_and(|line| has_cursor_number(line));
    if !bottom_cursor_is_choice {
        return false;
    }
    capture
        .split('\n')
        .filter(|line| is_numbered_line(line))
        .count()
        >= 2
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
/// (priority: wizard > running > bg (panel or skill agent-tray) > no_claude > fleet-view header > idle).
/// Ordering the fleet-view check after the no_claude return keeps a header left in shell scrollback
/// after claude exits from reading as busy. `Idle` means "no hint on screen", and the caller chains
/// it into the jsonl fallback via `fallback_state`.
pub fn detect_state(capture: &str, opts: &DetectStateOptions) -> CockpitTerminalState {
    if is_wizard(capture) {
        return CockpitTerminalState::WaitingInput;
    }
    if is_running(capture, resolve(opts.run_marker, DEFAULT_RUN_MARKER)) {
        return CockpitTerminalState::Running;
    }
    if has_bg_agent(
        capture,
        resolve(opts.bg_agent_marker, DEFAULT_BG_AGENT_MARKER),
    ) || skill_agents_running(capture).is_some()
    {
        return CockpitTerminalState::RunningBgAgent;
    }
    if !opts.has_claude {
        return CockpitTerminalState::NoClaude;
    }
    if let Some(fleet) = fleet_view_counts(capture) {
        if fleet.awaiting_input > 0 {
            return CockpitTerminalState::WaitingInput;
        }
        if fleet.working > 0 {
            return CockpitTerminalState::RunningBgAgent;
        }
    }
    CockpitTerminalState::Idle
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

/// The freshness window (seconds): the larger of twice the poll interval or 30 seconds. An invalid
/// poll falls to the default 2 seconds. Shared by the jsonl fallback, the running-subagent count, and
/// the hook-event arbitration so their staleness cutoffs stay in lockstep.
fn fresh_window_sec(poll_sec: f64) -> f64 {
    let poll = if poll_sec.is_finite() && poll_sec > 0.0 {
        poll_sec
    } else {
        2.0
    };
    (2.0 * poll).max(30.0)
}

/// The jsonl fallback for when there is neither a spinner nor a wizard on screen (`Running` or
/// `Idle`). It rescues to running only when the most recent event is a user event (the pre-render
/// race right after sending), and lets a stale, stuck user event fall to idle.
pub fn fallback_state(
    last_event: Option<&TranscriptEvent>,
    mtime_age_sec: Option<f64>,
    poll_sec: f64,
) -> CockpitTerminalState {
    let fresh = matches!(mtime_age_sec, Some(age) if age <= fresh_window_sec(poll_sec));
    match last_event {
        Some(ev) if matches!(ev.kind, TranscriptKind::User) && !ev.interrupted && fresh => {
            CockpitTerminalState::Running
        }
        _ => CockpitTerminalState::Idle,
    }
}

/// The mtime freshness threshold (seconds) for the running-subagent count (the shared freshness rule).
pub fn subagent_fresh_within_sec(poll_sec: f64) -> f64 {
    fresh_window_sec(poll_sec)
}

/// The freshness threshold (seconds) for a recorded hook event to stay authoritative for
/// `resolve_state` (the shared freshness rule). Beyond it, arbitration yields to the screen scrape.
pub fn hook_event_fresh_within_sec(poll_sec: f64) -> f64 {
    fresh_window_sec(poll_sec)
}

/// A Claude Code hook event's authoritative meaning for the waiting-input dimension. Mirrors the wire
/// `HookKind` (the domain cannot depend on the server's protocol type). The canonical spec is `resolve_state`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookEvent {
    /// `Notification` — Claude is waiting for the user.
    Waiting,
    /// `Stop` — the turn ended.
    Done,
    /// `UserPromptSubmit` — the user submitted a prompt.
    Prompt,
    /// `PostToolUse` — a tool ran mid-turn.
    Tool,
}

/// Arbitrates the *waiting-input* dimension between the screen scrape and the last hook event, when a
/// fresh event exists. Only the bell is arbitrated; the scrape keeps authority over running / idle /
/// bg (hooks do not know subagent counts or bg panels). `has_claude=false` preserves the process-truth
/// scrape (`NoClaude` / `Starting`) untouched. A `waiting` event promotes to the bell (catching a
/// wizard the scrape missed); `done` / `prompt` / `tool` clear only a phantom scrape bell (to idle for
/// `done`, running for `prompt` / `tool`). With no fresh event the scrape is returned unchanged.
pub fn resolve_state(
    scrape: CockpitTerminalState,
    last_hook_event: Option<HookEvent>,
    fresh: bool,
    has_claude: bool,
) -> CockpitTerminalState {
    if !has_claude {
        return scrape;
    }
    match last_hook_event.filter(|_| fresh) {
        Some(HookEvent::Waiting) => CockpitTerminalState::WaitingInput,
        Some(HookEvent::Done) if scrape == CockpitTerminalState::WaitingInput => {
            CockpitTerminalState::Idle
        }
        Some(HookEvent::Prompt | HookEvent::Tool) if scrape == CockpitTerminalState::WaitingInput => {
            CockpitTerminalState::Running
        }
        _ => scrape,
    }
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
    detected: CockpitTerminalState,
    no_claude_polls: u32,
    grace_polls: u32,
) -> CockpitTerminalState {
    if matches!(detected, CockpitTerminalState::NoClaude) && no_claude_polls <= grace_polls {
        CockpitTerminalState::Starting
    } else {
        detected
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The real environment is not read; the fixtures are fixed inputs.
    const CAP_RUN: &str =
        "古い履歴行\n✻ Simmering… (esc to interrupt · ctrl+t)\n╭───╮\n│ ❯ │\n╰───╯";
    const CAP_MARKER_AT_8TH: &str = "(esc to interrupt)\n1行\n2行\n3行\n4行\n5行\n6行\n7行";
    const CAP_MARKER_AT_9TH_HISTORY_QUOTE: &str =
        "引用: (esc to interrupt を検出する話\n1行\n2行\n3行\n4行\n5行\n6行\n7行\n8行";
    const CAP_SHORT_RUN: &str = "a\n(esc to interrupt)";
    const CAP_BG: &str = "✻ Waiting for 1 background agent to finish\n\n───\n❯\n───\n  1.4Mトークン/回\n  ⏵⏵ bypass ... ← for agents\n\n  ⏺ main\n  ◯ general-purpose  作業  29s · ↓ 9.7k tokens";
    const CAP_BG_MULTI: &str = "  ⏺ main\n  ◯ general-purpose  A  1s\n  ◯ Explore  B  2s";
    const CAP_BG_MANY_AGENTS: &str = "✻ Waiting for 8 background agents to finish… (ctrl+t to view)\n╭──────────────────────────────────────╮\n│ ❯                                     │\n╰──────────────────────────────────────╯\n  ⏵⏵ bypass permissions\n  ⏺ main\n  ◯ general-purpose  探索1  9s · ↓ 1.2k tokens\n  ◯ Explore  探索2  8s · ↓ 1.1k tokens\n  ◯ Explore  探索3  8s\n  ◯ general-purpose  探索4  7s\n  ◯ Explore  探索5  6s\n  ◯ Explore  探索6  5s\n  ◯ general-purpose  探索7  4s\n  ◯ Explore  探索8  3s";
    const CAP_BG_WRAPPED_OVERFLOW: &str = "✻ Waiting for 4 background agents to finish… (ctrl+t to view)\n╭──────────────────────────────────────╮\n│ ❯                                     │\n╰──────────────────────────────────────╯\n  ⏺ main\n  ◯ general-purpose  session_state の検出ロジックと既存テストの依存を洗い出す\n    長い説明  9s · ↓ 3.1k tokens\n  ◯ Explore  client 側の状態アイコン描画経路を確認する説明が折り返されて\n    いる  7s · ↓ 2.0k tokens\n  ◯ Explore  server の status_poller の組み立てを追う説明も折り返されて\n    いる  5s · ↓ 1.4k tokens\n  ◯ general-purpose  jsonl 解析の last event 判定を確認する  3s";
    const CAP_BG_STALE_SCROLLED: &str = "  ⏺ main\n  ◯ general-purpose  A  9s\n⏺ 調査が完了しました。\n╭──────────────────────────────────────╮\n│ ❯                                     │\n╰──────────────────────────────────────╯\n  ? for shortcuts";
    const CAP_BG_INPUT_BOX: &str =
        "✻ Brewed for 1m\n───\n❯ これは ◯ について\n───\n  token\n  ⏵⏵ bypass ... ← for agents";
    const CAP_BG_HEADING_BUT_INLINE_CIRCLE: &str =
        "  ⏺ main\n  作業中です ◯ 印について\n───\n❯\n───";
    const CAP_BG_RADIO: &str = "質問？\n● はい\n◯ いいえ\n◯ 常に許可";
    const CAP_BG_HISTORY_QUOTE: &str =
        "過去メッセージ ◯ を含む\n✻ Brewed for 1m\n───\n❯\n───\n  token\n  ⏵⏵ bypass ... ← for agents";
    const CAP_BG_SHORT: &str = "  ⏺ main\n  ◯ x";
    const CAP_SKILL_TRAY: &str = "▶▶ auto mode on (shift+tab to cycle) · ← for agents\n\n○ deep-research  Deep research harness — fan-out web searches, fetch sources, adversarially verify claims, synthesize a cited report.  22/28 agents done · 2m 31s · ↓ 885.0k tokens";
    const CAP_SKILL_TRAY_ALL_DONE: &str = "▶▶ auto mode on (shift+tab to cycle) · ← for agents\n\n○ deep-research  Deep research harness — synthesize a cited report.  28/28 agents done · 3m 4s · ↓ 1.1M tokens";
    const CAP_SKILL_TRAY_QUOTED_IN_HISTORY: &str = "⏺ 過去ログに \"22/28 agents done\" と出ていた話\n1行\n2行\n3行\n4行\n5行\n6行\n7行\n8行";
    const CAP_FLEET_WORKING: &str = "Claude Code v2.1.191\nOpus 4.8 · ~/workspace/charlie/app\n0 awaiting input · 1 working · 0 completed\n\nWorking\n✳ notification-toggles  マージして撤収して · →\n\nType a task to start another session. Each appears as a row — open any to see its work.\n\n› describe a task for a new session\n  enter to open · space to reply · ctrl+x to delete · ? for shortcuts";
    const CAP_FLEET_AWAITING: &str = "Claude Code v2.1.191\nOpus 4.8 · ~/workspace/charlie/app\n1 awaiting input · 1 working · 2 completed\n\n› describe a task for a new session";
    const CAP_FLEET_ALL_DONE: &str = "Claude Code v2.1.191\nOpus 4.8 · ~/workspace/charlie/app\n0 awaiting input · 0 working · 3 completed\n\n› describe a task for a new session";
    const CAP_FLEET_QUOTED_IN_HISTORY: &str = "⏺ ログに \"0 awaiting input · 1 working · 0 completed\" と出ていた話\n1行\n2行\n3行\n4行\n5行\n6行\n7行\n8行";
    const CAP_FLEET_QUOTED_BELOW_TOP_WINDOW: &str = "⏺ 会話の本文\n1行\n2行\n3行\n4行\n5行\n6行\n7行\n  1 awaiting input · 2 working · 3 completed\n───\n❯\n───";
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
        assert_eq!(detect_state(CAP_RUN, &claude()), CockpitTerminalState::Running);
    }

    #[test]
    fn running_ignores_trailing_blank_lines() {
        assert_eq!(
            detect_state(&with_trailing_blanks(CAP_RUN, 8), &claude()),
            CockpitTerminalState::Running
        );
    }

    #[test]
    fn marker_at_8th_line_is_running() {
        assert_eq!(
            detect_state(CAP_MARKER_AT_8TH, &claude()),
            CockpitTerminalState::Running
        );
    }

    #[test]
    fn marker_at_9th_line_is_idle() {
        assert_eq!(
            detect_state(CAP_MARKER_AT_9TH_HISTORY_QUOTE, &claude()),
            CockpitTerminalState::Idle
        );
    }

    #[test]
    fn running_detected_in_short_capture() {
        assert_eq!(
            detect_state(CAP_SHORT_RUN, &claude()),
            CockpitTerminalState::Running
        );
    }

    #[test]
    fn bg_panel_is_running_bg_agent() {
        assert_eq!(
            detect_state(CAP_BG, &claude()),
            CockpitTerminalState::RunningBgAgent
        );
    }

    #[test]
    fn bg_panel_trailing_blanks_running_bg_agent() {
        assert_eq!(
            detect_state(&with_trailing_blanks(CAP_BG, 3), &claude()),
            CockpitTerminalState::RunningBgAgent
        );
    }

    #[test]
    fn bg_multi_agents_running_bg_agent() {
        assert_eq!(
            detect_state(CAP_BG_MULTI, &claude()),
            CockpitTerminalState::RunningBgAgent
        );
    }

    #[test]
    fn bg_many_agents_push_heading_out_of_window_still_running_bg_agent() {
        assert_eq!(
            detect_state(CAP_BG_MANY_AGENTS, &claude()),
            CockpitTerminalState::RunningBgAgent
        );
    }

    #[test]
    fn bg_wrapped_agents_overflow_still_running_bg_agent() {
        assert_eq!(
            detect_state(CAP_BG_WRAPPED_OVERFLOW, &claude()),
            CockpitTerminalState::RunningBgAgent
        );
    }

    #[test]
    fn bg_stale_panel_scrolled_above_input_box_is_idle() {
        assert_eq!(
            detect_state(CAP_BG_STALE_SCROLLED, &claude()),
            CockpitTerminalState::Idle
        );
    }

    #[test]
    fn bg_short_running_bg_agent() {
        assert_eq!(
            detect_state(CAP_BG_SHORT, &claude()),
            CockpitTerminalState::RunningBgAgent
        );
    }

    #[test]
    fn skill_agent_tray_is_running_bg_agent() {
        assert_eq!(
            detect_state(CAP_SKILL_TRAY, &claude()),
            CockpitTerminalState::RunningBgAgent
        );
    }

    #[test]
    fn skill_agent_tray_all_done_is_idle() {
        assert_eq!(
            detect_state(CAP_SKILL_TRAY_ALL_DONE, &claude()),
            CockpitTerminalState::Idle
        );
    }

    #[test]
    fn skill_agent_tray_quoted_in_history_is_idle() {
        assert_eq!(
            detect_state(CAP_SKILL_TRAY_QUOTED_IN_HISTORY, &claude()),
            CockpitTerminalState::Idle
        );
    }

    #[test]
    fn skill_agents_running_parses_still_running_count() {
        assert_eq!(skill_agents_running(CAP_SKILL_TRAY), Some(6));
        assert_eq!(skill_agents_running(CAP_SKILL_TRAY_ALL_DONE), None);
        assert_eq!(skill_agents_running("1/1 agent done"), None);
        assert_eq!(skill_agents_running("0/3 agents done"), Some(3));
        assert_eq!(skill_agents_running("no agents here"), None);
        assert_eq!(skill_agents_running("3/2 agents done"), None);
        assert_eq!(skill_agents_running("22/28 agentsdone"), None);
        assert_eq!(skill_agents_running("22/28 agent done"), Some(6));
        assert_eq!(skill_agents_running("22/28 agents done · 2m 31s"), Some(6));
        assert_eq!(skill_agents_running("22/28 agents doneness reached"), None);
    }

    #[test]
    fn fleet_view_working_is_running_bg_agent() {
        assert_eq!(
            detect_state(CAP_FLEET_WORKING, &claude()),
            CockpitTerminalState::RunningBgAgent
        );
    }

    #[test]
    fn fleet_view_awaiting_input_is_waiting_input() {
        assert_eq!(
            detect_state(CAP_FLEET_AWAITING, &claude()),
            CockpitTerminalState::WaitingInput
        );
    }

    #[test]
    fn fleet_view_all_completed_is_idle() {
        assert_eq!(
            detect_state(CAP_FLEET_ALL_DONE, &claude()),
            CockpitTerminalState::Idle
        );
    }

    #[test]
    fn fleet_view_header_without_claude_is_no_claude() {
        assert_eq!(
            detect_state(CAP_FLEET_WORKING, &no_claude()),
            CockpitTerminalState::NoClaude
        );
    }

    #[test]
    fn fleet_view_header_quoted_in_history_is_idle() {
        assert_eq!(
            detect_state(CAP_FLEET_QUOTED_IN_HISTORY, &claude()),
            CockpitTerminalState::Idle
        );
    }

    #[test]
    fn fleet_view_header_below_top_window_is_idle() {
        assert_eq!(
            detect_state(CAP_FLEET_QUOTED_BELOW_TOP_WINDOW, &claude()),
            CockpitTerminalState::Idle
        );
        assert!(fleet_view_counts(CAP_FLEET_QUOTED_BELOW_TOP_WINDOW).is_none());
    }

    #[test]
    fn fleet_view_counts_parses_header_line() {
        let counts = fleet_view_counts(CAP_FLEET_WORKING).expect("header should parse");
        assert_eq!(counts.awaiting_input, 0);
        assert_eq!(counts.working, 1);
        let counts = fleet_view_counts("12 awaiting input · 34 working · 56 completed").unwrap();
        assert_eq!(counts.awaiting_input, 12);
        assert_eq!(counts.working, 34);
        // Only a whitespace-indented header line matches; quotes and bullets do not.
        assert!(fleet_view_counts("  1 awaiting input · 2 working · 3 completed").is_some());
        assert!(fleet_view_counts("- 1 awaiting input · 2 working · 3 completed").is_none());
        assert!(fleet_view_counts("⏺ 1 awaiting input · 2 working · 3 completed").is_none());
        // All three segments are required, with clean boundaries after each word.
        assert!(fleet_view_counts("1 working · 2 completed").is_none());
        assert!(fleet_view_counts("1 awaiting input · 2 working").is_none());
        assert!(fleet_view_counts("1 awaiting inputs · 2 working · 3 completed").is_none());
        assert!(fleet_view_counts("1 awaiting input · 2 workingly · 3 completed").is_none());
        assert!(fleet_view_counts("1 awaiting input · 2 working · 3 completedX").is_none());
        assert!(fleet_view_counts("1 awaiting input · 2 working · 3 completed5").is_none());
        assert!(fleet_view_counts("1 awaiting input · 2 working · 3 completedと表示").is_none());
    }

    #[test]
    fn bg_inline_circle_in_input_box_is_idle() {
        assert_eq!(
            detect_state(CAP_BG_INPUT_BOX, &claude()),
            CockpitTerminalState::Idle
        );
    }

    #[test]
    fn bg_heading_but_inline_circle_is_idle() {
        assert_eq!(
            detect_state(CAP_BG_HEADING_BUT_INLINE_CIRCLE, &claude()),
            CockpitTerminalState::Idle
        );
    }

    #[test]
    fn bg_radio_without_heading_is_idle() {
        assert_eq!(detect_state(CAP_BG_RADIO, &claude()), CockpitTerminalState::Idle);
    }

    #[test]
    fn bg_history_quote_is_idle() {
        assert_eq!(
            detect_state(CAP_BG_HISTORY_QUOTE, &claude()),
            CockpitTerminalState::Idle
        );
    }

    #[test]
    fn wizard_two_choice_is_waiting_input() {
        assert_eq!(
            detect_state(CAP_WIZARD_TWO_CHOICE, &claude()),
            CockpitTerminalState::WaitingInput
        );
    }

    #[test]
    fn wizard_single_choice_is_idle() {
        assert_eq!(
            detect_state(CAP_WIZARD_SINGLE, &claude()),
            CockpitTerminalState::Idle
        );
    }

    #[test]
    fn wizard_wins_over_spinner() {
        assert_eq!(
            detect_state(CAP_WIZARD_WITH_MARKER, &claude()),
            CockpitTerminalState::WaitingInput
        );
    }

    #[test]
    fn numbered_list_without_cursor_is_not_wizard() {
        assert_eq!(
            detect_state(CAP_NUMBERED_LIST_NO_CURSOR, &claude()),
            CockpitTerminalState::Idle
        );
    }

    #[test]
    fn no_hint_with_claude_is_idle() {
        assert_eq!(detect_state(CAP_IDLE_PLAIN, &claude()), CockpitTerminalState::Idle);
    }

    #[test]
    fn no_hint_without_claude_is_no_claude() {
        assert_eq!(
            detect_state(CAP_SHELL_ONLY, &no_claude()),
            CockpitTerminalState::NoClaude
        );
    }

    #[test]
    fn empty_capture_with_claude_is_idle() {
        assert_eq!(detect_state("", &claude()), CockpitTerminalState::Idle);
    }

    #[test]
    fn empty_capture_without_claude_is_no_claude() {
        assert_eq!(detect_state("", &no_claude()), CockpitTerminalState::NoClaude);
    }

    #[test]
    fn wizard_wins_over_claude_detection() {
        assert_eq!(
            detect_state(CAP_WIZARD_TWO_CHOICE, &no_claude()),
            CockpitTerminalState::WaitingInput
        );
    }

    #[test]
    fn wide_idle_is_idle() {
        assert_eq!(detect_state(CAP_IDLE_80, &claude()), CockpitTerminalState::Idle);
    }

    #[test]
    fn wide_wrapped_spinner_tail_is_running() {
        assert_eq!(
            detect_state(CAP_RUN_80_WRAPPED_TAIL, &claude()),
            CockpitTerminalState::Running
        );
    }

    #[test]
    fn wide_wrapped_option_is_waiting_input() {
        assert_eq!(
            detect_state(CAP_WIZARD_80_WRAPPED_OPTION, &claude()),
            CockpitTerminalState::WaitingInput
        );
    }

    #[test]
    fn wide_wrap_starting_with_number_stays_waiting_input() {
        assert_eq!(
            detect_state(CAP_WIZARD_80_WRAP_STARTS_WITH_NUMBER, &claude()),
            CockpitTerminalState::WaitingInput
        );
    }

    #[test]
    fn wide_old_spinner_quote_out_of_window_is_idle() {
        assert_eq!(
            detect_state(CAP_IDLE_80_WITH_OLD_SPINNER_QUOTE, &claude()),
            CockpitTerminalState::Idle
        );
    }

    #[test]
    fn wide_bg_full_screen_is_running_bg_agent() {
        assert_eq!(
            detect_state(CAP_BG_80_FULL, &claude()),
            CockpitTerminalState::RunningBgAgent
        );
    }

    #[test]
    fn run_marker_is_overridable() {
        let cap = "✻ 走行中 [RUNNING-NOW]\n❯ ";
        assert_eq!(detect_state(cap, &claude()), CockpitTerminalState::Idle);
        assert_eq!(
            detect_state(
                cap,
                &DetectStateOptions {
                    has_claude: true,
                    run_marker: Some("[RUNNING-NOW]"),
                    bg_agent_marker: None,
                }
            ),
            CockpitTerminalState::Running
        );
    }

    #[test]
    fn bg_marker_is_overridable() {
        let cap = "  ⏺ main\n  ● general-purpose  作業  1s";
        assert_eq!(detect_state(cap, &claude()), CockpitTerminalState::Idle);
        assert_eq!(
            detect_state(
                cap,
                &DetectStateOptions {
                    has_claude: true,
                    run_marker: None,
                    bg_agent_marker: Some("●"),
                }
            ),
            CockpitTerminalState::RunningBgAgent
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
            CockpitTerminalState::Idle
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

    // ---- is_menu_open (Claude Code menu/overlay detection) ----

    #[test]
    fn menu_open_detects_marker_at_indented_line_head() {
        let cap = "\n   Select login method\n   1. Claude account\n   2. Anthropic Console\n";
        assert!(is_menu_open(cap, DEFAULT_MENU_MARKERS));
    }

    #[test]
    fn menu_open_detects_marker_behind_box_border() {
        assert!(is_menu_open("│ Claude Code Status         │", DEFAULT_MENU_MARKERS));
    }

    #[test]
    fn menu_open_is_case_insensitive() {
        assert!(is_menu_open("  claude code status", DEFAULT_MENU_MARKERS));
    }

    #[test]
    fn menu_open_false_for_marker_quoted_mid_sentence_in_body() {
        let cap = "⏺ Run /model to open the Select Model menu\n───\n❯\n───";
        assert!(!is_menu_open(cap, DEFAULT_MENU_MARKERS));
    }

    #[test]
    fn menu_open_false_for_ordinary_conversation() {
        let cap = "⏺ 完了しました。\n╭───╮\n│ ❯ │\n╰───╯\n  ? for shortcuts";
        assert!(!is_menu_open(cap, DEFAULT_MENU_MARKERS));
    }

    #[test]
    fn menu_open_empty_marker_list_never_matches() {
        assert!(!is_menu_open("Select login method", &[]));
    }

    #[test]
    fn menu_open_ignores_empty_markers_in_the_list() {
        assert!(!is_menu_open("Select login method", &[""]));
    }

    #[test]
    fn menu_open_markers_are_overridable() {
        let cap = "│ CUSTOM MENU OPEN │";
        assert!(!is_menu_open(cap, DEFAULT_MENU_MARKERS));
        assert!(is_menu_open(cap, &["CUSTOM MENU OPEN"]));
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
            CockpitTerminalState::Running
        );
    }

    #[test]
    fn fallback_interrupted_user_is_idle() {
        assert_eq!(
            fallback_state(Some(&user(true)), Some(5.0), 2.0),
            CockpitTerminalState::Idle
        );
    }

    #[test]
    fn fallback_stale_user_is_idle() {
        assert_eq!(
            fallback_state(Some(&user(false)), Some(120.0), 2.0),
            CockpitTerminalState::Idle
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
            CockpitTerminalState::Idle
        );
    }

    #[test]
    fn fallback_no_event_is_idle() {
        assert_eq!(fallback_state(None, Some(5.0), 2.0), CockpitTerminalState::Idle);
    }

    #[test]
    fn fallback_unknown_mtime_is_idle() {
        assert_eq!(
            fallback_state(Some(&user(false)), None, 2.0),
            CockpitTerminalState::Idle
        );
    }

    #[test]
    fn fallback_freshness_boundary_poll_2() {
        assert_eq!(
            fallback_state(Some(&user(false)), Some(30.0), 2.0),
            CockpitTerminalState::Running
        );
        assert_eq!(
            fallback_state(Some(&user(false)), Some(31.0), 2.0),
            CockpitTerminalState::Idle
        );
    }

    #[test]
    fn fallback_freshness_boundary_poll_20() {
        assert_eq!(
            fallback_state(Some(&user(false)), Some(40.0), 20.0),
            CockpitTerminalState::Running
        );
        assert_eq!(
            fallback_state(Some(&user(false)), Some(41.0), 20.0),
            CockpitTerminalState::Idle
        );
    }

    #[test]
    fn fallback_invalid_poll_defaults_to_2() {
        assert_eq!(
            fallback_state(Some(&user(false)), Some(30.0), 0.0),
            CockpitTerminalState::Running
        );
        assert_eq!(
            fallback_state(Some(&user(false)), Some(31.0), -1.0),
            CockpitTerminalState::Idle
        );
        assert_eq!(
            fallback_state(Some(&user(false)), Some(30.0), f64::NAN),
            CockpitTerminalState::Running
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
            apply_startup_grace(CockpitTerminalState::NoClaude, 1, 3),
            CockpitTerminalState::Starting
        );
        assert_eq!(
            apply_startup_grace(CockpitTerminalState::NoClaude, 3, 3),
            CockpitTerminalState::Starting
        );
        // Exceeding the grace is finalized as NoClaude (does not hide a resume failure).
        assert_eq!(
            apply_startup_grace(CockpitTerminalState::NoClaude, 4, 3),
            CockpitTerminalState::NoClaude
        );
    }

    #[test]
    fn startup_grace_leaves_non_no_claude_states_untouched() {
        for s in [
            CockpitTerminalState::Running,
            CockpitTerminalState::RunningBgAgent,
            CockpitTerminalState::Idle,
            CockpitTerminalState::WaitingInput,
            CockpitTerminalState::Unknown,
        ] {
            assert_eq!(apply_startup_grace(s, 1, 3), s);
        }
    }

    // ---- is_wizard bottom-anchored (phantom-bell fix) ----

    // Wizard-like text quoted in the history body, with the live idle input box below it. A
    // whole-capture scan misfires as waiting_input; anchoring on the bottom-most `❯` (the bare input
    // prompt) does not.
    const CAP_WIZARD_HISTORY_QUOTE_THEN_IDLE: &str = "過去ログ: ❯ 1. Yes\n  2. No\n⏺ 承知しました。\n╭───╮\n│ ❯ │\n╰───╯\n  ? for shortcuts";

    // A tall 5-option prompt whose selected `❯ 1.` cursor sits far above the bottom (wrapped options +
    // a footer). A fixed bottom-line window would push the cursor out and drop the bell.
    const CAP_WIZARD_TALL_CURSOR_ABOVE_WINDOW: &str = "Do you want to proceed?\n❯ 1. Yes\n  2. Option two wraps to a\n     continuation line\n  3. Option three wraps to a\n     continuation line\n  4. Option four wraps to a\n     continuation line\n  5. No, and tell Claude what to do differently (esc)\n  ? for shortcuts";

    // A running session whose output happens to quote a numbered choice, with the input box (running
    // spinner keeps it) as the bottom-most `❯`.
    const CAP_RUN_WITH_QUOTED_CHOICE: &str = "⏺ 例: ❯ 1. Yes\n  2. No のような選択肢\n✻ Simmering… (esc to interrupt · ctrl+t)\n╭───╮\n│ ❯ │\n╰───╯";

    #[test]
    fn wizard_quoted_in_history_is_not_waiting_input() {
        assert!(!is_wizard(CAP_WIZARD_HISTORY_QUOTE_THEN_IDLE));
        assert_eq!(
            detect_state(CAP_WIZARD_HISTORY_QUOTE_THEN_IDLE, &claude()),
            CockpitTerminalState::Idle
        );
    }

    #[test]
    fn wizard_still_detected_when_choices_sit_at_the_bottom() {
        assert!(is_wizard(CAP_WIZARD_WITH_MARKER));
        assert!(is_wizard(CAP_WIZARD_80_WRAPPED_OPTION));
    }

    #[test]
    fn wizard_detected_when_cursor_pushed_far_above_the_bottom() {
        assert!(is_wizard(CAP_WIZARD_TALL_CURSOR_ABOVE_WINDOW));
        assert_eq!(
            detect_state(CAP_WIZARD_TALL_CURSOR_ABOVE_WINDOW, &claude()),
            CockpitTerminalState::WaitingInput
        );
    }

    #[test]
    fn quoted_choice_above_the_input_box_is_not_waiting_input() {
        assert!(!is_wizard(CAP_RUN_WITH_QUOTED_CHOICE));
        assert_eq!(
            detect_state(CAP_RUN_WITH_QUOTED_CHOICE, &claude()),
            CockpitTerminalState::Running
        );
    }

    // ---- resolve_state (event-authoritative arbitration) ----

    #[test]
    fn hook_event_fresh_within_sec_matches_shared_rule() {
        assert_eq!(hook_event_fresh_within_sec(2.0), 30.0);
        assert_eq!(hook_event_fresh_within_sec(20.0), 40.0);
        assert_eq!(hook_event_fresh_within_sec(0.0), 30.0);
    }

    #[test]
    fn resolve_without_event_is_scrape() {
        for s in [
            CockpitTerminalState::Idle,
            CockpitTerminalState::Running,
            CockpitTerminalState::RunningBgAgent,
            CockpitTerminalState::WaitingInput,
        ] {
            assert_eq!(resolve_state(s, None, true, true), s);
        }
    }

    #[test]
    fn resolve_stale_event_is_scrape() {
        assert_eq!(
            resolve_state(CockpitTerminalState::Idle, Some(HookEvent::Waiting), false, true),
            CockpitTerminalState::Idle
        );
        assert_eq!(
            resolve_state(CockpitTerminalState::WaitingInput, Some(HookEvent::Done), false, true),
            CockpitTerminalState::WaitingInput
        );
    }

    #[test]
    fn resolve_fresh_waiting_promotes_to_bell() {
        for s in [
            CockpitTerminalState::Idle,
            CockpitTerminalState::Running,
            CockpitTerminalState::RunningBgAgent,
        ] {
            assert_eq!(
                resolve_state(s, Some(HookEvent::Waiting), true, true),
                CockpitTerminalState::WaitingInput
            );
        }
    }

    #[test]
    fn resolve_fresh_done_clears_phantom_bell_to_idle() {
        assert_eq!(
            resolve_state(CockpitTerminalState::WaitingInput, Some(HookEvent::Done), true, true),
            CockpitTerminalState::Idle
        );
    }

    #[test]
    fn resolve_fresh_prompt_or_tool_clears_phantom_bell_to_running() {
        for ev in [HookEvent::Prompt, HookEvent::Tool] {
            assert_eq!(
                resolve_state(CockpitTerminalState::WaitingInput, Some(ev), true, true),
                CockpitTerminalState::Running
            );
        }
    }

    #[test]
    fn resolve_non_waiting_events_leave_a_non_bell_scrape_untouched() {
        // done/prompt/tool clear only a phantom bell; a scrape that is not WaitingInput is kept as-is.
        for ev in [HookEvent::Done, HookEvent::Prompt, HookEvent::Tool] {
            assert_eq!(
                resolve_state(CockpitTerminalState::Running, Some(ev), true, true),
                CockpitTerminalState::Running
            );
            assert_eq!(
                resolve_state(CockpitTerminalState::RunningBgAgent, Some(ev), true, true),
                CockpitTerminalState::RunningBgAgent
            );
        }
    }

    #[test]
    fn resolve_without_claude_preserves_process_truth() {
        for s in [CockpitTerminalState::NoClaude, CockpitTerminalState::Starting] {
            assert_eq!(resolve_state(s, Some(HookEvent::Waiting), true, false), s);
        }
    }
}

