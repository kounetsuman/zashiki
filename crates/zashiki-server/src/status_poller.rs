//! The evaluation logic of the server-side state poller (a port of TS `packages/server/src/usecase/status-poller.ts`).
//! It captures every work window, decides using core's pure functions, and notifies the caller only when something
//! changed. The infra (tmux capture / ps / jsonl reads) is injected via `PollerPorts`, and this module holds only
//! the logic (timer driving and WS broadcast wiring come later).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;

use zashiki_core::process_tree::{build_process_maps, find_sid_in_tree, parse_ps_snapshot};
use zashiki_core::repos::{org_names, org_of_cwd};
use zashiki_core::session_state::{
    apply_startup_grace, count_running_subagents, detect_state, fallback_state, is_limit_reached,
    startup_grace_polls, subagent_fresh_within_sec, DetectStateOptions, SessionState,
    DEFAULT_LIMIT_MARKER,
};

use crate::jsonl::{first_user_title, last_user_or_assistant_event};
use crate::protocol::SessionInfo;
use crate::shells::{count_running_shells_for_sid, parse_lsof_fd_outputs, ShellOutput};

const TITLE_MAX_CHARS: usize = 30;

/// Pane material for a work window (material for the poller's decisions).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkWindowPane {
    pub pane_id: String,
    pub active: bool,
    pub pid: i64,
    pub left: i64,
    pub in_mode: bool,
    pub current_path: String,
}

/// A work window (in owned mode, 1 session = 1 window and `window_id` is the owned PTY's session id).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkWindow {
    pub window_id: String,
    pub name: String,
    pub active: bool,
    pub panes: Vec<WorkWindowPane>,
}

/// The head/tail slices of jsonl plus the elapsed mtime seconds of the tail file (read by the infra).
pub struct Slices {
    pub head: String,
    pub tail: String,
    pub mtime_age_sec: f64,
}

/// The infra boundary the poller depends on (onion port). Implementations are the real-I/O adapter and test stubs.
/// It requires `Send` on the returned futures so tasks can be spawned onto a timer-driven task (the impl side can
/// still satisfy this as a plain `async fn`; RPITIT).
pub trait PollerPorts {
    fn list_work_windows(&self) -> impl Future<Output = Vec<WorkWindow>> + Send;
    /// The visible screen of the capture target pane (pane_id for tmux). Empty string on failure.
    fn capture_pane(&self, target: &str) -> impl Future<Output = String> + Send;
    fn ps_snapshot(&self) -> impl Future<Output = String> + Send;
    /// The head/tail slices of jsonl (None if the sid is unresolved or unread).
    fn read_slices(&self, cwd: &str, sid: &str) -> impl Future<Output = Option<Slices>> + Send;
    /// The elapsed mtime seconds of each subagents/*.jsonl file (material for the count).
    fn subagent_ages(&self, cwd: &str, sid: &str) -> impl Future<Output = Vec<f64>> + Send;
    /// Raw `lsof -F pfn -a -d 1` output for resident background-shell detection (parsed by `crate::shells`).
    fn lsof_fd_outputs(&self) -> impl Future<Output = String> + Send;
    /// The set of `toolUseResult.backgroundTaskId` in the transcript (separates bg shells from fg).
    fn background_task_ids(&self, cwd: &str, sid: &str)
        -> impl Future<Output = HashSet<String>> + Send;
}

/// Evaluation configuration (reposRoots is fixed at startup; colors can be read each time).
pub struct PollConfig {
    pub repos_roots: Vec<String>,
    pub org_colors: BTreeMap<String, String>,
    pub poll_sec: f64,
    pub run_marker: Option<String>,
    pub bg_agent_marker: Option<String>,
    /// Text marker for the usage-limit banner (ZK_LIMIT_MARKER; empty/unset falls back to the default).
    pub limit_marker: Option<String>,
}

/// The result of one evaluation (the shape distributed via state.sync; same shape as protocol's StateSync).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StateSnapshot {
    pub sessions: Vec<SessionInfo>,
    pub orgs: Vec<String>,
    pub org_colors: BTreeMap<String, String>,
}

/// The wire SessionState string (protocol.ts's sessionStateSchema).
fn state_wire(state: SessionState) -> &'static str {
    match state {
        SessionState::WaitingInput => "waiting_input",
        SessionState::Running => "running",
        SessionState::RunningBgAgent => "running_bg_agent",
        SessionState::Idle => "idle",
        SessionState::NoClaude => "no_claude",
        SessionState::Starting => "starting",
        SessionState::Unknown => "unknown",
    }
}

/// Resolves the limit marker (empty/unset falls back to the default; same policy as detect_state's resolve).
fn resolve_limit_marker(config: &PollConfig) -> &str {
    match config.limit_marker.as_deref() {
        Some(m) if !m.is_empty() => m,
        _ => DEFAULT_LIMIT_MARKER,
    }
}

/// The last segment of cwd (the repo name). TS `lastPathSegment`.
fn last_path_segment(path: &str) -> &str {
    path.split('/').rfind(|s| !s.is_empty()).unwrap_or(path)
}

/// Determines the capture target pane and sid. The first pane whose process tree contains claude(sid),
/// or the leftmost pane (smallest left) if none. None if there are no panes. TS `pickPane`.
struct Picked {
    pane_id: String,
    cwd: String,
    sid: Option<String>,
    /// The root pid of the picked pane. Used to detect window rebuilds (pid change) from restore/kill.
    pid: i64,
}

fn pick_pane(win: &WorkWindow, maps: &zashiki_core::process_tree::ProcessMaps) -> Option<Picked> {
    let mut leftmost: Option<&WorkWindowPane> = None;
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

/// The server-side state poller (the core evaluation logic). It holds the previous state for pane_in_mode skips
/// and the title cache, keeping them across `evaluate` calls.
#[derive(Default)]
pub struct StatusPoller {
    last: Option<StateSnapshot>,
    /// The previous state of windows whose decision was skipped due to pane_in_mode (copy-mode, etc.).
    prev_states: HashMap<String, SessionState>,
    /// The previous limited of windows whose decision was skipped due to pane_in_mode (carried over because the capture becomes history and cannot be re-decided).
    prev_limited: HashMap<String, bool>,
    /// The consecutive no_claude poll count per window (material for the startup grace decision). Reset to 0 on anything other than no_claude.
    no_claude_streak: HashMap<String, u32>,
    /// The most recent picked pane pid per window. The basis for detecting a window rebuild from restore/kill
    /// (a pid change under the same window_id) and resetting the streak (closes the gap where stale carried-over state disables the grace).
    last_pid: HashMap<String, i64>,
    /// `cwd\0sid` → the first user-utterance title (cached since it is immutable).
    title_cache: HashMap<String, String>,
}

impl StatusPoller {
    pub fn new() -> Self {
        Self::default()
    }

    /// The most recent evaluation result (None if not yet evaluated).
    pub fn snapshot(&self) -> Option<&StateSnapshot> {
        self.last.as_ref()
    }

    /// Evaluates all windows to build a StateSnapshot. The returned bool indicates whether it changed from last time
    /// (equivalent to TS's onSync; the caller broadcasts only when true).
    pub async fn evaluate<P: PollerPorts>(
        &mut self,
        ports: &P,
        config: &PollConfig,
    ) -> (StateSnapshot, bool) {
        let windows = ports.list_work_windows().await;
        let maps = build_process_maps(&parse_ps_snapshot(&ports.ps_snapshot().await));
        // No windows = no session to attribute a shell to, so skip the lsof spawn entirely.
        let shell_outputs = if windows.is_empty() {
            Vec::new()
        } else {
            parse_lsof_fd_outputs(&ports.lsof_fd_outputs().await)
        };

        let mut sessions = Vec::new();
        for win in &windows {
            if let Some(info) = self
                .evaluate_window(win, &maps, &shell_outputs, ports, config)
                .await
            {
                sessions.push(info);
            }
        }

        // Forget the previous state of vanished windows (prevents unbounded map growth).
        let live: std::collections::HashSet<&str> =
            sessions.iter().map(|s| s.window_id.as_str()).collect();
        self.prev_states.retain(|id, _| live.contains(id.as_str()));
        self.prev_limited.retain(|id, _| live.contains(id.as_str()));
        self.no_claude_streak
            .retain(|id, _| live.contains(id.as_str()));
        self.last_pid.retain(|id, _| live.contains(id.as_str()));

        let snapshot = StateSnapshot {
            orgs: build_orgs(&config.repos_roots, &sessions),
            sessions,
            org_colors: config.org_colors.clone(),
        };
        let changed = self.last.as_ref() != Some(&snapshot);
        self.last = Some(snapshot.clone());
        (snapshot, changed)
    }

    async fn evaluate_window<P: PollerPorts>(
        &mut self,
        win: &WorkWindow,
        maps: &zashiki_core::process_tree::ProcessMaps,
        shell_outputs: &[ShellOutput],
        ports: &P,
        config: &PollConfig,
    ) -> Option<SessionInfo> {
        let picked = pick_pane(win, maps)?;
        let cwd = picked.cwd;
        let sid = picked.sid;
        let pid = picked.pid;
        let org = org_of_cwd(&cwd, &roots_ref(&config.repos_roots)).to_string();

        let title_key = sid.as_ref().map(|s| format!("{cwd}\u{0}{s}"));
        let need_slices = title_key
            .as_ref()
            .is_some_and(|k| !self.title_cache.contains_key(k));

        let in_mode = is_pane_in_mode(win, &picked.pane_id);
        let (mut state, limited) = if in_mode {
            (
                self.prev_states
                    .get(&win.window_id)
                    .copied()
                    .unwrap_or(SessionState::Unknown),
                self.prev_limited
                    .get(&win.window_id)
                    .copied()
                    .unwrap_or(false),
            )
        } else {
            let capture = ports.capture_pane(&picked.pane_id).await;
            let state = detect_state(
                &capture,
                &DetectStateOptions {
                    has_claude: sid.is_some(),
                    run_marker: config.run_marker.as_deref(),
                    bg_agent_marker: config.bg_agent_marker.as_deref(),
                },
            );
            let limited = is_limit_reached(&capture, resolve_limit_marker(config));
            (state, limited)
        };

        let mut slices: Option<Slices> = None;
        if let Some(sid) = &sid {
            if state == SessionState::Idle || need_slices {
                slices = ports.read_slices(&cwd, sid).await;
            }
        }
        if state == SessionState::Idle && sid.is_some() {
            let last_ev = slices
                .as_ref()
                .and_then(|s| last_user_or_assistant_event(&s.tail));
            let age = slices.as_ref().map(|s| s.mtime_age_sec);
            state = fallback_state(last_ev.as_ref(), age, config.poll_sec);
        }

        // Startup grace: right after restore/new, claude has not yet appeared in the process tree and looks like
        // no_claude. Count the consecutive polls since no_claude began and fall back to Starting while within the
        // grace. in_mode has no decision (it carries over the previous state), so pass through without touching the streak.
        if !in_mode {
            // A pid change under the same window_id signals that restore/kill rebuilt the window. Discard the
            // carried-over streak (e.g. the previous claude already settled as no_claude) and apply the grace to the rebuilt window.
            let rebuilt = self.last_pid.insert(win.window_id.clone(), pid) != Some(pid);
            if rebuilt {
                self.no_claude_streak.remove(&win.window_id);
            }
            let streak = if state == SessionState::NoClaude {
                let entry = self
                    .no_claude_streak
                    .entry(win.window_id.clone())
                    .or_insert(0);
                *entry += 1;
                *entry
            } else {
                self.no_claude_streak.remove(&win.window_id);
                0
            };
            state = apply_startup_grace(state, streak, startup_grace_polls(config.poll_sec));
        }

        let mut title: Option<String> = None;
        if let Some(key) = &title_key {
            title = self.title_cache.get(key).cloned();
            if title.is_none() {
                if let Some(s) = &slices {
                    if let Some(t) = first_user_title(&s.head, TITLE_MAX_CHARS) {
                        self.title_cache.insert(key.clone(), t.clone());
                        title = Some(t);
                    }
                }
            }
        }

        let mut running_subagents = 0;
        if state == SessionState::RunningBgAgent {
            if let Some(sid) = &sid {
                let ages = ports.subagent_ages(&cwd, sid).await;
                running_subagents =
                    count_running_subagents(&ages, subagent_fresh_within_sec(config.poll_sec));
            }
        }

        // Only sids with a live fd1 output need a transcript read to tell bg from fg; absent that,
        // there is nothing resident (0 shells is omitted, not sent as 0).
        let mut shells_running: Option<u32> = None;
        if let Some(sid) = &sid {
            if shell_outputs.iter().any(|o| &o.sid == sid) {
                let bg_ids = ports.background_task_ids(&cwd, sid).await;
                let n = count_running_shells_for_sid(shell_outputs, sid, &bg_ids);
                if n > 0 {
                    shells_running = Some(n);
                }
            }
        }

        self.prev_states.insert(win.window_id.clone(), state);
        self.prev_limited.insert(win.window_id.clone(), limited);
        Some(SessionInfo {
            window_id: win.window_id.clone(),
            name: win.name.clone(),
            org,
            repo: last_path_segment(&cwd).to_string(),
            state: state_wire(state).to_string(),
            title,
            sid,
            active: win.active,
            running_subagents: Some(running_subagents as u32),
            shells_running,
            limited,
        })
    }
}

/// Whether the picked pane is in_mode such as copy-mode (avoided because the capture becomes history and misjudges).
fn is_pane_in_mode(win: &WorkWindow, pane_id: &str) -> bool {
    win.panes
        .iter()
        .find(|p| p.pane_id == pane_id)
        .is_some_and(|p| p.in_mode)
}

fn roots_ref(roots: &[String]) -> Vec<&str> {
    roots.iter().map(String::as_str).collect()
}

/// All repos.conf orgs plus detected orgs, deduplicated in display order (orgs with 0 sessions are not dropped).
fn build_orgs(repos_roots: &[String], sessions: &[SessionInfo]) -> Vec<String> {
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

    const SID: &str = "0b6cbc45-83a9-4f2e-9c3d-1a2b3c4d5e6f";

    fn pane(pane_id: &str, pid: i64, left: i64, cwd: &str) -> WorkWindowPane {
        WorkWindowPane {
            pane_id: pane_id.to_string(),
            active: true,
            pid,
            left,
            in_mode: false,
            current_path: cwd.to_string(),
        }
    }

    fn window(window_id: &str, name: &str, panes: Vec<WorkWindowPane>) -> WorkWindow {
        WorkWindow {
            window_id: window_id.to_string(),
            name: name.to_string(),
            active: true,
            panes,
        }
    }

    #[derive(Default)]
    struct FakePorts {
        windows: Vec<WorkWindow>,
        ps: String,
        captures: HashMap<String, String>,
        slices: HashMap<String, Slices>,
        subagent_ages: HashMap<String, Vec<f64>>,
        lsof: String,
        bg_task_ids: HashMap<String, HashSet<String>>,
    }

    impl PollerPorts for FakePorts {
        async fn list_work_windows(&self) -> Vec<WorkWindow> {
            self.windows.clone()
        }
        async fn capture_pane(&self, target: &str) -> String {
            self.captures.get(target).cloned().unwrap_or_default()
        }
        async fn ps_snapshot(&self) -> String {
            self.ps.clone()
        }
        async fn read_slices(&self, cwd: &str, sid: &str) -> Option<Slices> {
            self.slices
                .get(&format!("{cwd}\u{0}{sid}"))
                .map(|s| Slices {
                    head: s.head.clone(),
                    tail: s.tail.clone(),
                    mtime_age_sec: s.mtime_age_sec,
                })
        }
        async fn subagent_ages(&self, cwd: &str, sid: &str) -> Vec<f64> {
            self.subagent_ages
                .get(&format!("{cwd}\u{0}{sid}"))
                .cloned()
                .unwrap_or_default()
        }
        async fn lsof_fd_outputs(&self) -> String {
            self.lsof.clone()
        }
        async fn background_task_ids(&self, cwd: &str, sid: &str) -> HashSet<String> {
            self.bg_task_ids
                .get(&format!("{cwd}\u{0}{sid}"))
                .cloned()
                .unwrap_or_default()
        }
    }

    fn config() -> PollConfig {
        PollConfig {
            repos_roots: vec!["/repos/charlie".to_string()],
            org_colors: BTreeMap::new(),
            poll_sec: 2.0,
            run_marker: None,
            bg_agent_marker: None,
            limit_marker: None,
        }
    }

    /// A ps snapshot where pid=300 becomes the claude(sid) pane.
    fn ps_with_claude(pane_pid: i64) -> String {
        format!("  {pane_pid}    1 -zsh\n  300 {pane_pid} claude --session-id {SID}\n")
    }

    const RUN_CAPTURE: &str = "✻ Simmering… (esc to interrupt · ctrl+t)";

    #[tokio::test]
    async fn running_session_maps_to_wire_fields() {
        let ports = FakePorts {
            windows: vec![window(
                "@1",
                "work",
                vec![pane("%1", 100, 0, "/repos/charlie/app")],
            )],
            ps: ps_with_claude(100),
            captures: HashMap::from([("%1".to_string(), RUN_CAPTURE.to_string())]),
            ..Default::default()
        };
        let mut poller = StatusPoller::new();
        let (snap, changed) = poller.evaluate(&ports, &config()).await;
        assert!(changed);
        assert_eq!(snap.sessions.len(), 1);
        let s = &snap.sessions[0];
        assert_eq!(s.window_id, "@1");
        assert_eq!(s.org, "charlie");
        assert_eq!(s.repo, "app");
        assert_eq!(s.state, "running");
        assert!(s.active);
        assert_eq!(s.sid.as_deref(), Some(SID));
        assert_eq!(s.running_subagents, Some(0));
        assert!(!s.limited);
    }

    /// A live fd1 output whose task id is a transcript backgroundTaskId is counted as a resident shell.
    #[tokio::test]
    async fn resident_background_shell_sets_shells_running() {
        let cwd = "/repos/charlie/app";
        let lsof = format!("p900\nf1\nn/private/tmp/x/{SID}/tasks/bgtask123.output\n");
        let ports = FakePorts {
            windows: vec![window("@1", "work", vec![pane("%1", 100, 0, cwd)])],
            ps: ps_with_claude(100),
            captures: HashMap::from([("%1".to_string(), RUN_CAPTURE.to_string())]),
            lsof,
            bg_task_ids: HashMap::from([(
                format!("{cwd}\u{0}{SID}"),
                HashSet::from(["bgtask123".to_string()]),
            )]),
            ..Default::default()
        };
        let mut poller = StatusPoller::new();
        let (snap, _) = poller.evaluate(&ports, &config()).await;
        assert_eq!(snap.sessions[0].shells_running, Some(1));
    }

    /// A live fd1 output whose task id is NOT a backgroundTaskId (a foreground Bash) is excluded; with
    /// nothing resident the field is omitted (None).
    #[tokio::test]
    async fn foreground_shell_fd_is_not_counted() {
        let cwd = "/repos/charlie/app";
        let lsof = format!("p900\nf1\nn/private/tmp/x/{SID}/tasks/fgtask999.output\n");
        let ports = FakePorts {
            windows: vec![window("@1", "work", vec![pane("%1", 100, 0, cwd)])],
            ps: ps_with_claude(100),
            captures: HashMap::from([("%1".to_string(), RUN_CAPTURE.to_string())]),
            lsof,
            ..Default::default()
        };
        let mut poller = StatusPoller::new();
        let (snap, _) = poller.evaluate(&ports, &config()).await;
        assert_eq!(snap.sessions[0].shells_running, None);
    }

    /// A capture containing the limit banner puts limited=true on the wire. Orthogonal to the primary state (running).
    #[tokio::test]
    async fn limit_banner_sets_limited_flag_orthogonal_to_state() {
        let cap = format!("{RUN_CAPTURE}\n✗ Claude usage limit reached · /upgrade");
        let ports = FakePorts {
            windows: vec![window(
                "@1",
                "work",
                vec![pane("%1", 100, 0, "/repos/charlie/app")],
            )],
            ps: ps_with_claude(100),
            captures: HashMap::from([("%1".to_string(), cap)]),
            ..Default::default()
        };
        let mut poller = StatusPoller::new();
        let (snap, _) = poller.evaluate(&ports, &config()).await;
        let s = &snap.sessions[0];
        assert_eq!(s.state, "running");
        assert!(s.limited);
    }

    /// A window with claude absent is starting while within the startup grace and settles to no_claude once the grace is exceeded.
    /// With poll_sec=8, grace_polls=1, so the first poll is starting → the second is no_claude.
    #[tokio::test]
    async fn absent_sid_starts_within_grace_then_settles_no_claude() {
        let ports = FakePorts {
            windows: vec![window(
                "@1",
                "work",
                vec![pane("%1", 100, 0, "/repos/charlie/app")],
            )],
            ps: "  100    1 -zsh\n".to_string(),
            captures: HashMap::from([("%1".to_string(), "just a shell".to_string())]),
            ..Default::default()
        };
        let mut cfg = config();
        cfg.poll_sec = 8.0; // grace_polls = ceil(8/8) = 1
        let mut poller = StatusPoller::new();
        let (snap1, _) = poller.evaluate(&ports, &cfg).await;
        assert_eq!(snap1.sessions[0].state, "starting");
        assert_eq!(snap1.sessions[0].sid, None);
        let (snap2, _) = poller.evaluate(&ports, &cfg).await;
        assert_eq!(snap2.sessions[0].state, "no_claude");
    }

    /// Transition right after restore/kill: the first time a window that just had claude alive (running) loses its
    /// sid, the grace applies and it becomes starting rather than no_claude (a restore rebuilding windows does not
    /// flip them all to no_claude at once). With poll_sec=8, grace_polls=1.
    #[tokio::test]
    async fn alive_window_losing_claude_shows_starting_on_first_poll() {
        let mut cfg = config();
        cfg.poll_sec = 8.0;
        let mut poller = StatusPoller::new();

        // First poll: claude present, so running.
        let ports1 = FakePorts {
            windows: vec![window(
                "@1",
                "work",
                vec![pane("%1", 100, 0, "/repos/charlie/app")],
            )],
            ps: ps_with_claude(100),
            captures: HashMap::from([("%1".to_string(), RUN_CAPTURE.to_string())]),
            ..Default::default()
        };
        let (snap1, _) = poller.evaluate(&ports1, &cfg).await;
        assert_eq!(snap1.sessions[0].state, "running");

        // Second poll: same window but claude disappeared (restore rebuild / kill transition) → the first no_claude is starting.
        let ports2 = FakePorts {
            windows: vec![window(
                "@1",
                "work",
                vec![pane("%1", 100, 0, "/repos/charlie/app")],
            )],
            ps: "  100    1 -zsh\n".to_string(),
            captures: HashMap::from([("%1".to_string(), "just a shell".to_string())]),
            ..Default::default()
        };
        let (snap2, _) = poller.evaluate(&ports2, &cfg).await;
        assert_eq!(snap2.sessions[0].state, "starting");
    }

    /// If restore rebuilds a window that had "already settled as no_claude (streak beyond the grace)" under the same
    /// window_id but a different pid, the carried-over streak is discarded and the grace is reapplied (it returns to starting).
    /// With poll_sec=8, grace_polls=1.
    #[tokio::test]
    async fn rebuilt_window_resets_grace_even_if_prev_settled_no_claude() {
        let mut cfg = config();
        cfg.poll_sec = 8.0;
        let mut poller = StatusPoller::new();

        // Poll the pid=100 window a few times until it settles to no_claude (1: starting → 2: no_claude settled).
        let dead = |pid: i64| FakePorts {
            windows: vec![window(
                "@1",
                "work",
                vec![pane("%1", pid, 0, "/repos/charlie/app")],
            )],
            ps: format!("  {pid}    1 -zsh\n"),
            captures: HashMap::from([("%1".to_string(), "just a shell".to_string())]),
            ..Default::default()
        };
        assert_eq!(
            poller.evaluate(&dead(100), &cfg).await.0.sessions[0].state,
            "starting"
        );
        assert_eq!(
            poller.evaluate(&dead(100), &cfg).await.0.sessions[0].state,
            "no_claude"
        );

        // Same window_id, different pid (= rebuild) with claude not appearing → discard the stale streak and return to starting.
        assert_eq!(
            poller.evaluate(&dead(200), &cfg).await.0.sessions[0].state,
            "starting"
        );
    }

    #[tokio::test]
    async fn bg_agent_counts_running_subagents() {
        let cap = "  ⏺ main\n  ◯ general-purpose  作業  1s\n  ◯ Explore  調査  2s";
        let ports = FakePorts {
            windows: vec![window(
                "@1",
                "work",
                vec![pane("%1", 100, 0, "/repos/charlie/app")],
            )],
            ps: ps_with_claude(100),
            captures: HashMap::from([("%1".to_string(), cap.to_string())]),
            subagent_ages: HashMap::from([(
                format!("/repos/charlie/app\u{0}{SID}"),
                vec![1.0, 5.0, 100.0],
            )]),
            ..Default::default()
        };
        let mut poller = StatusPoller::new();
        let (snap, _) = poller.evaluate(&ports, &config()).await;
        assert_eq!(snap.sessions[0].state, "running_bg_agent");
        // Within the 30s freshness threshold there are 2 (1.0/5.0); 100.0 is past freshness.
        assert_eq!(snap.sessions[0].running_subagents, Some(2));
    }

    #[tokio::test]
    async fn idle_falls_back_to_running_on_fresh_user_event() {
        let user_tail = r#"{"type":"user","message":{"content":"作業して"}}"#;
        let ports = FakePorts {
            windows: vec![window(
                "@1",
                "work",
                vec![pane("%1", 100, 0, "/repos/charlie/app")],
            )],
            ps: ps_with_claude(100),
            captures: HashMap::from([("%1".to_string(), "空の待機画面".to_string())]),
            slices: HashMap::from([(
                format!("/repos/charlie/app\u{0}{SID}"),
                Slices {
                    head: user_tail.to_string(),
                    tail: user_tail.to_string(),
                    mtime_age_sec: 1.0,
                },
            )]),
            ..Default::default()
        };
        let mut poller = StatusPoller::new();
        let (snap, _) = poller.evaluate(&ports, &config()).await;
        assert_eq!(snap.sessions[0].state, "running");
    }

    #[tokio::test]
    async fn idle_stays_idle_when_event_is_stale() {
        let user_tail = r#"{"type":"user","message":{"content":"作業して"}}"#;
        let ports = FakePorts {
            windows: vec![window(
                "@1",
                "work",
                vec![pane("%1", 100, 0, "/repos/charlie/app")],
            )],
            ps: ps_with_claude(100),
            captures: HashMap::from([("%1".to_string(), "空の待機画面".to_string())]),
            slices: HashMap::from([(
                format!("/repos/charlie/app\u{0}{SID}"),
                Slices {
                    head: user_tail.to_string(),
                    tail: user_tail.to_string(),
                    mtime_age_sec: 999.0,
                },
            )]),
            ..Default::default()
        };
        let mut poller = StatusPoller::new();
        let (snap, _) = poller.evaluate(&ports, &config()).await;
        assert_eq!(snap.sessions[0].state, "idle");
    }

    #[tokio::test]
    async fn title_is_taken_from_first_user_and_cached() {
        let head = r#"{"type":"user","message":{"content":"最初の依頼だよ"}}"#;
        let ports = FakePorts {
            windows: vec![window(
                "@1",
                "work",
                vec![pane("%1", 100, 0, "/repos/charlie/app")],
            )],
            ps: ps_with_claude(100),
            captures: HashMap::from([("%1".to_string(), RUN_CAPTURE.to_string())]),
            slices: HashMap::from([(
                format!("/repos/charlie/app\u{0}{SID}"),
                Slices {
                    head: head.to_string(),
                    tail: String::new(),
                    mtime_age_sec: 1.0,
                },
            )]),
            ..Default::default()
        };
        let mut poller = StatusPoller::new();
        let (snap, _) = poller.evaluate(&ports, &config()).await;
        assert_eq!(snap.sessions[0].title.as_deref(), Some("最初の依頼だよ"));
        assert!(poller
            .title_cache
            .contains_key(&format!("/repos/charlie/app\u{0}{SID}")));
    }

    #[tokio::test]
    async fn pane_in_mode_carries_over_previous_state() {
        // First poll: settle to running via the normal decision and record it in prev_states.
        let mut win = window("@1", "work", vec![pane("%1", 100, 0, "/repos/charlie/app")]);
        let ports1 = FakePorts {
            windows: vec![win.clone()],
            ps: ps_with_claude(100),
            captures: HashMap::from([("%1".to_string(), RUN_CAPTURE.to_string())]),
            ..Default::default()
        };
        let mut poller = StatusPoller::new();
        let (snap1, _) = poller.evaluate(&ports1, &config()).await;
        assert_eq!(snap1.sessions[0].state, "running");

        // Second poll: even in_mode (capture is an empty string that looks idle), keep the previous running.
        win.panes[0].in_mode = true;
        let ports2 = FakePorts {
            windows: vec![win],
            ps: ps_with_claude(100),
            captures: HashMap::new(),
            ..Default::default()
        };
        let (snap2, _) = poller.evaluate(&ports2, &config()).await;
        assert_eq!(snap2.sessions[0].state, "running");
    }

    #[tokio::test]
    async fn unchanged_evaluation_reports_not_changed() {
        let ports = FakePorts {
            windows: vec![window(
                "@1",
                "work",
                vec![pane("%1", 100, 0, "/repos/charlie/app")],
            )],
            ps: ps_with_claude(100),
            captures: HashMap::from([("%1".to_string(), RUN_CAPTURE.to_string())]),
            ..Default::default()
        };
        let mut poller = StatusPoller::new();
        let (_, changed1) = poller.evaluate(&ports, &config()).await;
        let (_, changed2) = poller.evaluate(&ports, &config()).await;
        assert!(changed1);
        assert!(!changed2);
    }

    #[tokio::test]
    async fn orgs_include_repos_roots_and_dedup_session_orgs() {
        let mut cfg = config();
        cfg.repos_roots = vec!["/repos/charlie".to_string(), "/repos/whiskey".to_string()];
        let ports = FakePorts {
            windows: vec![window(
                "@1",
                "work",
                vec![pane("%1", 100, 0, "/repos/charlie/app")],
            )],
            ps: ps_with_claude(100),
            captures: HashMap::from([("%1".to_string(), RUN_CAPTURE.to_string())]),
            ..Default::default()
        };
        let mut poller = StatusPoller::new();
        let (snap, _) = poller.evaluate(&ports, &cfg).await;
        // repos.conf order (charlie, whiskey). The session's charlie is not added again.
        assert_eq!(snap.orgs, vec!["charlie".to_string(), "whiskey".to_string()]);
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

    #[tokio::test]
    async fn window_without_panes_is_skipped() {
        let ports = FakePorts {
            windows: vec![window("@1", "work", vec![])],
            ps: String::new(),
            ..Default::default()
        };
        let mut poller = StatusPoller::new();
        let (snap, _) = poller.evaluate(&ports, &config()).await;
        assert!(snap.sessions.is_empty());
    }

    #[tokio::test]
    async fn sessions_preserve_window_input_order() {
        let ports = FakePorts {
            windows: vec![
                window("@1", "one", vec![pane("%1", 100, 0, "/repos/charlie/a")]),
                window("@2", "two", vec![pane("%2", 200, 0, "/repos/charlie/b")]),
            ],
            ps: "  100    1 -zsh\n  200    1 -zsh\n".to_string(),
            ..Default::default()
        };
        let mut poller = StatusPoller::new();
        let (snap, _) = poller.evaluate(&ports, &config()).await;
        let ids: Vec<&str> = snap.sessions.iter().map(|s| s.window_id.as_str()).collect();
        assert_eq!(ids, vec!["@1", "@2"]);
    }

    #[tokio::test]
    async fn prev_states_are_pruned_when_window_disappears() {
        let ports1 = FakePorts {
            windows: vec![window(
                "@1",
                "work",
                vec![pane("%1", 100, 0, "/repos/charlie/app")],
            )],
            ps: ps_with_claude(100),
            captures: HashMap::from([("%1".to_string(), RUN_CAPTURE.to_string())]),
            ..Default::default()
        };
        let mut poller = StatusPoller::new();
        poller.evaluate(&ports1, &config()).await;
        assert!(poller.prev_states.contains_key("@1"));

        // On the next evaluation after @1 disappears, the previous state is forgotten too (prevents unbounded map growth).
        let ports2 = FakePorts {
            windows: vec![],
            ps: String::new(),
            ..Default::default()
        };
        poller.evaluate(&ports2, &config()).await;
        assert!(poller.prev_states.is_empty());
    }

    #[tokio::test]
    async fn cached_title_survives_without_rereading_slices() {
        let head = r#"{"type":"user","message":{"content":"最初の依頼"}}"#;
        let key = format!("/repos/charlie/app\u{0}{SID}");
        let ports1 = FakePorts {
            windows: vec![window(
                "@1",
                "work",
                vec![pane("%1", 100, 0, "/repos/charlie/app")],
            )],
            ps: ps_with_claude(100),
            captures: HashMap::from([("%1".to_string(), RUN_CAPTURE.to_string())]),
            slices: HashMap::from([(
                key.clone(),
                Slices {
                    head: head.to_string(),
                    tail: String::new(),
                    mtime_age_sec: 1.0,
                },
            )]),
            ..Default::default()
        };
        let mut poller = StatusPoller::new();
        let (snap1, _) = poller.evaluate(&ports1, &config()).await;
        assert_eq!(snap1.sessions[0].title.as_deref(), Some("最初の依頼"));

        // The second poll provides no slices at all (read_slices returns None even if called), but because it is
        // running and the cache hits, title keeps its previous value.
        let ports2 = FakePorts {
            windows: vec![window(
                "@1",
                "work",
                vec![pane("%1", 100, 0, "/repos/charlie/app")],
            )],
            ps: ps_with_claude(100),
            captures: HashMap::from([("%1".to_string(), RUN_CAPTURE.to_string())]),
            ..Default::default()
        };
        let (snap2, _) = poller.evaluate(&ports2, &config()).await;
        assert_eq!(snap2.sessions[0].title.as_deref(), Some("最初の依頼"));
    }
}
