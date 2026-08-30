//! Timer-driven loop for `StatusPoller`.
//! Evaluates periodically and publishes to the ControlHub only when the state changed since the
//! previous tick, pushing `state.sync` to each connection. The client never polls; the server is the
//! sole observer.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::control::{ControlHub, RefreshRequest};
use crate::hooks::NotifyEvent;
use crate::repos::SharedRepos;
use crate::status_poller::{
    detect_activity_transitions, PollConfig, PollerPorts, StateSnapshot, StatusPoller,
};

/// Deliver Background Activity transitions: record each into the ACTIVITY view (gated by the same
/// per-category switch as delivery, so a disabled category leaves no trace) and fire its push /
/// macOS notification. Mirrors the hook path (`routes_hooks`), which records and notifies together;
/// without the record, subagent/shell edges would surface only as a transient toast and never enter
/// the ACTIVITY view. One `now_ms` for the batch is fine — `record_activity` keeps createdAt monotonic.
fn deliver_transitions(hub: &ControlHub, events: Vec<NotifyEvent>, now_ms: u64) {
    for event in events {
        if hub.notification_settings().delivers(event.kind) {
            hub.record_activity(
                uuid::Uuid::new_v4().to_string(),
                event.kind,
                event.cockpit_terminal_id.clone(),
                &event.name,
                now_ms,
            );
        }
        hub.notify(event);
    }
}

/// Refresh the reloadable fields (repos roots + org colors) from the shared handle before each
/// evaluation, so a live repos.conf change (add / external edit) reflects without a restart.
/// The read guard is dropped immediately (never held across the following await).
fn sync_repos(config: &mut PollConfig, repos: &SharedRepos) {
    if let Ok(guard) = repos.read() {
        config.repos_roots = guard.roots.clone();
        config.org_colors = guard.colors.clone();
        config.org_aliases = guard.aliases.clone();
    }
}

/// Evaluate one cycle. Publishes to the hub only when the state changed, and returns the snapshot.
async fn evaluate_and_publish<P: PollerPorts>(
    poller: &mut StatusPoller,
    ports: &P,
    config: &PollConfig,
    hub: &ControlHub,
) -> StateSnapshot {
    let prev = poller.snapshot().cloned();
    let (snapshot, changed) = poller.evaluate(ports, config).await;
    if changed {
        hub.publish_snapshot(snapshot.clone());
    }
    if let Some(prev) = prev {
        deliver_transitions(hub, detect_activity_transitions(&prev, &snapshot), crate::now_ms());
    }
    snapshot
}

/// Start the poller as a long-running task. `interval` ticks immediately on the first cycle (one
/// evaluation at startup). Uses `MissedTickBehavior::Skip` to avoid pile-ups. `refresh_rx` carries
/// immediate re-evaluation requests (originating from term.select and session.*); if `reply` is
/// present, the post-evaluation snapshot is returned, guaranteeing a response to state.refresh.
pub fn spawn_poller<P: PollerPorts + Send + Sync + 'static>(
    ports: P,
    mut config: PollConfig,
    repos: SharedRepos,
    hub: Arc<ControlHub>,
    mut refresh_rx: mpsc::Receiver<RefreshRequest>,
) -> JoinHandle<()> {
    let poll_sec = if config.poll_sec.is_finite() && config.poll_sec > 0.0 {
        config.poll_sec
    } else {
        2.0
    };
    tokio::spawn(async move {
        let mut poller = StatusPoller::new();
        let mut interval = tokio::time::interval(Duration::from_secs_f64(poll_sec));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = interval.tick() => {
                    sync_repos(&mut config, &repos);
                    evaluate_and_publish(&mut poller, &ports, &config, &hub).await;
                }
                Some(req) = refresh_rx.recv() => {
                    sync_repos(&mut config, &repos);
                    let snapshot = evaluate_and_publish(&mut poller, &ports, &config, &hub).await;
                    if let Some(reply) = req.reply {
                        let _ = reply.send(snapshot);
                    }
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control::ConfigView;
    use crate::protocol::ServerMessage;
    use crate::status_poller::{Slices, StateSnapshot, CockpitTerminal, CockpitTerminalPane};
    use std::collections::BTreeMap;

    const SID: &str = "0b6cbc45-83a9-4f2e-9c3d-1a2b3c4d5e6f";
    const RUN_CAPTURE: &str = "✻ Simmering… (esc to interrupt · ctrl+t)";

    struct FakePorts {
        windows: Vec<CockpitTerminal>,
        ps: String,
        capture: String,
    }

    impl PollerPorts for FakePorts {
        async fn list_work_windows(&self) -> Vec<CockpitTerminal> {
            self.windows.clone()
        }
        async fn capture_pane(&self, _target: &str) -> String {
            self.capture.clone()
        }
        async fn ps_snapshot(&self) -> String {
            self.ps.clone()
        }
        async fn read_slices(&self, _cwd: &str, _sid: &str) -> Option<Slices> {
            None
        }
        async fn subagent_ages(&self, _cwd: &str, _sid: &str) -> Vec<f64> {
            Vec::new()
        }
        async fn lsof_fd_outputs(&self) -> String {
            String::new()
        }
        async fn background_task_ids(
            &self,
            _cwd: &str,
            _sid: &str,
        ) -> std::collections::HashSet<String> {
            std::collections::HashSet::new()
        }
    }

    fn one_running_window() -> FakePorts {
        FakePorts {
            windows: vec![CockpitTerminal {
                cockpit_terminal_id: "@1".to_string(),
                name: "work".to_string(),
                active: true,
                panes: vec![CockpitTerminalPane {
                    pane_id: "%1".to_string(),
                    active: true,
                    pid: 100,
                    left: 0,
                    in_mode: false,
                    current_path: "/repos/charlie/app".to_string(),
                }],
            }],
            ps: format!("  100    1 -zsh\n  300  100 claude --session-id {SID}\n"),
            capture: RUN_CAPTURE.to_string(),
        }
    }

    fn config() -> PollConfig {
        PollConfig {
            repos_roots: vec!["/repos/charlie".to_string()],
            org_colors: BTreeMap::new(),
            org_aliases: BTreeMap::new(),
            poll_sec: 2.0,
            run_marker: None,
            bg_agent_marker: None,
            limit_marker: None,
            menu_markers: None,
        }
    }

    fn empty_snapshot() -> StateSnapshot {
        StateSnapshot {
            sessions: vec![],
            orgs: vec![],
            org_colors: BTreeMap::new(),
            org_aliases: BTreeMap::new(),
        }
    }

    #[tokio::test]
    async fn tick_publishes_only_when_changed() {
        let ports = one_running_window();
        let hub = ControlHub::new(ConfigView::default(), vec![], empty_snapshot());
        let mut rx = hub.subscribe();
        let mut poller = StatusPoller::new();

        // First cycle has no previous state -> changed -> publishes state.sync.
        evaluate_and_publish(&mut poller, &ports, &config(), &hub).await;
        match rx.try_recv().expect("state.sync on first change") {
            ServerMessage::StateSync { cockpit_terminals: sessions, .. } => {
                assert_eq!(sessions[0].cockpit_terminal_id, "@1");
                assert_eq!(sessions[0].state, "running");
            }
            other => panic!("expected state.sync, got {other:?}"),
        }

        // Second cycle is identical -> no change -> does not publish.
        evaluate_and_publish(&mut poller, &ports, &config(), &hub).await;
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn spawn_poller_publishes_initial_snapshot() {
        let hub = ControlHub::new(ConfigView::default(), vec![], empty_snapshot());
        let mut rx = hub.subscribe();
        let (_refresh_tx, refresh_rx) = mpsc::channel(8);
        let repos =
            crate::repos::shared_repos(vec!["/repos/charlie".to_string()], Default::default(), Default::default());
        let handle = spawn_poller(one_running_window(), config(), repos, hub, refresh_rx);
        // The immediate tick right after startup publishes the first evaluation.
        let msg = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("poller should publish within timeout")
            .expect("broadcast open");
        assert!(matches!(msg, ServerMessage::StateSync { .. }));
        handle.abort();
    }

    #[tokio::test]
    async fn refresh_request_triggers_evaluation_and_replies() {
        let hub = ControlHub::new(ConfigView::default(), vec![], empty_snapshot());
        let (refresh_tx, refresh_rx) = mpsc::channel(8);
        let repos =
            crate::repos::shared_repos(vec!["/repos/charlie".to_string()], Default::default(), Default::default());
        let handle = spawn_poller(one_running_window(), config(), repos, hub, refresh_rx);

        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        refresh_tx
            .send(RefreshRequest {
                reply: Some(reply_tx),
            })
            .await
            .unwrap();
        let snapshot = tokio::time::timeout(Duration::from_secs(5), reply_rx)
            .await
            .expect("reply within timeout")
            .expect("reply channel open");
        assert_eq!(snapshot.sessions[0].cockpit_terminal_id, "@1");
        handle.abort();
    }

    use crate::protocol::{
        NotificationSettings, NotifyCategories, NotifyCategoryPref, NotifyKind, SoundPreset,
    };
    use tokio::sync::broadcast;

    fn on() -> NotifyCategoryPref {
        NotifyCategoryPref { notify: true, sound: false, sound_type: SoundPreset::Ping }
    }

    fn settings_with_subagent_start(enabled: bool, pref: NotifyCategoryPref) -> NotificationSettings {
        NotificationSettings {
            enabled,
            categories: NotifyCategories { subagent_start: pref, ..Default::default() },
        }
    }

    fn hub_with(settings: NotificationSettings) -> Arc<ControlHub> {
        ControlHub::new(
            ConfigView { notifications: settings, ..Default::default() },
            vec![],
            empty_snapshot(),
        )
    }

    fn subagent_start_event() -> NotifyEvent {
        NotifyEvent {
            kind: NotifyKind::SubagentStart,
            cockpit_terminal_id: "@1".to_string(),
            name: "work".to_string(),
            session_title: "題名".to_string(),
        }
    }

    fn next_notifications(rx: &mut broadcast::Receiver<ServerMessage>) -> Option<Vec<crate::protocol::Notification>> {
        std::iter::from_fn(|| rx.try_recv().ok()).find_map(|m| match m {
            ServerMessage::NotificationsSync { items } => Some(items),
            _ => None,
        })
    }

    #[test]
    fn transition_records_into_activity_view_when_category_on() {
        let hub = hub_with(settings_with_subagent_start(true, on()));
        let mut rx = hub.subscribe();
        deliver_transitions(&hub, vec![subagent_start_event()], 1000);
        let items = next_notifications(&mut rx).expect("notifications.sync recorded");
        assert_eq!(items.len(), 1);
        // The Cockpit Terminal reference is what classifies the entry as ACTIVITY (isActivityNotification).
        assert_eq!(items[0].cockpit_terminal_id.as_deref(), Some("@1"));
        assert!(items[0].title.contains("サブエージェント開始"));
    }

    #[test]
    fn transition_leaves_no_activity_when_category_off() {
        let hub = hub_with(settings_with_subagent_start(
            true,
            NotifyCategoryPref { notify: false, sound: false, sound_type: SoundPreset::Ping },
        ));
        let mut rx = hub.subscribe();
        deliver_transitions(&hub, vec![subagent_start_event()], 1000);
        assert!(next_notifications(&mut rx).is_none());
    }

    #[test]
    fn transition_leaves_no_activity_when_master_off() {
        let hub = hub_with(settings_with_subagent_start(false, on()));
        let mut rx = hub.subscribe();
        deliver_transitions(&hub, vec![subagent_start_event()], 1000);
        assert!(next_notifications(&mut rx).is_none());
    }
}
