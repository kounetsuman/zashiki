//! The pure evaluation helpers of the status poller.

use zashiki_core::repos::org_names;
use zashiki_core::session_state::{
    CockpitTerminalState, DEFAULT_BG_AGENT_MARKER, DEFAULT_LIMIT_MARKERS, DEFAULT_MENU_MARKERS,
};

use zashiki_core::process_tree::find_sid_in_tree;

use crate::poller_types::ModelReading;
use crate::protocol::CockpitTerminalInfo;
use crate::status_poller::{CockpitTerminal, CockpitTerminalPane, PollConfig};

/// The wire CockpitTerminalState string.
pub(crate) fn state_wire(state: CockpitTerminalState) -> &'static str {
    match state {
        CockpitTerminalState::WaitingInput => "waiting_input",
        CockpitTerminalState::Running => "running",
        CockpitTerminalState::RunningBgAgent => "running_bg_agent",
        CockpitTerminalState::Idle => "idle",
        CockpitTerminalState::Watching => "watching",
        CockpitTerminalState::NoClaude => "no_claude",
        CockpitTerminalState::Starting => "starting",
        CockpitTerminalState::Unknown => "unknown",
    }
}

/// Whether a claude is alive in the terminal in this state — the gate for reading the transcript for
/// the session status footer's tokens and elapsed time. The model is not gated on it: a resolved sid
/// already proves claude is running, and a scraped screen can be undecidable (copy-mode) while it is.
pub(crate) fn claude_is_alive(state: CockpitTerminalState) -> bool {
    matches!(
        state,
        CockpitTerminalState::Running
            | CockpitTerminalState::RunningBgAgent
            | CockpitTerminalState::WaitingInput
            | CockpitTerminalState::Idle
            | CockpitTerminalState::Watching
    )
}

/// The model to show for a terminal, from the two sources that know one: Claude Code's statusLine
/// reports the model that will answer and re-reports it after a `/model` switch, while the transcript
/// records the model that did answer. Either can hold the newer fact — the statusLine stops reporting
/// once its bridge is gone, and the transcript stands still while a session idles — so the reading
/// established later wins, and an untimed reading only wins for lack of a rival. An id past
/// `WIRE_STRING_MAX_LEN` is dropped here, the one point both sources pass through, because the client
/// rejects a whole `state.sync` over one out-of-bound string.
pub(crate) fn resolve_model(
    reported: Option<ModelReading>,
    from_transcript: Option<ModelReading>,
) -> Option<String> {
    let newer = match (reported, from_transcript) {
        (Some(report), Some(transcript)) => {
            Some(if transcript.at_ms > report.at_ms { transcript } else { report })
        }
        (report, transcript) => report.or(transcript),
    };
    newer
        .map(|reading| reading.model)
        .filter(|model| model.len() <= crate::protocol::WIRE_STRING_MAX_LEN)
}

/// Splits a comma-separated marker override (trimmed, empties dropped); an unset or all-empty
/// override falls back to the defaults.
fn resolve_markers(raw: Option<&str>, defaults: &[&str]) -> Vec<String> {
    let parsed: Vec<String> = raw
        .unwrap_or("")
        .split(',')
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(str::to_string)
        .collect();
    if parsed.is_empty() {
        defaults.iter().map(|m| m.to_string()).collect()
    } else {
        parsed
    }
}

/// Resolves the limit markers (ZK_LIMIT_MARKER override, falling back to DEFAULT_LIMIT_MARKERS).
pub(crate) fn resolve_limit_markers(config: &PollConfig) -> Vec<String> {
    resolve_markers(config.limit_marker.as_deref(), DEFAULT_LIMIT_MARKERS)
}

/// Resolves the bg-agent marker (empty/unset falls back to the default; same policy as detect_state's resolve).
pub(crate) fn resolve_bg_agent_marker(config: &PollConfig) -> &str {
    match config.bg_agent_marker.as_deref() {
        Some(m) if !m.is_empty() => m,
        _ => DEFAULT_BG_AGENT_MARKER,
    }
}

/// Resolves the menu markers (ZK_MENU_MARKERS override, falling back to DEFAULT_MENU_MARKERS).
pub(crate) fn resolve_menu_markers(config: &PollConfig) -> Vec<String> {
    resolve_markers(config.menu_markers.as_deref(), DEFAULT_MENU_MARKERS)
}

/// The last segment of cwd (the repo name).
pub(crate) fn last_path_segment(path: &str) -> &str {
    path.split('/').rfind(|s| !s.is_empty()).unwrap_or(path)
}

/// Determines the capture target pane and sid. The first pane whose process tree contains claude(sid),
/// or the leftmost pane (smallest left) if none. None if there are no panes.
pub(crate) struct Picked {
    pub(crate) pane_id: String,
    pub(crate) cwd: String,
    pub(crate) sid: Option<String>,
    /// The root pid of the picked pane. Used to detect window rebuilds (pid change) from restore/kill.
    pub(crate) pid: i64,
}

pub(crate) fn pick_pane(
    win: &CockpitTerminal,
    maps: &zashiki_core::process_tree::ProcessMaps,
) -> Option<Picked> {
    let mut leftmost: Option<&CockpitTerminalPane> = None;
    for pane in &win.panes {
        if let Some(sid) = find_sid_in_tree(pane.pid, maps) {
            return Some(Picked {
                pane_id: pane.pane_id.clone(),
                cwd: pane.current_path.clone(),
                sid: Some(sid),
                pid: pane.pid,
            });
        }
        match leftmost {
            Some(l) if pane.left >= l.left => {}
            _ => leftmost = Some(pane),
        }
    }
    leftmost.map(|p| Picked {
        pane_id: p.pane_id.clone(),
        cwd: p.current_path.clone(),
        sid: None,
        pid: p.pid,
    })
}

/// Whether the picked pane is in_mode such as copy-mode (avoided because the capture becomes history and misjudges).
pub(crate) fn is_pane_in_mode(win: &CockpitTerminal, pane_id: &str) -> bool {
    win.panes
        .iter()
        .find(|p| p.pane_id == pane_id)
        .is_some_and(|p| p.in_mode)
}

pub(crate) fn roots_ref(roots: &[String]) -> Vec<&str> {
    roots.iter().map(String::as_str).collect()
}

/// All repos.conf orgs plus detected orgs, deduplicated in display order (orgs with 0 sessions are not dropped).
pub(crate) fn build_orgs(repos_roots: &[String], sessions: &[CockpitTerminalInfo]) -> Vec<String> {
    let roots = roots_ref(repos_roots);
    let mut orgs = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for org in org_names(&roots)
        .into_iter()
        .map(str::to_string)
        .chain(sessions.iter().map(|s| s.org.clone()))
    {
        if seen.insert(org.clone()) {
            orgs.push(org);
        }
    }
    orgs
}

#[cfg(test)]
mod tests {
    use super::*;
    use zashiki_core::process_tree::{build_process_maps, parse_ps_snapshot};

    const SID: &str = "0b6cbc45-83a9-4f2e-9c3d-1a2b3c4d5e6f";

    fn reading(model: &str, at_ms: u64) -> Option<ModelReading> {
        Some(ModelReading { model: model.to_string(), at_ms: Some(at_ms) })
    }

    #[test]
    fn the_newer_reading_wins_whichever_source_it_is() {
        assert_eq!(
            resolve_model(reading("claude-opus-5", 2000), reading("claude-sonnet-5", 1000)).as_deref(),
            Some("claude-opus-5")
        );
        assert_eq!(
            resolve_model(reading("claude-opus-5", 1000), reading("claude-sonnet-5", 2000)).as_deref(),
            Some("claude-sonnet-5")
        );
    }

    /// A session that switched model and then went quiet keeps the switched-to model: nothing has
    /// answered since, so the report stays the newer fact however long ago it arrived.
    #[test]
    fn a_report_that_stopped_arriving_still_beats_an_older_reply() {
        assert_eq!(
            resolve_model(reading("claude-opus-5", 10_000), reading("claude-sonnet-5", 9_000))
                .as_deref(),
            Some("claude-opus-5")
        );
    }

    /// Same instant (a reply and a report from the same render) resolves to the report, which names
    /// the model about to answer rather than the one that just did.
    #[test]
    fn a_tie_goes_to_the_statusline_report() {
        assert_eq!(
            resolve_model(reading("claude-opus-5", 1000), reading("claude-sonnet-5", 1000)).as_deref(),
            Some("claude-opus-5")
        );
    }

    #[test]
    fn an_untimed_reading_wins_only_when_it_is_the_only_one() {
        let untimed = Some(ModelReading { model: "claude-sonnet-5".to_string(), at_ms: None });
        assert_eq!(resolve_model(None, untimed.clone()).as_deref(), Some("claude-sonnet-5"));
        assert_eq!(
            resolve_model(reading("claude-opus-5", 1), untimed).as_deref(),
            Some("claude-opus-5")
        );
    }

    #[test]
    fn an_implausibly_long_id_is_dropped_from_either_source() {
        let long = "c".repeat(crate::protocol::WIRE_STRING_MAX_LEN + 1);
        assert_eq!(resolve_model(reading(&long, 1000), None), None);
        assert_eq!(resolve_model(None, reading(&long, 1000)), None);
    }

    #[test]
    fn without_a_report_the_transcript_decides() {
        assert_eq!(
            resolve_model(None, reading("claude-sonnet-5", 1000)).as_deref(),
            Some("claude-sonnet-5")
        );
        assert_eq!(resolve_model(None, None), None);
    }

    fn pane(pane_id: &str, pid: i64, left: i64, cwd: &str) -> CockpitTerminalPane {
        CockpitTerminalPane {
            pane_id: pane_id.to_string(),
            active: true,
            pid,
            left,
            in_mode: false,
            current_path: cwd.to_string(),
        }
    }

    fn window(cockpit_terminal_id: &str, name: &str, panes: Vec<CockpitTerminalPane>) -> CockpitTerminal {
        CockpitTerminal {
            cockpit_terminal_id: cockpit_terminal_id.to_string(),
            name: name.to_string(),
            active: true,
            panes,
        }
    }

    #[test]
    fn pick_pane_prefers_pane_with_claude_over_leftmost() {
        let maps = build_process_maps(&parse_ps_snapshot(&format!(
            "  100    1 -zsh\n  300  200 claude --session-id {SID}\n"
        )));
        let win = window(
            "@1",
            "work",
            vec![pane("%left", 100, 0, "/a"), pane("%claude", 200, 5, "/b")],
        );
        let picked = pick_pane(&win, &maps).unwrap();
        assert_eq!(picked.pane_id, "%claude");
        assert_eq!(picked.sid.as_deref(), Some(SID));
    }

    #[test]
    fn pick_pane_falls_back_to_leftmost_without_claude() {
        let maps = build_process_maps(&parse_ps_snapshot("  100    1 -zsh\n"));
        let win = window(
            "@1",
            "work",
            vec![pane("%right", 100, 9, "/a"), pane("%left", 101, 2, "/b")],
        );
        let picked = pick_pane(&win, &maps).unwrap();
        assert_eq!(picked.pane_id, "%left");
        assert!(picked.sid.is_none());
    }

    #[test]
    fn pick_pane_tie_break_keeps_first_seen_at_same_left() {
        let maps = build_process_maps(&parse_ps_snapshot("  100    1 -zsh\n"));
        let win = window(
            "@1",
            "work",
            vec![pane("%first", 100, 0, "/a"), pane("%second", 101, 0, "/b")],
        );
        assert_eq!(pick_pane(&win, &maps).unwrap().pane_id, "%first");
    }
}
