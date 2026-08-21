//! PTY-owning implementation of `PollerPorts` (part of removing tmux).
//!
//! Supplies the headless vt100-reconstructed screen of the server-owned [`PtySession`]
//! ([`PtySession::screen_contents`]) as the capture screen. The detection logic
//! ([`crate::status_poller`]) does not depend on this module; this module only implements
//! `PollerPorts`.
//!
//! One session = one window = one pane (matching the flat map in [`crate::session_registry`]; there
//! is no multiplexing for grouped sessions). The ps / jsonl paths are delegated to the same adapters
//! as the tmux version (process tree, title, and subagent counting do not depend on the supplier, so
//! they are shared). Not yet wired into the runtime (WS routes / poller loop); non-breaking. The
//! source of truth for behavior is the `tests` at the end of this file.

use std::sync::Arc;

use std::collections::HashSet;

use crate::app_state::now_ms;
use crate::claude_projects::ClaudeProjectsAdapter;
use crate::hook_event_store::HookEventStore;
use crate::lsof::LsofAdapter;
use crate::poller_types::HookEventAge;
use crate::ps::PsAdapter;
use crate::session_registry::SessionRegistry;
use crate::status_poller::{PollerPorts, Slices, CockpitTerminal, CockpitTerminalPane};

/// PTY-owning implementation of `PollerPorts`. The capture screen comes from each [`PtySession`] in
/// the [`SessionRegistry`], and ps / lsof / jsonl are delegated to the same adapters as the tmux version.
pub struct PtyPollerPorts {
    registry: Arc<SessionRegistry>,
    ps: PsAdapter,
    lsof: LsofAdapter,
    projects: ClaudeProjectsAdapter,
    hook_events: Arc<HookEventStore>,
}

impl PtyPollerPorts {
    pub fn new(
        registry: Arc<SessionRegistry>,
        projects: ClaudeProjectsAdapter,
        hook_events: Arc<HookEventStore>,
    ) -> Self {
        Self {
            registry,
            ps: PsAdapter,
            lsof: LsofAdapter,
            projects,
            hook_events,
        }
    }
}

/// Maps each session in the registry to a [`CockpitTerminal`] of one window = one pane (the owned window
/// listing). The pane's pid is the session's child PID, and current_path is the cwd metadata held by
/// the registry. The tmux-specific active / left / in_mode fields are fixed because there is a single
/// pane (the PTY version has no copy-mode concept). Shared by the poller and by the owned resolution
/// of hooks (the replacement supplier for the tmux version's `list_work_windows`).
pub async fn owned_work_windows(registry: &SessionRegistry) -> Vec<CockpitTerminal> {
    registry
        .entries()
        .await
        .into_iter()
        .map(|(id, session, meta)| CockpitTerminal {
            cockpit_terminal_id: id.clone(),
            name: meta.wname,
            active: true,
            panes: vec![CockpitTerminalPane {
                pane_id: id,
                active: true,
                pid: session.pid() as i64,
                left: 0,
                in_mode: false,
                current_path: meta.cwd,
            }],
        })
        .collect()
}

impl PollerPorts for PtyPollerPorts {
    async fn list_work_windows(&self) -> Vec<CockpitTerminal> {
        owned_work_windows(&self.registry).await
    }

    /// The headless reconstructed screen for pane_id (= session id). Returns an empty string if not
    /// registered (like the tmux version, failures collapse to empty so the poller is not stopped).
    async fn capture_pane(&self, target: &str) -> String {
        self.registry
            .get(target)
            .await
            .map(|s| s.screen_contents())
            .unwrap_or_default()
    }

    async fn ps_snapshot(&self) -> String {
        self.ps.snapshot().await
    }

    async fn read_slices(&self, cwd: &str, sid: &str) -> Option<Slices> {
        self.projects.read_slices(cwd, sid).await
    }

    async fn subagent_ages(&self, cwd: &str, sid: &str) -> Vec<f64> {
        self.projects.subagent_ages(cwd, sid).await
    }

    async fn lsof_fd_outputs(&self) -> String {
        self.lsof.fd1_outputs().await
    }

    async fn background_task_ids(&self, cwd: &str, sid: &str) -> HashSet<String> {
        self.projects.background_task_ids(cwd, sid).await
    }

    async fn session_usage(
        &self,
        cwd: &str,
        sid: &str,
    ) -> Option<crate::jsonl::SessionUsageData> {
        self.projects.session_usage(cwd, sid).await
    }

    async fn last_hook_event(&self, sid: &str) -> Option<HookEventAge> {
        self.hook_events.get(sid, now_ms())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty_host::{PtyConfig, PtySession};
    use crate::session_registry::SessionMeta;
    use portable_pty::CommandBuilder;
    use std::time::Duration;
    use zashiki_core::session_state::{detect_state, DetectStateOptions, CockpitTerminalState};

    fn sh(script: &str) -> PtyConfig {
        let mut cmd = CommandBuilder::new("sh");
        cmd.arg("-c");
        cmd.arg(script);
        cmd.env("TERM", "xterm-256color");
        PtyConfig::new(cmd)
    }

    /// Spawns a session running `script` into the registry with cwd metadata.
    async fn spawn_session(
        registry: &SessionRegistry,
        id: &str,
        cwd: &str,
        script: &str,
    ) -> Arc<PtySession> {
        registry
            .create_with_meta(
                id,
                sh(script),
                SessionMeta {
                    cwd: cwd.to_string(),
                    wname: id.to_string(),
                },
            )
            .await
            .unwrap()
    }

    /// Waits until capture_pane contains `needle` (or times out), deterministically observing the
    /// reader thread applying output to the screen.
    async fn wait_capture_contains(
        ports: &PtyPollerPorts,
        pane_id: &str,
        needle: &str,
        timeout_ms: u64,
    ) -> String {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            let cap = ports.capture_pane(pane_id).await;
            if cap.contains(needle) || tokio::time::Instant::now() >= deadline {
                return cap;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    fn opts(has_claude: bool) -> DetectStateOptions<'static> {
        DetectStateOptions {
            has_claude,
            run_marker: None,
            bg_agent_marker: None,
        }
    }

    /// capture_pane (PTY screen supply) -> detect_state can determine running (the replacement for
    /// tmux capture).
    #[cfg(unix)]
    #[tokio::test]
    async fn capture_pane_feeds_running_marker_to_state_detection() {
        let registry = SessionRegistry::new();
        spawn_session(
            &registry,
            "%run",
            "/repos/org/app",
            "printf 'working (esc to interrupt)\\n'; sleep 5",
        )
        .await;
        let ports = PtyPollerPorts::new(
            Arc::new(registry),
            throwaway_projects(),
            Arc::new(HookEventStore::new()),
        );

        let cap = wait_capture_contains(&ports, "%run", "esc to interrupt", 2000).await;
        assert!(cap.contains("esc to interrupt"), "capture missing: {cap:?}");
        assert_eq!(detect_state(&cap, &opts(true)), CockpitTerminalState::Running);

        ports.registry.remove("%run").await;
    }

    /// A numbered wizard screen is supplied and detected as waiting_input.
    #[cfg(unix)]
    #[tokio::test]
    async fn capture_pane_feeds_wizard_as_waiting_input() {
        let registry = SessionRegistry::new();
        spawn_session(
            &registry,
            "%wiz",
            "/repos/org/app",
            "printf '\u{276f} 1. yes\\n  2. no\\n'; sleep 5",
        )
        .await;
        let ports = PtyPollerPorts::new(
            Arc::new(registry),
            throwaway_projects(),
            Arc::new(HookEventStore::new()),
        );

        let cap = wait_capture_contains(&ports, "%wiz", "2. no", 2000).await;
        assert_eq!(detect_state(&cap, &opts(true)), CockpitTerminalState::WaitingInput);

        ports.registry.remove("%wiz").await;
    }

    /// A plain screen with no cues is idle when claude is present and no_claude when absent (i.e. the
    /// detection is unchanged after switching the supplier).
    #[cfg(unix)]
    #[tokio::test]
    async fn capture_pane_feeds_plain_screen_as_idle_or_no_claude() {
        let registry = SessionRegistry::new();
        spawn_session(&registry, "%idle", "/repos/org/app", "printf 'ready> \\n'; sleep 5").await;
        let ports = PtyPollerPorts::new(
            Arc::new(registry),
            throwaway_projects(),
            Arc::new(HookEventStore::new()),
        );

        let cap = wait_capture_contains(&ports, "%idle", "ready>", 2000).await;
        assert_eq!(detect_state(&cap, &opts(true)), CockpitTerminalState::Idle);
        assert_eq!(detect_state(&cap, &opts(false)), CockpitTerminalState::NoClaude);

        ports.registry.remove("%idle").await;
    }

    /// list_work_windows correctly maps one session = one window = one pane with pid / current_path /
    /// name.
    #[cfg(unix)]
    #[tokio::test]
    async fn list_work_windows_maps_sessions_to_single_pane_windows() {
        let registry = SessionRegistry::new();
        let s = spawn_session(&registry, "%1", "/repos/charlie/app", "sleep 5").await;
        let expected_pid = s.pid() as i64;
        let ports = PtyPollerPorts::new(
            Arc::new(registry),
            throwaway_projects(),
            Arc::new(HookEventStore::new()),
        );

        let windows = ports.list_work_windows().await;
        assert_eq!(windows.len(), 1);
        let win = &windows[0];
        assert_eq!(win.cockpit_terminal_id, "%1");
        assert_eq!(win.name, "%1");
        assert!(win.active);
        assert_eq!(win.panes.len(), 1);
        let pane = &win.panes[0];
        assert_eq!(pane.pane_id, "%1");
        assert_eq!(pane.pid, expected_pid);
        assert_eq!(pane.current_path, "/repos/charlie/app");
        assert_eq!(pane.left, 0);
        assert!(pane.active);
        assert!(!pane.in_mode);

        ports.registry.remove("%1").await;
    }

    /// Since entries are in ascending id order, windows are also ordered by ascending id (multiple
    /// sessions).
    #[cfg(unix)]
    #[tokio::test]
    async fn list_work_windows_orders_windows_by_session_id() {
        let registry = SessionRegistry::new();
        spawn_session(&registry, "%b", "/repos/org/b", "sleep 5").await;
        spawn_session(&registry, "%a", "/repos/org/a", "sleep 5").await;
        let ports = PtyPollerPorts::new(
            Arc::new(registry),
            throwaway_projects(),
            Arc::new(HookEventStore::new()),
        );

        let ids: Vec<String> = ports
            .list_work_windows()
            .await
            .into_iter()
            .map(|w| w.cockpit_terminal_id)
            .collect();
        assert_eq!(ids, vec!["%a".to_string(), "%b".to_string()]);

        ports.registry.remove("%a").await;
        ports.registry.remove("%b").await;
    }

    /// For an unregistered pane / empty registry, capture_pane safely returns an empty string (no
    /// panic).
    #[tokio::test]
    async fn capture_pane_of_unknown_pane_is_empty() {
        let registry = SessionRegistry::new();
        let ports = PtyPollerPorts::new(
            Arc::new(registry),
            throwaway_projects(),
            Arc::new(HookEventStore::new()),
        );
        assert_eq!(ports.capture_pane("%missing").await, "");
        assert!(ports.list_work_windows().await.is_empty());
    }

    /// The ps / jsonl delegation reaches the real adapters (a shared path independent of the screen
    /// supplier).
    #[tokio::test]
    async fn ps_and_projects_delegate_to_real_adapters() {
        let tmp = tempfile::tempdir().unwrap();
        const CWD: &str = "/Users/test/workspace/org/repo";
        const PROJ_DIR: &str = "-Users-test-workspace-org-repo";
        const SID: &str = "0b6cbc45-83a9-4f2e-9c3d-1a2b3c4d5e6f";
        let dir = tmp.path().join(PROJ_DIR);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(format!("{SID}.jsonl")),
            "{\"type\":\"user\",\"message\":{\"content\":\"依頼\"}}\n",
        )
        .unwrap();
        let sub = dir.join(SID).join("subagents");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("agent-x.jsonl"), "{}\n").unwrap();

        let registry = SessionRegistry::new();
        let ports = PtyPollerPorts::new(
            Arc::new(registry),
            ClaudeProjectsAdapter::new(tmp.path().to_path_buf()),
            Arc::new(HookEventStore::new()),
        );

        assert!(!ports.ps_snapshot().await.is_empty());
        let slices = ports.read_slices(CWD, SID).await.unwrap();
        assert!(slices.head.contains("依頼"));
        assert_eq!(ports.subagent_ages(CWD, SID).await.len(), 1);
    }

    /// An empty projects adapter for tests (slices/subagent are absent = None/empty; used for
    /// capture-detection verification).
    fn throwaway_projects() -> ClaudeProjectsAdapter {
        ClaudeProjectsAdapter::new(std::env::temp_dir().join(format!(
            "zk-poller-pty-test-{}",
            std::process::id()
        )))
    }
}
