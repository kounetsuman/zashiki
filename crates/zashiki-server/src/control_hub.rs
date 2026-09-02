use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};

use tokio::sync::broadcast;

use crate::account_status::AccountStatus;
use crate::claude_settings::RegistrationStatus;
use crate::control::ConfigView;
use crate::hooks::{notify_delivery, MacNotification, MacNotify, NotifyEvent, NotifyMode};
use crate::protocol::{Notification, ServerMessage, CockpitTerminalInfo, UsageLimit, UsageLimits};
use crate::status_poller::StateSnapshot;

struct HubState {
    config: ConfigView,
    /// The notification channel (ZK_NOTIFY; web/macos/both/off), for delivery routing in `notify`.
    notify_mode: NotifyMode,
    /// The macOS notification executor (terminal-notifier by default; a no-op until set by runtime).
    mac_notify: MacNotify,
    notifications: Vec<Notification>,
    snapshot: StateSnapshot,
    /// Per-org notes (org → Markdown), delivered on connect and re-broadcast on any note change.
    notes: BTreeMap<String, String>,
    /// The single app-wide memo (Markdown), delivered on connect and re-broadcast on any change.
    memo: String,
    /// Presence of zashiki's integration in ~/.claude/settings.json, delivered on connect and after
    /// register/unregister. Defaults to "not registered" until the startup probe (runtime) sets it.
    hooks_status: RegistrationStatus,
    /// The signed-in Claude account, delivered on connect and re-read on each account.refresh. Defaults
    /// to logged-out until the startup probe (runtime) sets it.
    account_status: AccountStatus,
    /// The createdAt of the last enqueued notification. Kept monotonically increasing so
    /// occurrence order is preserved even for bursts within the same millisecond.
    last_notification_at: u64,
    /// The single account-global usage reading, reconciled from every session's statusLine reports
    /// (see `reconcile_account_limits`). Delivered on `state.sync` as `account_limits`. None until the
    /// bridge has reported any.
    account_limits: Option<UsageLimits>,
}

/// Epoch-ms slack that absorbs tiny reset-time jitter between sessions reporting the same window, so
/// only a genuine window rollover (hours/days later) counts as a newer window.
const RESET_EPSILON_MS: u64 = 5 * 60 * 1000;

/// Whether `incoming` is a fresher reading of one usage window than `stored`. Account usage percent is
/// monotonic within a window and drops when the window rolls over, so with both reset times known the
/// fresher reading is the one from the later window, or — within the same window — the strictly higher
/// percent. This keeps a stale idle-session reading from regressing the display when its statusLine
/// fires on a tab switch. When a reset time is missing (window undecidable) the latest reading wins, so
/// a rollover can never leave the value stuck at a stale high percent.
fn incoming_is_fresher(stored: UsageLimit, incoming: UsageLimit) -> bool {
    match (stored.resets_at, incoming.resets_at) {
        (Some(s), Some(i)) if i > s.saturating_add(RESET_EPSILON_MS) => true,
        (Some(s), Some(i)) if s > i.saturating_add(RESET_EPSILON_MS) => false,
        (Some(_), Some(_)) => incoming.used_percent > stored.used_percent,
        _ => true,
    }
}

/// Merges one window's incoming reading into the stored one, keeping whichever is fresher. A missing
/// side yields the other.
fn merge_window(stored: Option<UsageLimit>, incoming: Option<UsageLimit>) -> Option<UsageLimit> {
    match (stored, incoming) {
        (Some(s), Some(i)) => Some(if incoming_is_fresher(s, i) { i } else { s }),
        (stored, incoming) => incoming.or(stored),
    }
}

/// Folds an incoming statusLine reading into the stored account-global reading, keeping the fresher of
/// each window. Returns None when neither side carries any window (so the footer stays hidden until a
/// real reading arrives).
fn reconcile_account_limits(
    stored: Option<UsageLimits>,
    incoming: UsageLimits,
) -> Option<UsageLimits> {
    let (stored_five, stored_week) = stored.map_or((None, None), |s| (s.five_hour, s.week));
    let five_hour = merge_window(stored_five, incoming.five_hour);
    let week = merge_window(stored_week, incoming.week);
    (five_hour.is_some() || week.is_some()).then_some(UsageLimits { five_hour, week })
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

pub(crate) fn state_sync_of(
    snapshot: &StateSnapshot,
    account_limits: Option<UsageLimits>,
) -> ServerMessage {
    ServerMessage::StateSync {
        cockpit_terminals: snapshot.sessions.clone(),
        orgs: snapshot.orgs.clone(),
        org_colors: snapshot.org_colors.clone(),
        org_aliases: snapshot.org_aliases.clone(),
        account_limits,
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
/// awaiting the user (`waiting_input`). `idle`/`watching`/`no_claude`/`starting` are safely
/// restorable (a watching session's turn has ended; its open tasks persist on disk) and do not,
/// on their own, warrant a quit confirmation.
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
                notify_mode: NotifyMode::default(),
                mac_notify: Arc::new(|_| {}),
                notifications,
                snapshot,
                notes: BTreeMap::new(),
                memo: String::new(),
                last_notification_at: 0,
                account_limits: None,
                hooks_status: RegistrationStatus::default(),
                account_status: AccountStatus::default(),
            }),
            tx,
        })
    }

    /// Wires the notification delivery channel + macOS executor. Defaults to web + a no-op executor.
    pub fn set_notifier(&self, notify_mode: NotifyMode, mac_notify: MacNotify) {
        let mut state = self.inner.write().unwrap();
        state.notify_mode = notify_mode;
        state.mac_notify = mac_notify;
    }

    /// The live per-category notification switches (a copy).
    pub fn notification_settings(&self) -> crate::protocol::NotificationSettings {
        self.inner.read().unwrap().config.notifications
    }

    /// Deliver a notification, applying the live per-category switches. Nothing is sent unless the
    /// master is on and the category wants show or sound. The web push carries the event so the client
    /// renders the visual and/or sound per its own read of the same switches. terminal-notifier cannot
    /// play a sound without also showing a banner, so the macOS path fires whenever the category wants
    /// either, and plays its sound only when `sound` is on.
    pub fn notify(&self, event: NotifyEvent) {
        let (settings, notify_mode, mac_notify) = {
            let state = self.inner.read().unwrap();
            (state.config.notifications, state.notify_mode, state.mac_notify.clone())
        };
        if !settings.delivers(event.kind) {
            return;
        }
        let pref = settings.pref_for(event.kind);
        let delivery = notify_delivery(notify_mode, self.client_count());
        if delivery.push {
            self.broadcast(ServerMessage::Notify {
                kind: event.kind,
                cockpit_terminal_id: event.cockpit_terminal_id.clone(),
                title: event.name.clone(),
            });
        }
        if delivery.mac {
            mac_notify(MacNotification {
                kind: event.kind,
                title: event.name,
                message: event.session_title,
                sound: pref.sound,
            });
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ServerMessage> {
        self.tx.subscribe()
    }

    /// The messages sent right after connecting (config.sync -> notifications.sync -> state.sync -> hooks.status -> notes.sync -> memo.sync -> account.status).
    pub(crate) fn connect_messages(&self) -> [ServerMessage; 7] {
        let state = self.inner.read().unwrap();
        [
            ServerMessage::ConfigSync {
                notify_sound: state.config.notify_sound,
                update_check: state.config.update_check,
                language: state.config.language.clone(),
                account_usage: state.config.account_usage,
                memo_enabled: state.config.memo_enabled,
                editor: state.config.editor.clone(),
                footer_thresholds: state.config.footer_thresholds,
                notifications: state.config.notifications,
            },
            ServerMessage::NotificationsSync {
                items: state.notifications.clone(),
            },
            state_sync_of(&state.snapshot, state.account_limits),
            hooks_status_message(state.hooks_status),
            ServerMessage::NotesSync {
                notes: state.notes.clone(),
            },
            ServerMessage::MemoSync {
                text: state.memo.clone(),
            },
            state.account_status.to_message(),
        ]
    }

    /// The state.sync for the currently held snapshot (a response guarantee for when the refresh path is unavailable).
    pub(crate) fn current_state_sync(&self) -> ServerMessage {
        let state = self.inner.read().unwrap();
        state_sync_of(&state.snapshot, state.account_limits)
    }

    /// The current reconciled account-global usage reading (for building a state.sync from a snapshot
    /// obtained outside the hub, e.g. a manual refresh reply).
    pub(crate) fn account_limits(&self) -> Option<UsageLimits> {
        self.inner.read().unwrap().account_limits
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

    /// Stores the latest snapshot and broadcasts state.sync (with the current account-global usage) to
    /// all connections. Called by the poller driver.
    pub fn publish_snapshot(&self, snapshot: StateSnapshot) {
        let sync = {
            let mut state = self.inner.write().unwrap();
            state.snapshot = snapshot;
            state_sync_of(&state.snapshot, state.account_limits)
        };
        let _ = self.tx.send(sync);
    }

    /// Folds a statusLine-bridge reading into the single account-global usage reading and re-broadcasts
    /// state.sync — but only when the reconciled value actually changed. Account usage is global, so a
    /// stale reading from an idle session (older window or lower percent) is discarded rather than
    /// overwriting a fresher one, keeping the footer steady across tab switches. The statusLine fires
    /// on every render, so an unconditional broadcast would storm the clients.
    pub fn publish_rate_limits(&self, incoming: UsageLimits) {
        let sync = {
            let mut guard = self.inner.write().unwrap();
            let state = &mut *guard;
            let reconciled = reconcile_account_limits(state.account_limits, incoming);
            if reconciled.is_none() || state.account_limits == reconciled {
                return;
            }
            state.account_limits = reconciled;
            state_sync_of(&state.snapshot, state.account_limits)
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
            memo_enabled: config.memo_enabled,
            editor: config.editor.clone(),
            footer_thresholds: config.footer_thresholds,
            notifications: config.notifications,
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

    /// Whether the global memo is opted in (the live `memoEnabled` config flag).
    pub fn memo_enabled(&self) -> bool {
        self.inner.read().unwrap().config.memo_enabled
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

    /// Stores the signed-in account and broadcasts account.status to all connections (startup probe
    /// and after each account.refresh).
    pub fn publish_account_status(&self, status: AccountStatus) {
        let msg = status.to_message();
        self.inner.write().unwrap().account_status = status;
        let _ = self.tx.send(msg);
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

    /// Stores the memo and broadcasts memo.sync. Called with the freshly read text on the startup
    /// scan, a REST write, and an external-edit watch tick.
    pub fn publish_memo(&self, text: String) {
        let msg = ServerMessage::MemoSync { text: text.clone() };
        self.inner.write().unwrap().memo = text;
        let _ = self.tx.send(msg);
    }

    /// The currently held memo (for the watch to diff against without a redundant re-broadcast).
    pub fn memo(&self) -> String {
        self.inner.read().unwrap().memo.clone()
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
        cockpit_terminal_id: String,
        window_title: &str,
        now_ms: u64,
    ) {
        let items = {
            let mut state = self.inner.write().unwrap();
            let created = now_ms.max(state.last_notification_at + 1);
            state.last_notification_at = created;
            let n = crate::notifications::notify_notification(
                id,
                kind,
                cockpit_terminal_id,
                window_title,
                created,
            );
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
                vitest_running: None,
                limited: false,
                menu_open: false,
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
            vitest_running: None,
            limited: false,
            menu_open: false,
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
                memo_enabled: false,
                editor: None,
                footer_thresholds: Default::default(),
                notifications: Default::default(),
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
        assert!(matches!(msgs[5], ServerMessage::MemoSync { .. }));
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

    fn five_hour_at(used_percent: u32, resets_at: Option<u64>) -> UsageLimits {
        UsageLimits {
            five_hour: Some(UsageLimit {
                used_percent,
                resets_at,
            }),
            week: None,
        }
    }

    fn five_hour(used_percent: u32) -> UsageLimits {
        five_hour_at(used_percent, None)
    }

    fn recv_account_five_hour(msg: ServerMessage) -> Option<u32> {
        match msg {
            ServerMessage::StateSync { account_limits, .. } => {
                Some(account_limits?.five_hour?.used_percent)
            }
            _ => None,
        }
    }

    #[test]
    fn incoming_is_fresher_prefers_higher_percent_in_same_window() {
        let base = Some(1_000_000);
        assert!(incoming_is_fresher(
            UsageLimit { used_percent: 50, resets_at: base },
            UsageLimit { used_percent: 60, resets_at: base },
        ));
        assert!(!incoming_is_fresher(
            UsageLimit { used_percent: 60, resets_at: base },
            UsageLimit { used_percent: 50, resets_at: base },
        ));
    }

    #[test]
    fn incoming_is_fresher_takes_a_later_window_even_when_percent_drops() {
        let now = 1_000_000;
        // A genuine rollover (well past the jitter epsilon) resets the percent to a lower value.
        assert!(incoming_is_fresher(
            UsageLimit { used_percent: 95, resets_at: Some(now) },
            UsageLimit { used_percent: 3, resets_at: Some(now + 6 * 3_600_000) },
        ));
        // An older window never wins, however high its percent.
        assert!(!incoming_is_fresher(
            UsageLimit { used_percent: 3, resets_at: Some(now + 6 * 3_600_000) },
            UsageLimit { used_percent: 95, resets_at: Some(now) },
        ));
    }

    #[test]
    fn incoming_is_fresher_takes_the_latest_when_a_reset_time_is_missing() {
        // Without a reset time the window is undecidable, so a rollover (percent drop) must still be
        // taken — otherwise the value would stick at the stale high percent forever.
        assert!(incoming_is_fresher(
            UsageLimit { used_percent: 95, resets_at: None },
            UsageLimit { used_percent: 2, resets_at: None },
        ));
    }

    #[test]
    fn reconcile_account_limits_is_none_when_nothing_reported() {
        let empty = UsageLimits { five_hour: None, week: None };
        assert_eq!(reconcile_account_limits(None, empty), None);
    }

    #[tokio::test]
    async fn publish_rate_limits_sets_account_limits_and_survives_next_poll() {
        let hub = ControlHub::new(ConfigView::default(), vec![], snapshot_with("@1"));
        let mut rx = hub.subscribe();

        hub.publish_rate_limits(five_hour(80));
        assert_eq!(recv_account_five_hour(rx.recv().await.unwrap()), Some(80));

        // A subsequent poll carries the account-global reading unchanged (it's not per session).
        hub.publish_snapshot(snapshot_with("@2"));
        assert_eq!(recv_account_five_hour(rx.recv().await.unwrap()), Some(80));
    }

    #[tokio::test]
    async fn publish_rate_limits_skips_rebroadcast_when_value_unchanged() {
        let hub = ControlHub::new(ConfigView::default(), vec![], snapshot_with("@1"));
        let mut rx = hub.subscribe();

        hub.publish_rate_limits(five_hour(80));
        hub.publish_rate_limits(five_hour(80));
        hub.publish_rate_limits(five_hour(90));

        // The unchanged reading is skipped, so the second delivery is the 90 update, not another 80.
        assert_eq!(recv_account_five_hour(rx.recv().await.unwrap()), Some(80));
        assert_eq!(recv_account_five_hour(rx.recv().await.unwrap()), Some(90));
    }

    #[tokio::test]
    async fn publish_rate_limits_discards_a_stale_lower_reading_within_the_window() {
        let hub = ControlHub::new(ConfigView::default(), vec![], snapshot_with("@1"));
        let mut rx = hub.subscribe();
        let window = Some(9_000_000);

        // A high reading, then a stale idle-session reading (same window, lower) that must not regress
        // the display, then a genuinely higher one.
        hub.publish_rate_limits(five_hour_at(90, window));
        hub.publish_rate_limits(five_hour_at(30, window));
        hub.publish_rate_limits(five_hour_at(95, window));

        // The stale 30 is discarded (no rebroadcast), so the deliveries are 90 then 95.
        assert_eq!(recv_account_five_hour(rx.recv().await.unwrap()), Some(90));
        assert_eq!(recv_account_five_hour(rx.recv().await.unwrap()), Some(95));
    }

    #[tokio::test]
    async fn publish_rate_limits_accepts_a_weekly_rollover_to_a_lower_percent() {
        let hub = ControlHub::new(ConfigView::default(), vec![], snapshot_with("@1"));
        let mut rx = hub.subscribe();
        let week = |used_percent, resets_at| UsageLimits {
            five_hour: None,
            week: Some(UsageLimit { used_percent, resets_at: Some(resets_at) }),
        };
        let recv_week = |msg| match msg {
            ServerMessage::StateSync { account_limits, .. } => {
                account_limits.and_then(|l| l.week).map(|w| w.used_percent)
            }
            _ => None,
        };
        let base = 9_000_000;

        hub.publish_rate_limits(week(61, base));
        // The weekly window rolls over (a week later): the lower percent must be taken, not stuck at 61.
        hub.publish_rate_limits(week(2, base + 7 * 86_400_000));

        assert_eq!(recv_week(rx.recv().await.unwrap()), Some(61));
        assert_eq!(recv_week(rx.recv().await.unwrap()), Some(2));
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
            memo_enabled: false,
            editor: None,
            footer_thresholds: Default::default(),
            notifications: Default::default(),
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
        hub.record_activity("id1".to_string(), crate::protocol::NotifyKind::Waiting, "@1".to_string(), "repo-a", 1000);
        hub.record_activity("id2".to_string(), crate::protocol::NotifyKind::Done, "@1".to_string(), "repo-a", 1000);
        let _first = next_notifications(&mut rx).await;
        let second = next_notifications(&mut rx).await;
        assert_eq!(second.len(), 2);
        assert_eq!(second[0].id, "id2");
        assert_eq!(second[0].created_at, 1001);
        assert_eq!(second[1].created_at, 1000);
        assert_eq!(second[0].title, "✅ 完了 repo-a");
        assert_eq!(second[0].cockpit_terminal_id.as_deref(), Some("@1"));
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
        hub.record_activity("a".to_string(), crate::protocol::NotifyKind::Waiting, "@1".to_string(), "repo", 1000);
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

    fn hub_with_notifications(
        notifications: crate::protocol::NotificationSettings,
    ) -> (Arc<ControlHub>, Arc<std::sync::Mutex<Vec<MacNotification>>>) {
        let config = ConfigView { notifications, ..Default::default() };
        let hub = ControlHub::new(config, vec![], snapshot_with("@1"));
        let log = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = log.clone();
        hub.set_notifier(NotifyMode::Both, Arc::new(move |n| sink.lock().unwrap().push(n)));
        (hub, log)
    }

    fn subagent_start_event() -> NotifyEvent {
        NotifyEvent {
            kind: crate::protocol::NotifyKind::SubagentStart,
            cockpit_terminal_id: "@1".to_string(),
            name: "repo".to_string(),
            session_title: "題名".to_string(),
        }
    }

    fn settings_for_subagent_start(
        enabled: bool,
        pref: crate::protocol::NotifyCategoryPref,
    ) -> crate::protocol::NotificationSettings {
        let categories = crate::protocol::NotifyCategories {
            subagent_start: pref,
            ..Default::default()
        };
        crate::protocol::NotificationSettings { enabled, categories }
    }

    fn pushed_notify(rx: &mut broadcast::Receiver<ServerMessage>) -> bool {
        std::iter::from_fn(|| rx.try_recv().ok())
            .any(|m| matches!(m, ServerMessage::Notify { .. }))
    }

    #[test]
    fn notify_suppressed_entirely_when_master_off() {
        let settings = settings_for_subagent_start(
            false,
            crate::protocol::NotifyCategoryPref {
                notify: true,
                sound: true,
                sound_type: crate::protocol::SoundPreset::Ping,
            },
        );
        let (hub, macs) = hub_with_notifications(settings);
        let mut rx = hub.subscribe();
        hub.notify(subagent_start_event());
        assert!(!pushed_notify(&mut rx));
        assert!(macs.lock().unwrap().is_empty());
    }

    #[test]
    fn notify_pushes_and_macs_with_sound_when_category_on() {
        let settings = settings_for_subagent_start(
            true,
            crate::protocol::NotifyCategoryPref {
                notify: true,
                sound: true,
                sound_type: crate::protocol::SoundPreset::Ping,
            },
        );
        let (hub, macs) = hub_with_notifications(settings);
        let mut rx = hub.subscribe();
        hub.notify(subagent_start_event());
        assert!(pushed_notify(&mut rx));
        let macs = macs.lock().unwrap();
        assert_eq!(macs.len(), 1);
        assert!(macs[0].sound);
    }

    #[test]
    fn notify_pushes_and_macs_with_sound_when_only_sound_on() {
        // terminal-notifier can't play a sound without a banner, so a sound-only category still fires
        // the macOS notification (with sound); the client suppresses the visual per the same switch.
        let settings = settings_for_subagent_start(
            true,
            crate::protocol::NotifyCategoryPref {
                notify: false,
                sound: true,
                sound_type: crate::protocol::SoundPreset::Ping,
            },
        );
        let (hub, macs) = hub_with_notifications(settings);
        let mut rx = hub.subscribe();
        hub.notify(subagent_start_event());
        assert!(pushed_notify(&mut rx));
        let macs = macs.lock().unwrap();
        assert_eq!(macs.len(), 1);
        assert!(macs[0].sound);
    }

    #[test]
    fn notify_macs_without_sound_when_visual_on_but_sound_off() {
        let settings = settings_for_subagent_start(
            true,
            crate::protocol::NotifyCategoryPref {
                notify: true,
                sound: false,
                sound_type: crate::protocol::SoundPreset::Ping,
            },
        );
        let (hub, macs) = hub_with_notifications(settings);
        hub.notify(subagent_start_event());
        let macs = macs.lock().unwrap();
        assert_eq!(macs.len(), 1);
        assert!(!macs[0].sound);
    }
}
