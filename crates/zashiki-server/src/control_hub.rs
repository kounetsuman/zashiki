use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, RwLock};

use tokio::sync::broadcast;

use crate::claude_settings::RegistrationStatus;
use crate::control::ConfigView;
use crate::protocol::{Notification, ServerMessage, CockpitTerminalInfo, UsageLimits};
use crate::status_poller::StateSnapshot;

struct HubState {
    config: ConfigView,
    notifications: Vec<Notification>,
    snapshot: StateSnapshot,
    /// Per-org notes (org → Markdown), delivered on connect and re-broadcast on any note change.
    notes: BTreeMap<String, String>,
    /// Presence of zashiki's integration in ~/.claude/settings.json, delivered on connect and after
    /// register/unregister. Defaults to "not registered" until the startup probe (runtime) sets it.
    hooks_status: RegistrationStatus,
    /// The createdAt of the last enqueued notification. Kept monotonically increasing so
    /// occurrence order is preserved even for bursts within the same millisecond.
    last_notification_at: u64,
    /// Account usage limits reported by the statusLine bridge, keyed by sid. Merged into each
    /// snapshot's matching session before broadcast (the transcript can't carry rate_limits).
    rate_limits: HashMap<String, RateLimitEntry>,
}

/// A bridge-reported usage-limit reading with its arrival time (for TTL pruning).
struct RateLimitEntry {
    limits: UsageLimits,
    updated_at_ms: u64,
}

/// Drop bridge readings older than this so a long-idle sid's stale percentages don't linger.
const RATE_LIMIT_TTL_MS: u64 = 30 * 60 * 1000;

/// Attaches each session's bridge-reported limits (matched by sid) onto its footer usage. Sessions
/// without transcript usage yet, or without a stored reading, are left untouched.
fn merge_rate_limits(sessions: &mut [CockpitTerminalInfo], store: &HashMap<String, RateLimitEntry>) {
    for session in sessions.iter_mut() {
        let Some(sid) = session.sid.as_deref() else {
            continue;
        };
        if let (Some(entry), Some(usage)) = (store.get(sid), session.usage.as_mut()) {
            usage.limits = Some(entry.limits);
        }
    }
}

/// The shared state + broadcast that all control connections refer to. When the poller
/// driver (to come) or a settings/notification update source calls `publish_*`, a
/// ServerMessage flows to each subscribed connection.
pub struct ControlHub {
    inner: RwLock<HubState>,
    tx: broadcast::Sender<ServerMessage>,
}

pub(crate) fn hooks_status_message(status: RegistrationStatus) -> ServerMessage {
    ServerMessage::HooksStatus {
        hooks_registered: status.hooks_registered,
        status_line_registered: status.status_line_registered,
        status_line_conflict: status.status_line_conflict,
    }
}

pub(crate) fn state_sync_of(snapshot: &StateSnapshot) -> ServerMessage {
    ServerMessage::StateSync {
        cockpit_terminals: snapshot.sessions.clone(),
        orgs: snapshot.orgs.clone(),
        org_colors: snapshot.org_colors.clone(),
        org_aliases: snapshot.org_aliases.clone(),
    }
}

/// In-flight work counts backing `GET /api/activity`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySummary {
    pub active_sessions: u32,
    pub running_subagents: u32,
    pub background_shells: u32,
}

/// A session counts as active when Claude is working (`running`/`running_bg_agent`) or blocked
/// awaiting the user (`waiting_input`). `idle`/`no_claude`/`starting` are safely restorable and do
/// not, on their own, warrant a quit confirmation.
fn is_active_state(state: &str) -> bool {
    matches!(state, "running" | "running_bg_agent" | "waiting_input")
}

fn summarize_activity(sessions: &[CockpitTerminalInfo]) -> ActivitySummary {
    let mut summary = ActivitySummary::default();
    for session in sessions {
        if is_active_state(&session.state) {
            summary.active_sessions += 1;
        }
        summary.running_subagents += session.running_subagents.unwrap_or(0);
        summary.background_shells += session.shells_running.unwrap_or(0);
    }
    summary
}

impl ControlHub {
    pub fn new(
        config: ConfigView,
        notifications: Vec<Notification>,
        snapshot: StateSnapshot,
    ) -> Arc<Self> {
        let (tx, _) = broadcast::channel(64);
        Arc::new(Self {
            inner: RwLock::new(HubState {
                config,
                notifications,
                snapshot,
                notes: BTreeMap::new(),
                last_notification_at: 0,
                rate_limits: HashMap::new(),
                hooks_status: RegistrationStatus::default(),
            }),
            tx,
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ServerMessage> {
        self.tx.subscribe()
    }

    /// The messages sent right after connecting (config.sync -> notifications.sync -> state.sync -> hooks.status -> notes.sync).
    pub(crate) fn connect_messages(&self) -> [ServerMessage; 5] {
        let state = self.inner.read().unwrap();
        [
            ServerMessage::ConfigSync {
                notify_sound: state.config.notify_sound,
                update_check: state.config.update_check,
                language: state.config.language.clone(),
                account_usage: state.config.account_usage,
                editor: state.config.editor.clone(),
            },
            ServerMessage::NotificationsSync {
                items: state.notifications.clone(),
            },
            state_sync_of(&state.snapshot),
            hooks_status_message(state.hooks_status),
            ServerMessage::NotesSync {
                notes: state.notes.clone(),
            },
        ]
    }

    /// The state.sync for the currently held snapshot (a response guarantee for when the refresh path is unavailable).
    pub(crate) fn current_state_sync(&self) -> ServerMessage {
        state_sync_of(&self.inner.read().unwrap().snapshot)
    }

    /// A count of in-flight work (active sessions / running subagents / resident background shells)
    /// from the currently held snapshot, for the guarded-quit confirmation (`GET /api/activity`).
    pub fn activity_summary(&self) -> ActivitySummary {
        summarize_activity(&self.inner.read().unwrap().snapshot.sessions)
    }

    /// Manual dismissal (removes only dismissible notifications). Broadcasts notifications.sync
    /// if anything changed (sticky/system notifications are kept).
    pub fn dismiss_notification(&self, id: &str) {
        let changed = {
            let mut state = self.inner.write().unwrap();
            let before = state.notifications.len();
            state
                .notifications
                .retain(|n| !(n.id == id && n.dismissible));
            (state.notifications.len() != before).then(|| state.notifications.clone())
        };
        if let Some(items) = changed {
            let _ = self.tx.send(ServerMessage::NotificationsSync { items });
        }
    }

    /// Stores the latest snapshot and broadcasts state.sync to all connections (called by the poller
    /// driver). Bridge-reported usage limits are merged in first so a fresh poll keeps them.
    pub fn publish_snapshot(&self, mut snapshot: StateSnapshot) {
        let sync = {
            let mut state = self.inner.write().unwrap();
            merge_rate_limits(&mut snapshot.sessions, &state.rate_limits);
            state.snapshot = snapshot;
            state_sync_of(&state.snapshot)
        };
        let _ = self.tx.send(sync);
    }

    /// Records a statusLine-bridge usage-limit reading for a sid. Re-broadcasts the current snapshot
    /// (with the reading merged in) only when the value actually changed — the statusLine fires on
    /// every render, so an unconditional broadcast would storm the clients.
    pub fn publish_rate_limits(&self, sid: &str, limits: UsageLimits, now_ms: u64) {
        let sync = {
            let mut guard = self.inner.write().unwrap();
            let state = &mut *guard;
            state
                .rate_limits
                .retain(|_, e| now_ms.saturating_sub(e.updated_at_ms) < RATE_LIMIT_TTL_MS);
            let changed = state.rate_limits.get(sid).map(|e| e.limits) != Some(limits);
            state.rate_limits.insert(
                sid.to_string(),
                RateLimitEntry {
                    limits,
                    updated_at_ms: now_ms,
                },
            );
            if !changed {
                return;
            }
            merge_rate_limits(&mut state.snapshot.sessions, &state.rate_limits);
            state_sync_of(&state.snapshot)
        };
        let _ = self.tx.send(sync);
    }

    /// Stores the settings and broadcasts config.sync to all connections.
    pub fn publish_config(&self, config: ConfigView) {
        let msg = ServerMessage::ConfigSync {
            notify_sound: config.notify_sound,
            update_check: config.update_check,
            language: config.language.clone(),
            account_usage: config.account_usage,
            editor: config.editor.clone(),
        };
        self.inner.write().unwrap().config = config;
        let _ = self.tx.send(msg);
    }

    /// Whether the update check is currently enabled (the live `updateCheck` config flag). The update-check
    /// task reads this each poll so disabling it in config.json stops the github.com egress without a restart (#26).
    pub fn update_check_enabled(&self) -> bool {
        self.inner.read().unwrap().config.update_check
    }

    /// Whether the account-usage bridge is opted in (the live `accountUsage` config flag). Read per launch
    /// so toggling the opt-in applies to the next launched claude without a restart.
    pub fn account_usage_enabled(&self) -> bool {
        self.inner.read().unwrap().config.account_usage
    }

    /// The live `editor` config value (None when unset). Read per `POST /api/git/open`.
    pub fn editor_command(&self) -> Option<String> {
        self.inner.read().unwrap().config.editor.clone()
    }

    /// Stores the integration status and broadcasts hooks.status to all connections (startup probe
    /// and after each register/unregister).
    pub fn publish_hooks_status(&self, status: RegistrationStatus) {
        self.inner.write().unwrap().hooks_status = status;
        let _ = self.tx.send(hooks_status_message(status));
    }

    /// Stores the notification list and broadcasts notifications.sync to all connections.
    pub fn publish_notifications(&self, notifications: Vec<Notification>) {
        let msg = ServerMessage::NotificationsSync {
            items: notifications.clone(),
        };
        self.inner.write().unwrap().notifications = notifications;
        let _ = self.tx.send(msg);
    }

    /// Stores the per-org notes and broadcasts notes.sync. Called with the freshly read store on the
    /// startup scan, a REST write, and an external-edit watch tick.
    pub fn publish_notes(&self, notes: BTreeMap<String, String>) {
        let msg = ServerMessage::NotesSync {
            notes: notes.clone(),
        };
        self.inner.write().unwrap().notes = notes;
        let _ = self.tx.send(msg);
    }

    /// The currently held per-org notes (for a REST handler to diff/return without a disk re-read).
    pub fn notes(&self) -> BTreeMap<String, String> {
        self.inner.read().unwrap().notes.clone()
    }

    /// The number of connected control WS clients (subscribers = WS connections only; used for the macOS fallback decision).
    pub fn client_count(&self) -> usize {
        self.tx.receiver_count()
    }

    /// Broadcasts an arbitrary ServerMessage to all connections (hooks' notify / git.dirty).
    pub fn broadcast(&self, msg: ServerMessage) {
        let _ = self.tx.send(msg);
    }

    /// Enqueues hooks' waiting/done into NOTIFICATION and broadcasts notifications.sync to all
    /// connections. createdAt is kept
    /// monotonically increasing so that "prune oldest-first by occurrence order" holds even for
    /// bursts within the same millisecond.
    pub fn record_activity(
        &self,
        id: String,
        kind: crate::protocol::NotifyKind,
        window_title: &str,
        now_ms: u64,
    ) {
        let items = {
            let mut state = self.inner.write().unwrap();
            let created = now_ms.max(state.last_notification_at + 1);
            state.last_notification_at = created;
            let n = crate::notifications::notify_notification(id, kind, window_title, created);
            let next = crate::notifications::append_notification(
                &state.notifications,
                n,
                crate::notifications::NOTIFICATIONS_MAX,
            );
            state.notifications = next.clone();
            next
        };
        let _ = self.tx.send(ServerMessage::NotificationsSync { items });
    }

    /// Enqueues orphan/zombie process detection into NOTIFICATION and broadcasts notifications.sync
    /// to all connections. createdAt is kept monotonically increasing via the same
    /// `last_notification_at` as the other record_* methods.
    pub fn record_warning(&self, id: String, title: String, body: Option<String>, now_ms: u64) {
        let items = {
            let mut state = self.inner.write().unwrap();
            let created = now_ms.max(state.last_notification_at + 1);
            state.last_notification_at = created;
            let n = crate::notifications::warn_notification(id, title, body, created);
            let next = crate::notifications::append_notification(
                &state.notifications,
                n,
                crate::notifications::NOTIFICATIONS_MAX,
            );
            state.notifications = next.clone();
            next
        };
        let _ = self.tx.send(ServerMessage::NotificationsSync { items });
    }

    /// Surfaces an external-dependency boundary failure (missing binary / unreadable settings) as a Warn
    /// NOTIFICATION. The fixed id per cause upserts so repeated failures refresh one entry rather than stacking.
    pub fn record_boundary_failure(
        &self,
        failure: crate::notifications::BoundaryFailure,
        now_ms: u64,
    ) {
        let items = {
            let mut state = self.inner.write().unwrap();
            let created = now_ms.max(state.last_notification_at + 1);
            state.last_notification_at = created;
            let n = crate::notifications::boundary_notification(failure, created);
            let next = crate::notifications::append_notification(
                &state.notifications,
                n,
                crate::notifications::NOTIFICATIONS_MAX,
            );
            state.notifications = next.clone();
            next
        };
        let _ = self.tx.send(ServerMessage::NotificationsSync { items });
    }

    /// Enqueues an "update available" announcement into NOTIFICATION and broadcasts notifications.sync (#26).
    /// The per-version id coalesces repeated daily polls of the same latest version (upsert), while a newer
    /// version stacks as a new entry. createdAt is kept monotonically increasing like the other record_* methods.
    pub fn record_update_available(&self, version: String, url: String, now_ms: u64) {
        let items = {
            let mut state = self.inner.write().unwrap();
            let created = now_ms.max(state.last_notification_at + 1);
            state.last_notification_at = created;
            let n = crate::notifications::update_available_notification(&version, &url, created);
            let next = crate::notifications::append_notification(
                &state.notifications,
                n,
                crate::notifications::NOTIFICATIONS_MAX,
            );
            state.notifications = next.clone();
            next
        };
        let _ = self.tx.send(ServerMessage::NotificationsSync { items });
    }

    /// Enqueues a server error into NOTIFICATION and broadcasts notifications.sync to all
    /// connections. createdAt is kept
    /// monotonically increasing via the same `last_notification_at` as `record_activity`.
    pub fn record_error(&self, id: String, code: &str, message: &str, now_ms: u64) {
        let items = {
            let mut state = self.inner.write().unwrap();
            let created = now_ms.max(state.last_notification_at + 1);
            state.last_notification_at = created;
            let n = crate::notifications::error_notification(id, code, message, created);
            let next = crate::notifications::append_notification(
                &state.notifications,
                n,
                crate::notifications::NOTIFICATIONS_MAX,
            );
            state.notifications = next.clone();
            next
        };
        let _ = self.tx.send(ServerMessage::NotificationsSync { items });
    }

    /// Enqueues a creation failure due to PTY exhaustion into NOTIFICATION and broadcasts
    /// notifications.sync to all connections. Consecutive failures are collapsed into a single
    /// entry via a fixed id (upsert). createdAt is monotonically increasing like record_activity.
    pub fn record_pty_exhaustion(&self, now_ms: u64) {
        let items = {
            let mut state = self.inner.write().unwrap();
            let created = now_ms.max(state.last_notification_at + 1);
            state.last_notification_at = created;
            let n = crate::notifications::pty_exhaustion_notification(created);
            let next = crate::notifications::append_notification(
                &state.notifications,
                n,
                crate::notifications::NOTIFICATIONS_MAX,
            );
            state.notifications = next.clone();
            next
        };
        let _ = self.tx.send(ServerMessage::NotificationsSync { items });
    }

    /// Enqueues a scrollback-memory pressure warning into NOTIFICATION and broadcasts
    /// notifications.sync. A fixed id upserts so repeated ticks above the threshold refresh a single
    /// entry rather than stacking. createdAt is monotonically increasing like the other record_* methods.
    pub fn record_scrollback_pressure(&self, used_bytes: usize, now_ms: u64) {
        let items = {
            let mut state = self.inner.write().unwrap();
            let created = now_ms.max(state.last_notification_at + 1);
            state.last_notification_at = created;
            let n = crate::notifications::scrollback_pressure_notification(used_bytes, created);
            let next = crate::notifications::append_notification(
                &state.notifications,
                n,
                crate::notifications::NOTIFICATIONS_MAX,
            );
            state.notifications = next.clone();
            next
        };
        let _ = self.tx.send(ServerMessage::NotificationsSync { items });
    }

    /// Withdraws the scrollback-memory pressure warning once aggregate usage drops back below the
    /// clear watermark (server-driven removal regardless of dismissible). No-op broadcast is skipped
    /// when the entry was not present.
    pub fn withdraw_scrollback_pressure(&self) {
        let changed = {
            let mut state = self.inner.write().unwrap();
            let before = state.notifications.len();
            state
                .notifications
                .retain(|n| n.id != crate::notifications::SCROLLBACK_PRESSURE_ID);
            (state.notifications.len() != before).then(|| state.notifications.clone())
        };
        if let Some(items) = changed {
            let _ = self.tx.send(ServerMessage::NotificationsSync { items });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::CockpitTerminalInfo;
    use std::collections::BTreeMap;

    fn snapshot_with(window: &str) -> StateSnapshot {
        StateSnapshot {
            sessions: vec![CockpitTerminalInfo {
                cockpit_terminal_id: window.to_string(),
                name: "repo".to_string(),
                org: "org".to_string(),
                repo: "repo".to_string(),
                state: "running".to_string(),
                title: None,
                sid: None,
                active: true,
                running_subagents: Some(0),
                shells_running: None,
                limited: false,
                usage: None,
            }],
            orgs: vec!["org".to_string()],
            org_colors: BTreeMap::new(),
            org_aliases: BTreeMap::new(),
        }
    }

    fn session(state: &str, subagents: Option<u32>, shells: Option<u32>) -> CockpitTerminalInfo {
        CockpitTerminalInfo {
            cockpit_terminal_id: "@1".to_string(),
            name: "repo".to_string(),
            org: "org".to_string(),
            repo: "repo".to_string(),
            state: state.to_string(),
            title: None,
            sid: None,
            active: true,
            running_subagents: subagents,
            shells_running: shells,
            limited: false,
            usage: None,
        }
    }

    #[test]
    fn summarize_activity_counts_active_states_subagents_and_shells() {
        let sessions = vec![
            session("running", Some(0), None),
            session("running_bg_agent", Some(2), None),
            session("waiting_input", None, None),
            session("idle", None, Some(1)),
            session("no_claude", None, None),
        ];
        let summary = summarize_activity(&sessions);
        assert_eq!(summary.active_sessions, 3);
        assert_eq!(summary.running_subagents, 2);
        assert_eq!(summary.background_shells, 1);
    }

    #[test]
    fn summarize_activity_is_all_zero_when_nothing_runs() {
        let sessions = vec![session("idle", None, None), session("no_claude", None, None)];
        assert_eq!(summarize_activity(&sessions), ActivitySummary::default());
    }

    #[test]
    fn connect_messages_are_config_notifications_state_in_order() {
        let hub = ControlHub::new(
            ConfigView {
                notify_sound: true,
                update_check: true,
                language: None,
                account_usage: false,
                editor: None,
            },
            vec![],
            snapshot_with("@1"),
        );
        let msgs = hub.connect_messages();
        assert!(matches!(msgs[0], ServerMessage::ConfigSync { .. }));
        assert!(matches!(msgs[1], ServerMessage::NotificationsSync { .. }));
        assert!(matches!(msgs[2], ServerMessage::StateSync { .. }));
        assert!(matches!(msgs[3], ServerMessage::HooksStatus { .. }));
        assert!(matches!(msgs[4], ServerMessage::NotesSync { .. }));
    }

    #[tokio::test]
    async fn publish_notes_stores_and_broadcasts_notes_sync() {
        let hub = ControlHub::new(ConfigView::default(), vec![], snapshot_with("@1"));
        let mut rx = hub.subscribe();
        hub.publish_notes(BTreeMap::from([("acme".to_string(), "# Acme\n".to_string())]));
        assert_eq!(
            hub.notes(),
            BTreeMap::from([("acme".to_string(), "# Acme\n".to_string())])
        );
        // The new note is delivered on connect too (index 4).
        assert!(matches!(
            &hub.connect_messages()[4],
            ServerMessage::NotesSync { notes } if notes.get("acme").map(String::as_str) == Some("# Acme\n")
        ));
        match rx.try_recv() {
            Ok(ServerMessage::NotesSync { notes }) => {
                assert_eq!(notes.get("acme").map(String::as_str), Some("# Acme\n"));
            }
            other => panic!("expected notes.sync broadcast, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn publish_snapshot_broadcasts_state_sync_to_subscribers() {
        let hub = ControlHub::new(ConfigView::default(), vec![], snapshot_with("@1"));
        let mut rx = hub.subscribe();
        hub.publish_snapshot(snapshot_with("@2"));
        let got = rx.recv().await.unwrap();
        match got {
            ServerMessage::StateSync { cockpit_terminals: sessions, .. } => {
                assert_eq!(sessions[0].cockpit_terminal_id, "@2");
            }
            _ => panic!("expected state.sync"),
        }
        // It is also stored and reflected in the initial delivery of the next connection.
        assert!(matches!(
            hub.connect_messages()[2],
            ServerMessage::StateSync { .. }
        ));
    }

    fn snapshot_with_usage(sid: &str) -> StateSnapshot {
        let mut snap = snapshot_with("@1");
        snap.sessions[0].sid = Some(sid.to_string());
        snap.sessions[0].usage = Some(crate::protocol::SessionUsage {
            turn_tokens: 1,
            session_tokens: 2,
            turn_started_at: 0,
            session_started_at: 0,
            limits: None,
        });
        snap
    }

    fn five_hour(used_percent: u32) -> UsageLimits {
        UsageLimits {
            five_hour: Some(crate::protocol::UsageLimit {
                used_percent,
                resets_at: None,
            }),
            week: None,
        }
    }

    fn recv_five_hour_percent(msg: ServerMessage) -> Option<u32> {
        match msg {
            ServerMessage::StateSync { cockpit_terminals: sessions, .. } => Some(
                sessions[0]
                    .usage
                    .as_ref()?
                    .limits
                    .as_ref()?
                    .five_hour?
                    .used_percent,
            ),
            _ => None,
        }
    }

    #[tokio::test]
    async fn publish_rate_limits_merges_into_matching_session_and_survives_next_poll() {
        let hub = ControlHub::new(ConfigView::default(), vec![], snapshot_with_usage("sid-1"));
        let mut rx = hub.subscribe();

        hub.publish_rate_limits("sid-1", five_hour(80), 1_000);
        assert_eq!(recv_five_hour_percent(rx.recv().await.unwrap()), Some(80));

        // A subsequent poll (fresh transcript usage, no limits) keeps the bridge reading merged in.
        hub.publish_snapshot(snapshot_with_usage("sid-1"));
        assert_eq!(recv_five_hour_percent(rx.recv().await.unwrap()), Some(80));
    }

    #[tokio::test]
    async fn publish_rate_limits_skips_rebroadcast_when_value_unchanged() {
        let hub = ControlHub::new(ConfigView::default(), vec![], snapshot_with_usage("sid-1"));
        let mut rx = hub.subscribe();

        hub.publish_rate_limits("sid-1", five_hour(80), 1_000);
        hub.publish_rate_limits("sid-1", five_hour(80), 2_000);
        hub.publish_rate_limits("sid-1", five_hour(90), 3_000);

        // The unchanged reading is skipped, so the second delivery is the 90 update, not another 80.
        assert_eq!(recv_five_hour_percent(rx.recv().await.unwrap()), Some(80));
        assert_eq!(recv_five_hour_percent(rx.recv().await.unwrap()), Some(90));
    }

    #[tokio::test]
    async fn publish_rate_limits_leaves_non_matching_sid_untouched() {
        let hub = ControlHub::new(ConfigView::default(), vec![], snapshot_with_usage("sid-1"));
        let mut rx = hub.subscribe();
        hub.publish_rate_limits("other-sid", five_hour(80), 1_000);
        assert_eq!(recv_five_hour_percent(rx.recv().await.unwrap()), None);
    }

    #[tokio::test]
    async fn publish_config_and_notifications_broadcast() {
        let hub = ControlHub::new(ConfigView::default(), vec![], snapshot_with("@1"));
        let mut rx = hub.subscribe();
        hub.publish_config(ConfigView {
            notify_sound: true,
            update_check: true,
            language: Some("en".into()),
            account_usage: false,
            editor: None,
        });
        assert!(matches!(
            rx.recv().await.unwrap(),
            ServerMessage::ConfigSync {
                notify_sound: true,
                ..
            }
        ));
        hub.publish_notifications(vec![]);
        assert!(matches!(
            rx.recv().await.unwrap(),
            ServerMessage::NotificationsSync { .. }
        ));
    }

    #[test]
    fn editor_command_reflects_seed_then_live_update() {
        let hub = ControlHub::new(
            ConfigView {
                editor: Some("code -w".into()),
                ..Default::default()
            },
            vec![],
            snapshot_with("@1"),
        );
        assert_eq!(hub.editor_command(), Some("code -w".into()));
        hub.publish_config(ConfigView {
            editor: None,
            ..Default::default()
        });
        assert_eq!(hub.editor_command(), None);
    }

    async fn next_notifications(
        rx: &mut tokio::sync::broadcast::Receiver<ServerMessage>,
    ) -> Vec<crate::protocol::Notification> {
        loop {
            if let ServerMessage::NotificationsSync { items } = rx.recv().await.unwrap() {
                return items;
            }
        }
    }

    #[tokio::test]
    async fn record_activity_appends_with_monotonic_created_at() {
        let hub = ControlHub::new(ConfigView::default(), vec![], snapshot_with("@1"));
        let mut rx = hub.subscribe();
        // Even with the same now_ms, createdAt is kept monotonically increasing so occurrence order is preserved (newest-first, so the second entry is at the head).
        hub.record_activity("id1".to_string(), crate::protocol::NotifyKind::Waiting, "repo-a", 1000);
        hub.record_activity("id2".to_string(), crate::protocol::NotifyKind::Done, "repo-a", 1000);
        let _first = next_notifications(&mut rx).await;
        let second = next_notifications(&mut rx).await;
        assert_eq!(second.len(), 2);
        assert_eq!(second[0].id, "id2");
        assert_eq!(second[0].created_at, 1001);
        assert_eq!(second[1].created_at, 1000);
        assert_eq!(second[0].title, "✅ 完了 repo-a");
    }

    #[tokio::test]
    async fn record_warning_appends_warn_notification_and_broadcasts() {
        let hub = ControlHub::new(ConfigView::default(), vec![], snapshot_with("@1"));
        let mut rx = hub.subscribe();
        hub.record_warning(
            "orphan:42".to_string(),
            "👻 孤児プロセス pid 42".to_string(),
            Some("claude --resume".to_string()),
            1000,
        );
        let items = next_notifications(&mut rx).await;
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].level, crate::protocol::NotificationLevel::Warn);
        assert_eq!(items[0].id, "orphan:42");
        assert_eq!(items[0].title, "👻 孤児プロセス pid 42");
        assert_eq!(items[0].body.as_deref(), Some("claude --resume"));
    }

    #[tokio::test]
    async fn record_error_appends_error_notification_and_broadcasts() {
        let hub = ControlHub::new(ConfigView::default(), vec![], snapshot_with("@1"));
        let mut rx = hub.subscribe();
        hub.record_error("e1".to_string(), "internal", "boom", 1000);
        let items = next_notifications(&mut rx).await;
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].level, crate::protocol::NotificationLevel::Error);
        assert_eq!(items[0].title, "internal");
        assert_eq!(items[0].body.as_deref(), Some("boom"));
        assert_eq!(items[0].toast, Some(false));
    }

    #[tokio::test]
    async fn record_error_shares_monotonic_clock_with_activity() {
        let hub = ControlHub::new(ConfigView::default(), vec![], snapshot_with("@1"));
        let mut rx = hub.subscribe();
        hub.record_activity("a".to_string(), crate::protocol::NotifyKind::Waiting, "repo", 1000);
        hub.record_error("e".to_string(), "internal", "boom", 1000);
        let _first = next_notifications(&mut rx).await;
        let second = next_notifications(&mut rx).await;
        // The error is enqueued by +1'ing the same last_notification_at as activity, so it is at the head in newest-first order.
        assert_eq!(second[0].id, "e");
        assert_eq!(second[0].created_at, 1001);
    }

    #[tokio::test]
    async fn record_boundary_failure_appends_warn_and_upserts_by_cause() {
        let hub = ControlHub::new(ConfigView::default(), vec![], snapshot_with("@1"));
        let mut rx = hub.subscribe();
        hub.record_boundary_failure(crate::notifications::BoundaryFailure::RgMissing, 1000);
        hub.record_boundary_failure(crate::notifications::BoundaryFailure::RgMissing, 1000);
        let _first = next_notifications(&mut rx).await;
        let second = next_notifications(&mut rx).await;
        // The same cause upserts into one entry (refreshed timestamp), staying a Warn.
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].id, "boundary:rg-missing");
        assert_eq!(second[0].created_at, 1001);
        assert_eq!(second[0].level, crate::protocol::NotificationLevel::Warn);
        assert_eq!(
            second[0].title,
            crate::notifications::BoundaryFailure::RgMissing.title()
        );
    }

    #[tokio::test]
    async fn record_boundary_failure_keeps_distinct_causes_separate() {
        let hub = ControlHub::new(ConfigView::default(), vec![], snapshot_with("@1"));
        let mut rx = hub.subscribe();
        hub.record_boundary_failure(crate::notifications::BoundaryFailure::RgMissing, 1000);
        hub.record_boundary_failure(crate::notifications::BoundaryFailure::ClaudeMissing, 1000);
        let _first = next_notifications(&mut rx).await;
        let second = next_notifications(&mut rx).await;
        assert_eq!(second.len(), 2);
        let ids: std::collections::HashSet<_> = second.iter().map(|n| n.id.as_str()).collect();
        assert!(ids.contains("boundary:rg-missing"));
        assert!(ids.contains("boundary:claude-missing"));
    }

    #[tokio::test]
    async fn record_pty_exhaustion_appends_sticky_warn_and_dedupes() {
        let hub = ControlHub::new(ConfigView::default(), vec![], snapshot_with("@1"));
        let mut rx = hub.subscribe();
        hub.record_pty_exhaustion(1000);
        hub.record_pty_exhaustion(1000);
        let _first = next_notifications(&mut rx).await;
        let second = next_notifications(&mut rx).await;
        // Aggregated into a single entry via a fixed id, with monotonically increasing createdAt, keeping sticky/warn.
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].id, crate::notifications::PTY_EXHAUSTION_ID);
        assert_eq!(second[0].created_at, 1001);
        assert_eq!(second[0].level, crate::protocol::NotificationLevel::Warn);
        assert!(second[0].sticky);
    }
}
