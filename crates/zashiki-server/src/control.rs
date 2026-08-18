//! Wiring for `/ws/control` (the JSON control channel). A port of the controlWss
//! from the TS `app.ts`. On connect it delivers config.sync -> notifications.sync ->
//! state.sync, and thereafter forwards the shared `ControlHub`'s broadcast to each
//! connection. ClientMessage handles state.refresh (requests an immediate
//! re-evaluation from the poller with a guaranteed response) and notification.dismiss.
//! Dispatch of session.new/close and term.* plus heartbeat come later.

use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket};
use tokio::sync::{broadcast, mpsc, oneshot};
use zashiki_core::terminal_size::clamp_terminal_size;

/// The ping interval for WS liveness monitoring (the TS `app.ts` `HEARTBEAT_INTERVAL_MS`).
/// A ping is sent after one interval with no response, and the connection is dropped if
/// no pong returns before the next interval (effective timeout is one to two intervals).
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);

use crate::protocol::{ClientMessage, Notification, ServerMessage};
use crate::status_poller::StateSnapshot;
use crate::term_registry::{TermEntry, TermRegistry};

/// Live-applied settings (the config.sync payload).
#[derive(Debug, Clone, Default)]
pub struct ConfigView {
    pub notify_sound: bool,
    pub debug: bool,
    /// Whether the server may poll GitHub Releases for updates (#26). Default on; set false in config.json
    /// to stop the outbound egress to github.com. Checked live per poll, so toggling applies without restart.
    pub update_check: bool,
    /// Display language ("ja"/"en"). None when unset, delegating to the client's browser detection.
    pub language: Option<String>,
}

/// An immediate re-evaluation request to the poller. If `reply` is present, the
/// post-evaluation snapshot is sent back (to guarantee a response for state.refresh).
/// Otherwise it is fire-and-forget (reflected via broadcast).
pub struct RefreshRequest {
    pub reply: Option<oneshot::Sender<StateSnapshot>>,
}

/// The dependencies the control handler receives (hub + the refresh path to the poller +
/// session operations + term registry).
#[derive(Clone)]
pub struct ControlServices {
    pub hub: Arc<ControlHub>,
    pub refresh: mpsc::Sender<RefreshRequest>,
    /// Live repos.conf-derived roots/colors (org validation for session.new). Shared with the poller
    /// and the repos watcher so a newly added org is accepted without a restart.
    pub repos: crate::repos::SharedRepos,
    /// Whether session.new launches `claude --session-id <uuid>` (the TS launchClaude).
    pub launch_claude: bool,
    /// The registry of view terms that term.* refers to.
    pub terms: Arc<Mutex<TermRegistry>>,
    /// The owned PTY registry. `attach_owned_term` looks it up by session_id.
    pub sessions: Arc<crate::session_registry::SessionRegistry>,
    /// The ping interval for WS liveness monitoring (the TS heartbeat; default `HEARTBEAT_INTERVAL`; tests shorten it).
    pub heartbeat: Duration,
    /// The destination for hooks notifications (ZK_NOTIFY; default web).
    pub notify_mode: crate::hooks::NotifyMode,
    /// The executor for macOS notifications (default terminal-notifier; swapped out in tests).
    pub mac_notify: crate::hooks::MacNotify,
    /// The path to config.json (the write target for SETTINGS' config.update; None for tests etc.).
    pub config_path: Option<std::path::PathBuf>,
}

struct HubState {
    config: ConfigView,
    notifications: Vec<Notification>,
    snapshot: StateSnapshot,
    /// The createdAt of the last enqueued notification. Kept monotonically increasing so
    /// occurrence order is preserved even for bursts within the same millisecond.
    last_notification_at: u64,
}

/// The shared state + broadcast that all control connections refer to. When the poller
/// driver (to come) or a settings/notification update source calls `publish_*`, a
/// ServerMessage flows to each subscribed connection.
pub struct ControlHub {
    inner: RwLock<HubState>,
    tx: broadcast::Sender<ServerMessage>,
}

fn state_sync_of(snapshot: &StateSnapshot) -> ServerMessage {
    ServerMessage::StateSync {
        sessions: snapshot.sessions.clone(),
        orgs: snapshot.orgs.clone(),
        org_colors: snapshot.org_colors.clone(),
    }
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
                last_notification_at: 0,
            }),
            tx,
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ServerMessage> {
        self.tx.subscribe()
    }

    /// The three messages sent right after connecting (in the order config.sync -> notifications.sync -> state.sync).
    fn connect_messages(&self) -> [ServerMessage; 3] {
        let state = self.inner.read().unwrap();
        [
            ServerMessage::ConfigSync {
                notify_sound: state.config.notify_sound,
                debug: state.config.debug,
                update_check: state.config.update_check,
                language: state.config.language.clone(),
            },
            ServerMessage::NotificationsSync {
                items: state.notifications.clone(),
            },
            state_sync_of(&state.snapshot),
        ]
    }

    /// The state.sync for the currently held snapshot (a response guarantee for when the refresh path is unavailable).
    fn current_state_sync(&self) -> ServerMessage {
        state_sync_of(&self.inner.read().unwrap().snapshot)
    }

    /// Manual dismissal (removes only dismissible notifications). Broadcasts notifications.sync
    /// if anything changed. The TS `dismissNotification` (sticky/system notifications are kept).
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

    /// Stores the latest snapshot and broadcasts state.sync to all connections (called by the poller driver).
    pub fn publish_snapshot(&self, snapshot: StateSnapshot) {
        self.inner.write().unwrap().snapshot = snapshot.clone();
        let _ = self.tx.send(state_sync_of(&snapshot));
    }

    /// Stores the settings and broadcasts config.sync to all connections.
    pub fn publish_config(&self, config: ConfigView) {
        let msg = ServerMessage::ConfigSync {
            notify_sound: config.notify_sound,
            debug: config.debug,
            update_check: config.update_check,
            language: config.language.clone(),
        };
        self.inner.write().unwrap().config = config;
        let _ = self.tx.send(msg);
    }

    /// Whether the update check is currently enabled (the live `updateCheck` config flag). The update-check
    /// task reads this each poll so disabling it in config.json stops the github.com egress without a restart (#26).
    pub fn update_check_enabled(&self) -> bool {
        self.inner.read().unwrap().config.update_check
    }

    /// Stores the notification list and broadcasts notifications.sync to all connections.
    pub fn publish_notifications(&self, notifications: Vec<Notification>) {
        let msg = ServerMessage::NotificationsSync {
            items: notifications.clone(),
        };
        self.inner.write().unwrap().notifications = notifications;
        let _ = self.tx.send(msg);
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
    /// connections (the TS `pushNotification` + `notifyNotification`). createdAt is kept
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
    /// connections (the accumulation side of the TS `reportError`). createdAt is kept
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

fn to_text(msg: &ServerMessage) -> Message {
    Message::Text(serde_json::to_string(msg).unwrap_or_default())
}

/// Handles a single control connection. After the three-stage delivery on connect, it runs
/// broadcast forwarding and inbound message processing concurrently.
pub async fn handle_control(mut socket: WebSocket, services: ControlServices) {
    for msg in services.hub.connect_messages() {
        if socket.send(to_text(&msg)).await.is_err() {
            return;
        }
    }

    let mut rx = services.hub.subscribe();
    // The first ping is one interval after connecting, not immediately (like the TS setInterval, the origin is after an interval).
    let mut heartbeat = tokio::time::interval_at(
        tokio::time::Instant::now() + services.heartbeat,
        services.heartbeat,
    );
    // Avoid firing delayed ticks in a burst after send has blocked from backpressure (to preserve the pong grace period).
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut alive = true;
    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                if !alive {
                    break; // No pong returned for the previous interval's ping -> disconnect (the TS terminate).
                }
                alive = false;
                if socket.send(Message::Ping(Vec::new())).await.is_err() {
                    break;
                }
            }
            broadcasted = rx.recv() => match broadcasted {
                Ok(msg) => {
                    if socket.send(to_text(&msg)).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => break,
            },
            incoming = socket.recv() => match incoming {
                // Treat any inbound frame, not just pong, as evidence of liveness (this prevents a
                // false disconnect where the pong's effect loses to the tick under select! branch
                // contention; idle connections are kept alive via ping -> automatic pong).
                Some(Ok(Message::Text(text))) => {
                    alive = true;
                    if !handle_client_message(&mut socket, &services, &text).await {
                        break;
                    }
                }
                Some(Ok(Message::Pong(_))) => alive = true,
                Some(Ok(Message::Close(_))) | None => break,
                // tungstenite automatically returns the pong response to a Ping.
                Some(Ok(_)) => {}
                Some(Err(_)) => break,
            },
        }
    }
}

/// Parses received text as a ClientMessage and dispatches it. Return value = whether the
/// connection should continue. session.new/close and term.* come later (valid but
/// unhandled ones are no-ops).
async fn handle_client_message(
    socket: &mut WebSocket,
    services: &ControlServices,
    text: &str,
) -> bool {
    let msg = match serde_json::from_str::<ClientMessage>(text) {
        Ok(msg) => msg,
        Err(_) => {
            return report_error(socket, &services.hub, "invalid_message", "invalid client message")
                .await;
        }
    };
    match msg {
        // Manual refresh: re-evaluate immediately and always return state.sync to the requester, even if nothing changed.
        ClientMessage::StateRefresh => {
            let snapshot = request_refresh(services).await;
            let reply = snapshot
                .map(|s| state_sync_of(&s))
                .unwrap_or_else(|| services.hub.current_state_sync());
            socket.send(to_text(&reply)).await.is_ok()
        }
        // Remove only dismissible notifications, and broadcast notifications.sync to all connections if anything changed.
        ClientMessage::NotificationDismiss { id } => {
            services.hub.dismiss_notification(&id);
            true
        }
        // Persist the SETTINGS language change to config.json. Rather than trusting the client's
        // zod validation, the server side also allow-list validates ja/en (defense in depth).
        // After writing, deliver to all connections immediately and reliably via publish_config,
        // without depending on the watch's mtime lag or dropped events.
        ClientMessage::ConfigUpdate { language } => {
            if language != "ja" && language != "en" {
                return report_error(
                    socket,
                    &services.hub,
                    "invalid_language",
                    &format!("未対応の言語です: {language}"),
                )
                .await;
            }
            if let Some(path) = &services.config_path {
                if let Err(e) = crate::config::write_config_language(path, &language) {
                    return report_error(
                        socket,
                        &services.hub,
                        "config_write_failed",
                        &format!("config の書き込みに失敗しました: {e}"),
                    )
                    .await;
                }
                services.hub.publish_config(crate::config::read_config(path));
            }
            true
        }
        ClientMessage::SessionNew { org } => handle_session_new(socket, services, &org).await,
        // For owned, the actual entity lives in SessionRegistry, so remove it from the registry.
        // remove aggregates killpg + reap + deregistration and is idempotent even when absent (the bool is discarded).
        ClientMessage::SessionClose { window_id } => {
            services.sessions.remove(&window_id).await;
            trigger_refresh(services).await;
            true
        }
        ClientMessage::TermOpen {
            term_id,
            window_id,
            cols,
            rows,
        } => handle_term_open(socket, services, term_id, window_id, cols, rows).await,
        // Hold the finalized size and, if currently attached, propagate it to the PTY as well (no-op if not attached).
        ClientMessage::TermResize {
            term_id,
            cols,
            rows,
        } => {
            let (cols, rows, _) = clamp_terminal_size(cols, rows);
            if services
                .terms
                .lock()
                .unwrap()
                .set_size(&term_id, cols, rows)
            {
                crate::term_attach_pty::resize_owned_term(
                    services,
                    &term_id,
                    cols as u16,
                    rows as u16,
                )
                .await;
                true
            } else {
                send_unknown_term(socket, &services.hub, &term_id).await
            }
        }
        // Since switching the view changes the window size and visible content, re-evaluate immediately after select.
        // For owned, 1 PTY = 1 window. windowId is the session_id of the switch-target PTY, so
        // rebind that term's registry session_id so that subsequent resize/attach look up the new PTY.
        ClientMessage::TermSelect { term_id, window_id } => {
            if services
                .terms
                .lock()
                .unwrap()
                .rebind_session(&term_id, &window_id)
            {
                trigger_refresh(services).await;
                true
            } else {
                send_unknown_term(socket, &services.hub, &term_id).await
            }
        }
        ClientMessage::TermClose { term_id } => {
            let entry = services.terms.lock().unwrap().take_for_teardown(&term_id);
            match entry {
                // The PTY lifecycle is owned by the SessionRegistry on the SessionClose side, so
                // here we only tear down the term registry (no double-free).
                Some(_) => true,
                None => send_unknown_term(socket, &services.hub, &term_id).await,
            }
        }
        // An ack to an already-closed term is a normal case (no-op). If present, update the flow state.
        ClientMessage::TermAck { term_id, bytes } => {
            services.terms.lock().unwrap().apply_ack(&term_id, bytes);
            true
        }
    }
}

/// Creates a view term and registers it in the registry (the TS handleTermOpen). PTY connection happens via `/ws/term`.
async fn handle_term_open(
    socket: &mut WebSocket,
    services: &ControlServices,
    term_id: String,
    window_id: Option<String>,
    cols: u32,
    rows: u32,
) -> bool {
    // Synchronous reservation to exclude concurrent opens (before any await). Existing/in-progress yields term_exists.
    if !services.terms.lock().unwrap().try_reserve(&term_id) {
        let message = format!("termId {term_id} is already open");
        return report_error(socket, &services.hub, "term_exists", &message).await;
    }
    let (cols, rows, _) = clamp_terminal_size(cols, rows);
    let ok = open_owned_term(socket, services, term_id, window_id, cols, rows).await;
    let Some(()) = ok else {
        return false;
    };
    // As with manual refresh, on success return state.sync to the requester (the TS sendSnapshot).
    let snapshot = request_refresh(services).await;
    let reply = snapshot
        .map(|s| state_sync_of(&s))
        .unwrap_or_else(|| services.hub.current_state_sync());
    socket.send(to_text(&reply)).await.is_ok()
}

/// The owned term.open. Without creating a tmux view session, it puts the windowId (UUID)
/// directly into the term registry's session_id. The PTY was already spawned into SessionRegistry
/// by session.new, and `/ws/term`'s `attach_owned_term` looks it up directly by session_id=windowId
/// (1 PTY = 1 window; there is no select-window). When windowId is unspecified (unselected right
/// after startup), it is registered unbound with an empty session_id and bound later by term.select
/// (the client always sends term.select after attaching). The reservation is already done. Always `Some(())`.
async fn open_owned_term(
    _socket: &mut WebSocket,
    services: &ControlServices,
    term_id: String,
    window_id: Option<String>,
    cols: u32,
    rows: u32,
) -> Option<()> {
    let session_id = window_id.unwrap_or_default();
    services
        .terms
        .lock()
        .unwrap()
        .commit(TermEntry::new(term_id, session_id, cols, rows));
    Some(())
}

/// Validates the org and creates a new session (the TS session.new). Spawns an owned PTY and registers it.
async fn handle_session_new(socket: &mut WebSocket, services: &ControlServices, org: &str) -> bool {
    // Resolve to an owned String before any await: the read guard must not be held across await points.
    let root = {
        let guard = services.repos.read().unwrap();
        let roots: Vec<&str> = guard.roots.iter().map(String::as_str).collect();
        zashiki_core::repos::org_root(org, &roots).map(str::to_string)
    };
    let Some(root) = root else {
        let message = format!("org {org} is not in repos.conf");
        return report_error(socket, &services.hub, "unknown_org", &message).await;
    };
    let name = basename(&root);
    new_owned_session(socket, services, &root, &name).await
}

/// Spawns an owned PTY and registers it in `SessionRegistry` (owned mode). Since the PTY's command
/// itself is set to launch claude, send-keys is unnecessary (symmetric with the tmux version; the
/// canonical spec is `session_launch`'s tests).
async fn new_owned_session(
    socket: &mut WebSocket,
    services: &ControlServices,
    root: &str,
    name: &str,
) -> bool {
    let sid = uuid::Uuid::new_v4().to_string();
    let shell = crate::session_restore::login_shell();
    // A missing cwd falls back to $HOME, and claude is resolved to an absolute path before launch to guard against a thin PATH.
    let cwd = crate::session_launch::resolve_cwd(root);
    let claude = crate::session_launch::resolve_claude_program();
    let plan = crate::session_launch::plan_new_session(
        &sid,
        &cwd,
        name,
        services.launch_claude,
        &shell,
        &claude,
    );
    match services
        .sessions
        .create_with_meta(
            plan.sid.clone(),
            crate::session_launch::plan_to_config(&plan),
            crate::session_launch::plan_to_meta(&plan),
        )
        .await
    {
        Ok(_) => {
            trigger_refresh(services).await;
            true
        }
        Err(err) => fail_session_create(socket, services, &err).await,
    }
}

/// The last segment of a path (org name / window name).
fn basename(path: &str) -> String {
    path.split('/')
        .rfind(|s| !s.is_empty())
        .unwrap_or(path)
        .to_string()
}

/// An immediate re-evaluation after a mutation (fire-and-forget; reflected to all connections via broadcast).
async fn trigger_refresh(services: &ControlServices) {
    let _ = services.refresh.send(RefreshRequest { reply: None }).await;
}

/// Returns `{t:"error"}` (for the ErrorDialog) to the requester while also enqueuing the error
/// notification globally and delivering it to all connections (the TS `reportError`). The id is
/// unique per occurrence (randomUUID).
async fn report_error(socket: &mut WebSocket, hub: &ControlHub, code: &str, message: &str) -> bool {
    hub.record_error(uuid::Uuid::new_v4().to_string(), code, message, crate::now_ms());
    let msg = ServerMessage::Error {
        code: code.to_string(),
        message: message.to_string(),
    };
    socket.send(to_text(&msg)).await.is_ok()
}

async fn send_internal_error(
    socket: &mut WebSocket,
    hub: &ControlHub,
    err: &impl std::fmt::Display,
) -> bool {
    report_error(socket, hub, "internal", &err.to_string()).await
}

async fn send_unknown_term(socket: &mut WebSocket, hub: &ControlHub, term_id: &str) -> bool {
    report_error(socket, hub, "unknown_term", &format!("termId {term_id} is not open")).await
}

/// Returns a creation failure to the requester. If it stems from PTY exhaustion, enqueue a single
/// dedicated sticky warning that prompts action rather than a generic error notification
/// (record_pty_exhaustion aggregates via a fixed id). The dialog is always returned.
async fn fail_session_create(
    socket: &mut WebSocket,
    services: &ControlServices,
    err: &impl std::fmt::Display,
) -> bool {
    let message = err.to_string();
    if crate::notifications::is_pty_exhaustion(&message) {
        services.hub.record_pty_exhaustion(crate::now_ms());
        let msg = ServerMessage::Error {
            code: "internal".to_string(),
            message,
        };
        return socket.send(to_text(&msg)).await.is_ok();
    }
    send_internal_error(socket, &services.hub, err).await
}

/// Requests an immediate re-evaluation from the poller and receives the post-evaluation snapshot (None if the path is down).
async fn request_refresh(services: &ControlServices) -> Option<StateSnapshot> {
    let (tx, rx) = oneshot::channel();
    services
        .refresh
        .send(RefreshRequest { reply: Some(tx) })
        .await
        .ok()?;
    rx.await.ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::SessionInfo;
    use std::collections::BTreeMap;

    fn snapshot_with(window: &str) -> StateSnapshot {
        StateSnapshot {
            sessions: vec![SessionInfo {
                window_id: window.to_string(),
                name: "repo".to_string(),
                org: "org".to_string(),
                repo: "repo".to_string(),
                state: "running".to_string(),
                title: None,
                active: true,
                running_subagents: Some(0),
                limited: false,
            }],
            orgs: vec!["org".to_string()],
            org_colors: BTreeMap::new(),
        }
    }

    #[test]
    fn connect_messages_are_config_notifications_state_in_order() {
        let hub = ControlHub::new(
            ConfigView {
                notify_sound: true,
                debug: false,
                update_check: true,
                language: None,
            },
            vec![],
            snapshot_with("@1"),
        );
        let msgs = hub.connect_messages();
        assert!(matches!(msgs[0], ServerMessage::ConfigSync { .. }));
        assert!(matches!(msgs[1], ServerMessage::NotificationsSync { .. }));
        assert!(matches!(msgs[2], ServerMessage::StateSync { .. }));
    }

    #[tokio::test]
    async fn publish_snapshot_broadcasts_state_sync_to_subscribers() {
        let hub = ControlHub::new(ConfigView::default(), vec![], snapshot_with("@1"));
        let mut rx = hub.subscribe();
        hub.publish_snapshot(snapshot_with("@2"));
        let got = rx.recv().await.unwrap();
        match got {
            ServerMessage::StateSync { sessions, .. } => {
                assert_eq!(sessions[0].window_id, "@2");
            }
            _ => panic!("expected state.sync"),
        }
        // It is also stored and reflected in the initial delivery of the next connection.
        assert!(matches!(
            hub.connect_messages()[2],
            ServerMessage::StateSync { .. }
        ));
    }

    #[tokio::test]
    async fn publish_config_and_notifications_broadcast() {
        let hub = ControlHub::new(ConfigView::default(), vec![], snapshot_with("@1"));
        let mut rx = hub.subscribe();
        hub.publish_config(ConfigView {
            notify_sound: true,
            debug: true,
            update_check: true,
            language: Some("en".into()),
        });
        assert!(matches!(
            rx.recv().await.unwrap(),
            ServerMessage::ConfigSync {
                notify_sound: true,
                debug: true,
                ..
            }
        ));
        hub.publish_notifications(vec![]);
        assert!(matches!(
            rx.recv().await.unwrap(),
            ServerMessage::NotificationsSync { .. }
        ));
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

    // Verifies that term.* works with just the owned PTY registry (a regression test). Confirms over
    // a real WS that no error is returned and that the windowId (UUID) is correctly registered in the
    // registry (so subsequent resize/select do not become unknown_term).
    mod owned_term_registry {
        use super::super::*;
        use crate::status_poller::StateSnapshot;
        use futures_util::{SinkExt, StreamExt};
        use std::collections::BTreeMap;
        use std::sync::{Arc, Mutex};
        use std::time::Duration;
        use tokio_tungstenite::tungstenite::Message as TMsg;

        fn empty_snapshot() -> StateSnapshot {
            StateSnapshot {
                sessions: Vec::new(),
                orgs: Vec::new(),
                org_colors: BTreeMap::new(),
            }
        }

        /// ControlServices for the owned backend (owned PTY registry only).
        async fn owned_services_with_pty(session_id: &str) -> ControlServices {
            let (refresh, rx) = mpsc::channel(8);
            drop(rx); // request_refresh fails and falls back to current_state_sync (sufficient for tests).
            let sessions = Arc::new(crate::session_registry::SessionRegistry::new());
            let mut cmd = portable_pty::CommandBuilder::new("sh");
            cmd.arg("-c");
            cmd.arg("cat");
            cmd.env("TERM", "xterm-256color");
            sessions
                .create(session_id.to_string(), crate::pty_host::PtyConfig::new(cmd))
                .await
                .unwrap();
            ControlServices {
                hub: ControlHub::new(ConfigView::default(), vec![], empty_snapshot()),
                refresh,
                repos: crate::repos::shared_repos(vec![], Default::default()),
                launch_claude: false,
                terms: Arc::new(Mutex::new(TermRegistry::new())),
                sessions,
                heartbeat: Duration::from_secs(30),
                notify_mode: crate::hooks::NotifyMode::Web,
                mac_notify: Arc::new(|_| {}),
                config_path: None,
            }
        }

        async fn serve(services: ControlServices) -> u16 {
            use axum::extract::{State, WebSocketUpgrade};
            use axum::routing::get;
            let app = axum::Router::new()
                .route(
                    "/ws/control",
                    get(
                        |ws: WebSocketUpgrade, State(services): State<ControlServices>| async move {
                            ws.on_upgrade(move |socket| handle_control(socket, services))
                        },
                    ),
                )
                .with_state(services);
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            tokio::spawn(async move {
                axum::serve(listener, app).await.unwrap();
            });
            port
        }

        type Ws = tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >;

        async fn connect(port: u16) -> Ws {
            let url = format!("ws://127.0.0.1:{port}/ws/control");
            let mut ws = tokio_tungstenite::connect_async(&url).await.unwrap().0;
            // Skip the config.sync / notifications.sync / state.sync sent right after connecting.
            for _ in 0..3 {
                let _ = next_json(&mut ws).await;
            }
            ws
        }

        /// Reads the next Text frame as JSON (skipping ping etc.). None on timeout.
        async fn next_json(ws: &mut Ws) -> Option<serde_json::Value> {
            let fut = async {
                loop {
                    match ws.next().await {
                        Some(Ok(TMsg::Text(t))) => {
                            return serde_json::from_str::<serde_json::Value>(&t).ok()
                        }
                        Some(Ok(_)) => continue,
                        _ => return None,
                    }
                }
            };
            tokio::time::timeout(Duration::from_millis(1500), fut)
                .await
                .ok()
                .flatten()
        }

        async fn send(ws: &mut Ws, v: serde_json::Value) {
            ws.send(TMsg::Text(v.to_string())).await.unwrap();
        }

        /// Minimal services for verifying the config.update handler (no PTY needed; only config_path is set).
        fn services_with_config_path(config_path: std::path::PathBuf) -> ControlServices {
            let (refresh, rx) = mpsc::channel(8);
            drop(rx);
            ControlServices {
                hub: ControlHub::new(ConfigView::default(), vec![], empty_snapshot()),
                refresh,
                repos: crate::repos::shared_repos(vec![], Default::default()),
                launch_claude: false,
                terms: Arc::new(Mutex::new(TermRegistry::new())),
                sessions: Arc::new(crate::session_registry::SessionRegistry::new()),
                heartbeat: Duration::from_secs(30),
                notify_mode: crate::hooks::NotifyMode::Web,
                mac_notify: Arc::new(|_| {}),
                config_path: Some(config_path),
            }
        }

        /// config.update: persists language to config.json (preserving existing fields) and
        /// immediately delivers config.sync to all connections via publish_config.
        #[tokio::test]
        async fn config_update_writes_file_and_broadcasts_config_sync() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("config.json");
            std::fs::write(&path, r#"{"notifySound": true, "debug": false}"#).unwrap();
            let port = serve(services_with_config_path(path.clone())).await;
            let mut ws = connect(port).await;

            send(&mut ws, serde_json::json!({"t":"config.update","language":"en"})).await;

            let msg = next_json(&mut ws)
                .await
                .expect("config.sync should be broadcast after config.update");
            assert_eq!(msg["t"], "config.sync");
            assert_eq!(msg["language"], "en");
            // It is also persisted to the file, and existing fields are preserved.
            let c = crate::config::read_config(&path);
            assert_eq!(c.language, Some("en".to_string()));
            assert!(c.notify_sound);
        }

        /// The server side also allow-list validates ja/en (defense in depth against zod bypass).
        #[tokio::test]
        async fn config_update_rejects_unsupported_language() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("config.json");
            let port = serve(services_with_config_path(path.clone())).await;
            let mut ws = connect(port).await;

            send(&mut ws, serde_json::json!({"t":"config.update","language":"fr"})).await;

            let msg = next_json(&mut ws).await.expect("error response");
            assert_eq!(msg["t"], "error");
            assert_eq!(msg["code"], "invalid_language");
            // An invalid value is not written to the file.
            assert!(!path.exists());
        }

        /// The owned term.open does not create a tmux view session, and the next reply is state.sync (not an error).
        #[tokio::test]
        async fn term_open_registers_window_and_sends_state_sync() {
            let services = owned_services_with_pty("sess-1").await;
            let terms = services.terms.clone();
            let port = serve(services).await;
            let mut ws = connect(port).await;

            send(
                &mut ws,
                serde_json::json!({"t":"term.open","termId":"t1","windowId":"sess-1","cols":80,"rows":24}),
            )
            .await;
            let reply = next_json(&mut ws).await.expect("reply");
            assert_eq!(reply["t"], "state.sync", "owned term.open must not error: {reply}");
            // The registry holds the windowId (UUID sid) directly (not a tmux $N).
            assert_eq!(terms.lock().unwrap().session_id("t1").as_deref(), Some("sess-1"));
        }

        /// After the owned term.open, resize/select on the same termId do not become unknown_term.
        #[tokio::test]
        async fn open_then_resize_and_select_are_not_unknown_term() {
            // Also prepare the switch-target PTY (the rebind destination for select).
            let services = owned_services_with_pty("sess-1").await;
            {
                let mut cmd = portable_pty::CommandBuilder::new("sh");
                cmd.arg("-c");
                cmd.arg("cat");
                services
                    .sessions
                    .create("sess-2".to_string(), crate::pty_host::PtyConfig::new(cmd))
                    .await
                    .unwrap();
            }
            let terms = services.terms.clone();
            let port = serve(services).await;
            let mut ws = connect(port).await;

            send(
                &mut ws,
                serde_json::json!({"t":"term.open","termId":"t1","windowId":"sess-1","cols":80,"rows":24}),
            )
            .await;
            assert_eq!(next_json(&mut ws).await.expect("open reply")["t"], "state.sync");

            // On success resize sends no reply (true). Since unknown_term would return an error, we check that "no reply arrives".
            send(
                &mut ws,
                serde_json::json!({"t":"term.resize","termId":"t1","cols":100,"rows":40}),
            )
            .await;
            assert!(
                next_json(&mut ws).await.is_none(),
                "resize on open owned term must not reply (no unknown_term)"
            );

            // On success select is true with no direct reply (state.sync is a broadcast via trigger_refresh,
            // which does not arrive since the test has no poller). We check "no error is returned" and the registry rebind.
            send(
                &mut ws,
                serde_json::json!({"t":"term.select","termId":"t1","windowId":"sess-2"}),
            )
            .await;
            assert!(
                next_json(&mut ws).await.is_none(),
                "owned term.select must not reply an error"
            );
            // The rebind moves the attach target to sess-2.
            assert_eq!(terms.lock().unwrap().session_id("t1").as_deref(), Some("sess-2"));
        }

        /// The owned term.close only tears down the registry (it does not kill the PTY itself).
        #[tokio::test]
        async fn term_close_only_tears_down_registry() {
            let services = owned_services_with_pty("sess-1").await;
            let terms = services.terms.clone();
            let sessions = services.sessions.clone();
            let port = serve(services).await;
            let mut ws = connect(port).await;

            send(
                &mut ws,
                serde_json::json!({"t":"term.open","termId":"t1","windowId":"sess-1","cols":80,"rows":24}),
            )
            .await;
            assert_eq!(next_json(&mut ws).await.expect("open reply")["t"], "state.sync");

            // On success close is true (no reply). Verify unknown_term / internal are not returned.
            send(&mut ws, serde_json::json!({"t":"term.close","termId":"t1"})).await;
            assert!(
                next_json(&mut ws).await.is_none(),
                "owned term.close must not reply an error"
            );
            // It drops from the registry but the PTY remains (the PTY lifecycle is on the SessionClose side).
            assert!(terms.lock().unwrap().session_id("t1").is_none());
            assert!(sessions.get("sess-1").await.is_some());
        }

        /// An owned term.open without windowId registers unbound (empty session_id) and is bound
        /// later by term.select (the client opens with windowId still undetermined right after
        /// startup, then selects after attaching).
        #[tokio::test]
        async fn term_open_without_window_registers_unbound_then_binds_on_select() {
            let services = owned_services_with_pty("sess-1").await;
            let terms = services.terms.clone();
            let port = serve(services).await;
            let mut ws = connect(port).await;
            send(
                &mut ws,
                serde_json::json!({"t":"term.open","termId":"t1","cols":80,"rows":24}),
            )
            .await;
            // state.sync, not an error. It enters the registry unbound (empty string).
            assert_eq!(next_json(&mut ws).await.expect("open reply")["t"], "state.sync");
            assert_eq!(terms.lock().unwrap().session_id("t1").as_deref(), Some(""));

            // term.select binds to the real sid (it does not touch tmux).
            send(
                &mut ws,
                serde_json::json!({"t":"term.select","termId":"t1","windowId":"sess-1"}),
            )
            .await;
            assert!(
                next_json(&mut ws).await.is_none(),
                "owned term.select must not reply an error"
            );
            assert_eq!(terms.lock().unwrap().session_id("t1").as_deref(), Some("sess-1"));
        }
    }
}
