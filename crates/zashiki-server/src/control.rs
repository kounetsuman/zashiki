//! Wiring for `/ws/control` (the JSON control channel). On connect it delivers
//! config.sync -> notifications.sync -> state.sync, and thereafter forwards the shared `ControlHub`'s broadcast to each
//! connection. ClientMessage handles state.refresh (requests an immediate
//! re-evaluation from the poller with a guaranteed response) and notification.dismiss.
//! Dispatch of session.new/close and term.* plus heartbeat come later.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket};
use tokio::sync::{broadcast, mpsc, oneshot};

/// The ping interval for WS liveness monitoring.
/// A ping is sent after one interval with no response, and the connection is dropped if
/// no pong returns before the next interval (effective timeout is one to two intervals).
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);

pub use crate::control_hub::{ActivitySummary, ControlHub};
pub(crate) use crate::control_dispatch::{
    fail_session_create, report_error, request_refresh, trigger_refresh,
};

use crate::protocol::ServerMessage;
use crate::status_poller::StateSnapshot;
use crate::term_registry::TermRegistry;

/// Live-applied settings (the config.sync payload).
#[derive(Debug, Clone, Default)]
pub struct ConfigView {
    pub notify_sound: bool,
    /// Whether the server may poll GitHub Releases for updates (#26). Default on; set false in config.json
    /// to stop the outbound egress to github.com. Checked live per poll, so toggling applies without restart.
    pub update_check: bool,
    /// Display language ("ja"/"en"). None when unset, delegating to the client's browser detection.
    pub language: Option<String>,
    /// Opt-in for the self-contained account-usage bridge. Default off; when on, launches inject
    /// `--settings` so claude's statusLine relays rate_limits to the server without touching user settings.
    pub account_usage: bool,
    /// External editor command for `POST /api/git/open` (SETTINGS). None when unset, falling back to
    /// `ZK_EDITOR` then `cursor -g`. Read live per open, so a change applies without a restart.
    pub editor: Option<String>,
    /// Status-footer severity thresholds (SETTINGS). Defaults reproduce the built-in bands.
    pub footer_thresholds: crate::protocol::FooterThresholds,
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
    /// Whether session.new launches `claude --session-id <uuid>`.
    pub launch_claude: bool,
    /// The registry of view terms that term.* refers to.
    pub terms: Arc<Mutex<TermRegistry>>,
    /// The owned PTY registry. `attach_owned_term` looks it up by session_id.
    pub sessions: Arc<crate::session_registry::SessionRegistry>,
    /// The shared last-hook-event store. The hook route writes it; the poller reads it via
    /// `PollerPorts::last_hook_event` for event-authoritative state.
    pub hook_events: Arc<crate::hook_event_store::HookEventStore>,
    /// The ping interval for WS liveness monitoring (default `HEARTBEAT_INTERVAL`; tests shorten it).
    pub heartbeat: Duration,
    /// The destination for hooks notifications (ZK_NOTIFY; default web).
    pub notify_mode: crate::hooks::NotifyMode,
    /// The executor for macOS notifications (default terminal-notifier; swapped out in tests).
    pub mac_notify: crate::hooks::MacNotify,
    /// The path to config.json (the write target for SETTINGS' config.update; None for tests etc.).
    pub config_path: Option<std::path::PathBuf>,
    /// The ~/.claude/settings.json + bundled hooks-dir locations for the hooks.register/unregister
    /// handlers. None disables the feature (tests that don't exercise it).
    pub claude_settings: Option<crate::claude_settings_io::ClaudeSettingsPaths>,
    /// Parsed running app version for the on-demand "Check for updates" (SETTINGS). None (dev /
    /// placeholder / unparseable) means the manual check reports it can't determine the version.
    pub app_version: Option<semver::Version>,
}

pub(crate) fn to_text(msg: &ServerMessage) -> Message {
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
    // The first ping is one interval after connecting, not immediately.
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
                    break; // No pong returned for the previous interval's ping -> disconnect.
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
                    if !crate::control_dispatch::handle_client_message(&mut socket, &services, &text).await {
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

#[cfg(test)]
mod tests {
    // Verifies that term.* works with just the owned PTY registry (a regression test). Confirms over
    // a real WS that no error is returned and that the cockpitTerminalId (UUID) is correctly registered in the
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
                org_aliases: BTreeMap::new(),
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
                repos: crate::repos::shared_repos(vec![], Default::default(), Default::default()),
                launch_claude: false,
                terms: Arc::new(Mutex::new(TermRegistry::new())),
                sessions,
                hook_events: Arc::new(crate::hook_event_store::HookEventStore::new()),
                heartbeat: Duration::from_secs(30),
                notify_mode: crate::hooks::NotifyMode::Web,
                mac_notify: Arc::new(|_| {}),
                config_path: None,
                claude_settings: None,
                app_version: None,
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
            // Skip the config.sync / notifications.sync / state.sync / hooks.status / notes.sync sent right after connecting.
            for _ in 0..5 {
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
                repos: crate::repos::shared_repos(vec![], Default::default(), Default::default()),
                launch_claude: false,
                terms: Arc::new(Mutex::new(TermRegistry::new())),
                sessions: Arc::new(crate::session_registry::SessionRegistry::new()),
                hook_events: Arc::new(crate::hook_event_store::HookEventStore::new()),
                heartbeat: Duration::from_secs(30),
                notify_mode: crate::hooks::NotifyMode::Web,
                mac_notify: Arc::new(|_| {}),
                config_path: Some(config_path),
                claude_settings: None,
                app_version: None,
            }
        }

        fn services_with_claude_settings(settings_path: std::path::PathBuf) -> ControlServices {
            let (refresh, rx) = mpsc::channel(8);
            drop(rx);
            ControlServices {
                hub: ControlHub::new(ConfigView::default(), vec![], empty_snapshot()),
                refresh,
                repos: crate::repos::shared_repos(vec![], Default::default(), Default::default()),
                launch_claude: false,
                terms: Arc::new(Mutex::new(TermRegistry::new())),
                sessions: Arc::new(crate::session_registry::SessionRegistry::new()),
                hook_events: Arc::new(crate::hook_event_store::HookEventStore::new()),
                heartbeat: Duration::from_secs(30),
                notify_mode: crate::hooks::NotifyMode::Web,
                mac_notify: Arc::new(|_| {}),
                config_path: None,
                claude_settings: Some(crate::claude_settings_io::ClaudeSettingsPaths {
                    settings_path,
                    hooks_dir: std::path::PathBuf::from("/opt/zashiki/hooks"),
                }),
                app_version: None,
            }
        }

        /// hooks.register writes the integration into settings.json and broadcasts hooks.status;
        /// hooks.unregister reverses it. The pure merge is covered in `claude_settings`; here we pin
        /// the WS round-trip and the file effect.
        #[tokio::test]
        async fn hooks_register_and_unregister_round_trip() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("settings.json");
            let port = serve(services_with_claude_settings(path.clone())).await;
            let mut ws = connect(port).await;

            send(&mut ws, serde_json::json!({ "t": "hooks.register" })).await;
            let msg = next_json(&mut ws).await.expect("hooks.status after register");
            assert_eq!(msg["t"], "hooks.status");
            assert_eq!(msg["hooksRegistered"], true);
            assert_eq!(msg["statusLineRegistered"], true);
            assert!(path.exists());

            send(&mut ws, serde_json::json!({ "t": "hooks.unregister" })).await;
            let msg = next_json(&mut ws).await.expect("hooks.status after unregister");
            assert_eq!(msg["hooksRegistered"], false);
            assert_eq!(msg["statusLineRegistered"], false);
        }

        /// config.update: persists language to config.json (preserving existing fields) and
        /// immediately delivers config.sync to all connections via publish_config.
        #[tokio::test]
        async fn config_update_writes_file_and_broadcasts_config_sync() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("config.json");
            std::fs::write(&path, r#"{"notifySound": true}"#).unwrap();
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

        /// config.setEditor: persists the editor command to config.json (preserving existing fields)
        /// and immediately broadcasts config.sync carrying the new value.
        #[tokio::test]
        async fn config_set_editor_writes_file_and_broadcasts_config_sync() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("config.json");
            std::fs::write(&path, r#"{"notifySound": true}"#).unwrap();
            let port = serve(services_with_config_path(path.clone())).await;
            let mut ws = connect(port).await;

            send(&mut ws, serde_json::json!({"t":"config.setEditor","editor":"  code -w  "})).await;

            let msg = next_json(&mut ws)
                .await
                .expect("config.sync should be broadcast after config.setEditor");
            assert_eq!(msg["t"], "config.sync");
            assert_eq!(msg["editor"], "code -w"); // trimmed
            let c = crate::config::read_config(&path);
            assert_eq!(c.editor, Some("code -w".to_string()));
            assert!(c.notify_sound); // existing fields are preserved

            // A blank value clears it back to unset (config.sync carries null).
            send(&mut ws, serde_json::json!({"t":"config.setEditor","editor":"   "})).await;
            let msg = next_json(&mut ws).await.expect("config.sync after clear");
            assert!(msg["editor"].is_null());
            assert_eq!(crate::config::read_config(&path).editor, None);
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

        /// The owned term.open registers the window and replies with state.sync (not an error).
        #[tokio::test]
        async fn term_open_registers_window_and_sends_state_sync() {
            let services = owned_services_with_pty("sess-1").await;
            let terms = services.terms.clone();
            let port = serve(services).await;
            let mut ws = connect(port).await;

            send(
                &mut ws,
                serde_json::json!({"t":"term.open","termId":"t1","cockpitTerminalId":"sess-1","cols":80,"rows":24}),
            )
            .await;
            let reply = next_json(&mut ws).await.expect("reply");
            assert_eq!(reply["t"], "state.sync", "owned term.open must not error: {reply}");
            // The registry holds the cockpitTerminalId (UUID sid) directly.
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
                serde_json::json!({"t":"term.open","termId":"t1","cockpitTerminalId":"sess-1","cols":80,"rows":24}),
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
                serde_json::json!({"t":"term.select","termId":"t1","cockpitTerminalId":"sess-2"}),
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
                serde_json::json!({"t":"term.open","termId":"t1","cockpitTerminalId":"sess-1","cols":80,"rows":24}),
            )
            .await;
            assert_eq!(next_json(&mut ws).await.expect("open reply")["t"], "state.sync");

            // On success close is true (no reply). Verify unknown_term / internal are not returned.
            send(&mut ws, serde_json::json!({"t":"term.close","termId":"t1"})).await;
            assert!(
                next_json(&mut ws).await.is_none(),
                "owned term.close must not reply an error"
            );
            // It drops from the registry but the PTY remains (the PTY lifecycle is on the CockpitTerminalClose side).
            assert!(terms.lock().unwrap().session_id("t1").is_none());
            assert!(sessions.get("sess-1").await.is_some());
        }

        /// An owned term.open without cockpitTerminalId registers unbound (empty session_id) and is bound
        /// later by term.select (the client opens with cockpitTerminalId still undetermined right after
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

            // term.select binds to the real sid.
            send(
                &mut ws,
                serde_json::json!({"t":"term.select","termId":"t1","cockpitTerminalId":"sess-1"}),
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
