//! The public data types and infra-boundary trait of the status poller.

use std::collections::{BTreeMap, HashSet};
use std::future::Future;

use crate::jsonl::SessionUsageData;
use crate::protocol::CockpitTerminalInfo;

/// Pane material for a work window (material for the poller's decisions).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CockpitTerminalPane {
    pub pane_id: String,
    pub active: bool,
    pub pid: i64,
    pub left: i64,
    pub in_mode: bool,
    pub current_path: String,
}

/// A work window (in owned mode, 1 session = 1 window and `cockpit_terminal_id` is the owned PTY's session id).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CockpitTerminal {
    pub cockpit_terminal_id: String,
    pub name: String,
    pub active: bool,
    pub panes: Vec<CockpitTerminalPane>,
}

/// The head/tail slices of jsonl plus the elapsed mtime seconds of the tail file (read by the infra).
pub struct Slices {
    pub head: String,
    pub tail: String,
    pub mtime_age_sec: f64,
}

/// The last hook event for a sid with its age (seconds), read from the shared hook-event store. The
/// age is computed by the infra (mirroring `Slices.mtime_age_sec`) so `resolve_state`'s freshness gate
/// stays a pure decision in the poller.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HookEventAge {
    pub event: zashiki_core::session_state::HookEvent,
    pub age_sec: f64,
}

/// One reading of a session's model with when it was established (epoch-ms), so the poller can take
/// the newer of its two sources without needing a clock of its own. `at_ms` is None when the source
/// gave no timestamp.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelReading {
    pub model: String,
    pub at_ms: Option<u64>,
}

/// The infra boundary the poller depends on (onion port). Implementations are the real-I/O adapter and test stubs.
/// It requires `Send` on the returned futures so tasks can be spawned onto a timer-driven task (the impl side can
/// still satisfy this as a plain `async fn`; RPITIT).
pub trait PollerPorts {
    fn list_work_windows(&self) -> impl Future<Output = Vec<CockpitTerminal>> + Send;
    /// The visible screen of the capture target pane. Empty string on failure.
    fn capture_pane(&self, target: &str) -> impl Future<Output = String> + Send;
    fn ps_snapshot(&self) -> impl Future<Output = String> + Send;
    /// The head/tail slices of jsonl (None if the sid is unresolved or unread).
    fn read_slices(&self, cwd: &str, sid: &str) -> impl Future<Output = Option<Slices>> + Send;
    /// The first user-utterance title (None if unresolved). Defaulted to None so stubs that do not
    /// exercise titling need not implement it.
    fn read_first_user_title(
        &self,
        _cwd: &str,
        _sid: &str,
        _max_chars: usize,
    ) -> impl Future<Output = Option<String>> + Send {
        async { None }
    }
    /// The elapsed mtime seconds of each subagents/*.jsonl file (material for the count).
    fn subagent_ages(&self, cwd: &str, sid: &str) -> impl Future<Output = Vec<f64>> + Send;
    /// Raw `lsof -F pfn -a -d 1` output for resident background-shell detection (parsed by `crate::shells`).
    fn lsof_fd_outputs(&self) -> impl Future<Output = String> + Send;
    /// The set of `toolUseResult.backgroundTaskId` in the transcript (separates bg shells from fg).
    fn background_task_ids(&self, cwd: &str, sid: &str)
        -> impl Future<Output = HashSet<String>> + Send;
    /// Token/timing rollup for the status footer (None when there is no readable transcript).
    /// Defaulted to None so stubs that do not exercise the footer need not implement it.
    fn session_usage(
        &self,
        _cwd: &str,
        _sid: &str,
    ) -> impl Future<Output = Option<SessionUsageData>> + Send {
        async { None }
    }
    /// The model Claude Code last reported for `sid` through its statusLine, with when it reported it
    /// (None when the statusLine bridge is not in place, or nothing was reported). Reported from a
    /// session's first render, so it covers a terminal whose transcript has no assistant reply yet.
    /// Defaulted to None so stubs that do not exercise the footer need not implement it.
    fn active_model(&self, _sid: &str) -> impl Future<Output = Option<ModelReading>> + Send {
        async { None }
    }
    /// The last recorded Claude Code hook event for `sid` (None if hooks are unconfigured or nothing
    /// recorded). Read from the shared hook-event store; feeds `resolve_state`. Defaulted to None so
    /// stubs that do not exercise the event layer need not implement it.
    fn last_hook_event(&self, _sid: &str) -> impl Future<Output = Option<HookEventAge>> + Send {
        async { None }
    }
}

/// Evaluation configuration (reposRoots is fixed at startup; colors can be read each time).
pub struct PollConfig {
    pub repos_roots: Vec<String>,
    pub org_colors: BTreeMap<String, String>,
    pub org_aliases: BTreeMap<String, String>,
    pub poll_sec: f64,
    pub run_marker: Option<String>,
    pub bg_agent_marker: Option<String>,
    /// Comma-separated marker phrases for the limit-reached banners (ZK_LIMIT_MARKER; empty/unset
    /// falls back to DEFAULT_LIMIT_MARKERS). Each must head a line after leading decoration, not
    /// merely appear in it.
    pub limit_marker: Option<String>,
    /// Comma-separated marker phrases for Claude Code menu/overlay screens (ZK_MENU_MARKERS;
    /// empty/unset falls back to DEFAULT_MENU_MARKERS).
    pub menu_markers: Option<String>,
}

/// The result of one evaluation (the shape distributed via state.sync; same shape as protocol's StateSync).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StateSnapshot {
    pub sessions: Vec<CockpitTerminalInfo>,
    pub orgs: Vec<String>,
    pub org_colors: BTreeMap<String, String>,
    pub org_aliases: BTreeMap<String, String>,
}
