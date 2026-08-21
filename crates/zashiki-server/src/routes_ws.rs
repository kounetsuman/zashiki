use axum::{
    extract::{Path, State, WebSocketUpgrade},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};

use crate::app_state::AppState;
use crate::{control, term_attach_pty};

/// Upgrade for `/ws/control`. The token has already been handled by the require_token middleware.
pub(crate) async fn ws_control(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    match state.control.clone() {
        Some(services) => ws.on_upgrade(move |socket| control::handle_control(socket, services)),
        None => (StatusCode::NOT_FOUND, "control not available").into_response(),
    }
}

/// Upgrade for `/ws/term/<termId>`. If the termId was term.open'd, it is resolved in the registry and a PTY is attached
/// (unregistered ones get close 4404). The token has already been handled by the require_token middleware.
pub(crate) async fn ws_term(
    ws: WebSocketUpgrade,
    Path(term_id): Path<String>,
    State(state): State<AppState>,
) -> Response {
    match state.control.clone() {
        Some(services) => ws
            .on_upgrade(move |socket| term_attach_pty::attach_owned_term(socket, term_id, services)),
        None => (StatusCode::NOT_FOUND, "control not available").into_response(),
    }
}

/// `POST /api/focus`. Resolves the window (sid then cwd) and broadcasts a `select` so an
/// In-flight work counts for the desktop shell's guarded quit. Zeros when control is unavailable
/// (REST-only), so an unreachable session model never traps the user in the app.
pub(crate) async fn activity(State(state): State<AppState>) -> Json<crate::control::ActivitySummary> {
    Json(
        state
            .control
            .as_ref()
            .map(|c| c.hub.activity_summary())
            .unwrap_or_default(),
    )
}

// ---- /ws/control wiring (connectivity via a real WS client) ----

#[cfg(test)]
mod ws_control_tests {
    use crate::control::{ConfigView, ControlHub, ControlServices};
    use crate::protocol::{Notification, NotificationLevel};
    use crate::runtime::{spawn_control_runtime, ControlRuntimeConfig};
    use crate::status_poller::StateSnapshot;
    use crate::term_registry::{TermEntry, TermRegistry};
    use crate::{build_router, ServerConfig};
    use futures_util::{SinkExt, StreamExt};
    use std::collections::BTreeMap;
    use std::sync::Arc;
    use tokio_tungstenite::tungstenite::Message as TMsg;

    fn snapshot(window: &str) -> StateSnapshot {
        StateSnapshot {
            sessions: vec![crate::protocol::CockpitTerminalInfo {
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
        }
    }

    /// Owned services without a poller. Since the refresh rx is dropped, state.refresh becomes a fallback response.
    fn test_services(hub: Arc<ControlHub>, repos_roots: Vec<String>) -> ControlServices {
        let (refresh, rx) = tokio::sync::mpsc::channel(8);
        drop(rx);
        ControlServices {
            hub,
            refresh,
            repos: crate::repos::shared_repos(repos_roots, Default::default()),
            launch_claude: false,
            terms: Arc::new(std::sync::Mutex::new(TermRegistry::new())),
            sessions: Arc::new(crate::session_registry::SessionRegistry::new()),
            heartbeat: crate::control::HEARTBEAT_INTERVAL,
            notify_mode: crate::hooks::NotifyMode::Web,
            mac_notify: std::sync::Arc::new(|_| {}),
            config_path: None,
            app_version: None,
        }
    }

    async fn serve(control: Option<ControlServices>) -> u16 {
        let app = build_router(ServerConfig {
            expected_token: Some("t".to_string()),
            control,
            ..Default::default()
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        port
    }

    async fn connect(
        port: u16,
    ) -> tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    > {
        let url = format!("ws://127.0.0.1:{port}/ws/control?token=t");
        tokio_tungstenite::connect_async(&url).await.unwrap().0
    }

    async fn next_text<S>(ws: &mut S) -> String
    where
        S: StreamExt<Item = Result<TMsg, tokio_tungstenite::tungstenite::Error>> + Unpin,
    {
        loop {
            match ws.next().await.expect("stream ended").expect("ws error") {
                TMsg::Text(t) => return t.to_string(),
                _ => continue,
            }
        }
    }

    /// Reads the next error frame. Since an error also accumulates into NOTIFICATION and comes with a
    /// notifications.sync, the notifications.sync interleaved in between is skipped.
    async fn next_error_text<S>(ws: &mut S) -> String
    where
        S: StreamExt<Item = Result<TMsg, tokio_tungstenite::tungstenite::Error>> + Unpin,
    {
        loop {
            let t = next_text(ws).await;
            if !t.contains(r#""t":"notifications.sync""#) {
                return t;
            }
        }
    }

    /// Skips the 3 stages sent on connect (config/notifications/state).
    async fn drain_handshake<S>(ws: &mut S)
    where
        S: StreamExt<Item = Result<TMsg, tokio_tungstenite::tungstenite::Error>> + Unpin,
    {
        for _ in 0..3 {
            next_text(ws).await;
        }
    }

    fn session_info(state: &str, subagents: Option<u32>, shells: Option<u32>) -> crate::protocol::CockpitTerminalInfo {
        crate::protocol::CockpitTerminalInfo {
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

    #[tokio::test]
    async fn activity_endpoint_reports_snapshot_counts() {
        use axum::body::{to_bytes, Body};
        use axum::http::Request as HttpRequest;
        use tower::ServiceExt;

        let snapshot = StateSnapshot {
            sessions: vec![
                session_info("running", Some(0), None),
                session_info("running_bg_agent", Some(2), None),
                session_info("idle", None, Some(1)),
            ],
            orgs: vec![],
            org_colors: BTreeMap::new(),
        };
        let hub = ControlHub::new(ConfigView::default(), vec![], snapshot);
        let app = build_router(ServerConfig {
            expected_token: Some("t".to_string()),
            control: Some(test_services(hub, vec![])),
            ..Default::default()
        });
        let resp = app
            .oneshot(
                HttpRequest::builder()
                    .uri("/api/activity")
                    .header("host", "127.0.0.1:8790")
                    .header("x-zashiki-token", "t")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let body = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(body.contains(r#""activeSessions":2"#), "{body}");
        assert!(body.contains(r#""runningSubagents":2"#), "{body}");
        assert!(body.contains(r#""backgroundShells":1"#), "{body}");
    }

    #[tokio::test]
    async fn handshake_sends_config_notifications_state_then_broadcasts() {
        let hub = ControlHub::new(
            ConfigView {
                notify_sound: true,
                debug: false,
                update_check: true,
                language: None,
                account_usage: false,
            },
            vec![],
            snapshot("@1"),
        );
        let port = serve(Some(test_services(hub.clone(), vec![]))).await;
        let mut ws = connect(port).await;

        assert!(next_text(&mut ws).await.contains(r#""t":"config.sync""#));
        assert!(next_text(&mut ws)
            .await
            .contains(r#""t":"notifications.sync""#));
        let state = next_text(&mut ws).await;
        assert!(state.contains(r#""t":"state.sync""#) && state.contains("@1"));

        // An invalid message -> error response. The error also accumulates into NOTIFICATION.
        ws.send(TMsg::Text("not json".to_string())).await.unwrap();
        let err = next_text(&mut ws).await;
        assert!(err.contains(r#""t":"error""#) && err.contains("invalid_message"));
        let notif = next_text(&mut ws).await;
        assert!(
            notif.contains(r#""t":"notifications.sync""#)
                && notif.contains(r#""level":"error""#)
                && notif.contains("invalid_message"),
            "error must also accumulate into NOTIFICATION: {notif}"
        );

        // The hub's publish flows to the connection.
        hub.publish_snapshot(snapshot("@9"));
        let pushed = next_text(&mut ws).await;
        assert!(pushed.contains(r#""t":"state.sync""#) && pushed.contains("@9"));
    }

    #[tokio::test]
    async fn upgrade_without_token_is_rejected() {
        let hub = ControlHub::new(ConfigView::default(), vec![], snapshot("@1"));
        let port = serve(Some(test_services(hub, vec![]))).await;
        let url = format!("ws://127.0.0.1:{port}/ws/control");
        assert!(tokio_tungstenite::connect_async(&url).await.is_err());
    }

    #[tokio::test]
    async fn state_refresh_replies_with_state_sync_via_poller() {
        let tmp = tempfile::tempdir().unwrap();
        let services = spawn_control_runtime(ControlRuntimeConfig {
            projects_root: tmp.path().to_path_buf(),
            repos_roots: vec!["/repos/charlie".to_string()],
            org_colors: std::collections::BTreeMap::new(),
            repos_conf: None,
            poll_sec: 60.0, // Slow the periodic tick so the response comes via the refresh path.
            run_marker: None,
            bg_agent_marker: None,
            limit_marker: None,
            launch_claude: false,
            config: ConfigView::default(),
            config_path: None,
            notify_mode: crate::hooks::NotifyMode::Web,
            mac_notify: std::sync::Arc::new(|_| {}),
            app_version: None,
        });
        let port = serve(Some(services)).await;
        let mut ws = connect(port).await;
        drain_handshake(&mut ws).await;

        ws.send(TMsg::Text(r#"{"t":"state.refresh"}"#.to_string()))
            .await
            .unwrap();
        let reply = next_text(&mut ws).await;
        assert!(reply.contains(r#""t":"state.sync""#) && reply.contains("charlie"));
    }

    /// session.new registers the owned PTY into the `SessionRegistry`. Without this, the poller keeps seeing empty.
    #[cfg(unix)]
    #[tokio::test]
    async fn owned_session_new_registers_pty_in_registry() {
        use std::time::Duration;

        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        let org = std::path::Path::new(&root)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();

        let hub = ControlHub::new(ConfigView::default(), vec![], snapshot("@1"));
        let services = test_services(hub, vec![root.clone()]);
        let sessions = services.sessions.clone();
        let port = serve(Some(services)).await;
        let mut ws = connect(port).await;
        drain_handshake(&mut ws).await;

        ws.send(TMsg::Text(format!(r#"{{"t":"cockpitTerminal.new","org":"{org}"}}"#)))
            .await
            .unwrap();

        let registered = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if sessions.len().await == 1 {
                    return true;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap_or(false);
        assert!(
            registered,
            "owned session.new should register a PTY in SessionRegistry"
        );
    }

    #[tokio::test]
    async fn state_refresh_falls_back_when_poller_absent() {
        let hub = ControlHub::new(ConfigView::default(), vec![], snapshot("@7"));
        let port = serve(Some(test_services(hub, vec![]))).await;
        let mut ws = connect(port).await;
        drain_handshake(&mut ws).await;

        ws.send(TMsg::Text(r#"{"t":"state.refresh"}"#.to_string()))
            .await
            .unwrap();
        let reply = next_text(&mut ws).await;
        assert!(reply.contains(r#""t":"state.sync""#) && reply.contains("@7"));
    }

    #[tokio::test]
    async fn notification_dismiss_removes_dismissible_and_broadcasts() {
        let notif = Notification {
            id: "n1".to_string(),
            level: NotificationLevel::Info,
            title: "t".to_string(),
            body: None,
            created_at: 1,
            sticky: false,
            dismissible: true,
            toast: None,
        };
        let hub = ControlHub::new(ConfigView::default(), vec![notif], snapshot("@1"));
        let port = serve(Some(test_services(hub, vec![]))).await;
        let mut ws = connect(port).await;
        drain_handshake(&mut ws).await;

        ws.send(TMsg::Text(
            r#"{"t":"notification.dismiss","id":"n1"}"#.to_string(),
        ))
        .await
        .unwrap();
        let synced = next_text(&mut ws).await;
        assert!(synced.contains(r#""t":"notifications.sync""#) && !synced.contains("\"n1\""));
    }

    #[tokio::test]
    async fn heartbeat_keeps_responsive_client_connected() {
        let hub = ControlHub::new(ConfigView::default(), vec![], snapshot("@1"));
        let mut services = test_services(hub, vec![]);
        services.heartbeat = std::time::Duration::from_millis(60);
        let port = serve(Some(services)).await;
        let mut ws = connect(port).await;
        drain_handshake(&mut ws).await;

        // Keep reading = tungstenite auto-pongs each ping. Reading past 2 cycles (120ms) without
        // being disconnected = alive. If close/EOF arrives, inner returns and the timeout is Ok.
        let mut saw_ping = false;
        let outcome = tokio::time::timeout(std::time::Duration::from_millis(220), async {
            loop {
                match ws.next().await {
                    None | Some(Err(_)) => break false,
                    Some(Ok(TMsg::Close(_))) => break false,
                    Some(Ok(TMsg::Ping(_))) => {
                        saw_ping = true; // Evidence that heartbeat actually sends pings.
                        continue;
                    }
                    Some(Ok(_)) => continue,
                }
            }
        })
        .await;
        assert!(
            outcome.is_err(),
            "responsive client must stay connected across heartbeat cycles, got {outcome:?}"
        );
        assert!(saw_ping, "server must actually emit heartbeat pings");
    }

    #[tokio::test]
    async fn heartbeat_disconnects_silent_client() {
        let hub = ControlHub::new(ConfigView::default(), vec![], snapshot("@1"));
        let mut services = test_services(hub, vec![]);
        services.heartbeat = std::time::Duration::from_millis(60);
        let port = serve(Some(services)).await;
        let mut ws = connect(port).await;
        drain_handshake(&mut ws).await;

        // Not reading = not returning pongs. The server pings after 1 cycle and, with no pong by the next
        // cycle, disconnects (~2 cycles = 120ms). Wait 3+ cycles, then read and confirm close/EOF.
        tokio::time::sleep(std::time::Duration::from_millis(220)).await;
        let closed = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                match ws.next().await {
                    None | Some(Err(_)) => break true,
                    Some(Ok(TMsg::Close(_))) => break true,
                    Some(Ok(_)) => continue, // Skip buffered pings etc.
                }
            }
        })
        .await
        .expect("silent client should be disconnected by heartbeat");
        assert!(closed);
    }

    #[tokio::test]
    async fn session_new_rejects_unknown_org() {
        let hub = ControlHub::new(ConfigView::default(), vec![], snapshot("@1"));
        // Empty repos_roots -> every org is unknown. It's rejected by org verification and never reaches session creation.
        let port = serve(Some(test_services(hub, vec![]))).await;
        let mut ws = connect(port).await;
        drain_handshake(&mut ws).await;

        ws.send(TMsg::Text(
            r#"{"t":"cockpitTerminal.new","org":"nope"}"#.to_string(),
        ))
        .await
        .unwrap();
        let err = next_text(&mut ws).await;
        assert!(err.contains(r#""t":"error""#) && err.contains("unknown_org"));
    }

    #[tokio::test]
    async fn term_open_on_existing_term_is_term_exists() {
        let hub = ControlHub::new(ConfigView::default(), vec![], snapshot("@1"));
        let services = test_services(hub, vec![]);
        // An already-registered term is rejected by the term_exists check without touching the PTY.
        services.terms.lock().unwrap().commit(TermEntry::new(
            "t1".to_string(),
            "$1".to_string(),
            80,
            24,
        ));
        let port = serve(Some(services)).await;
        let mut ws = connect(port).await;
        drain_handshake(&mut ws).await;

        ws.send(TMsg::Text(
            r#"{"t":"term.open","termId":"t1","cols":80,"rows":24}"#.to_string(),
        ))
        .await
        .unwrap();
        let err = next_text(&mut ws).await;
        assert!(err.contains(r#""t":"error""#) && err.contains("term_exists"));
    }

    #[tokio::test]
    async fn term_ops_on_unknown_term_are_unknown_term() {
        let hub = ControlHub::new(ConfigView::default(), vec![], snapshot("@1"));
        let port = serve(Some(test_services(hub, vec![]))).await;
        let mut ws = connect(port).await;
        drain_handshake(&mut ws).await;

        for msg in [
            r#"{"t":"term.resize","termId":"x","cols":80,"rows":24}"#,
            r#"{"t":"term.select","termId":"x","cockpitTerminalId":"@2"}"#,
            r#"{"t":"term.close","termId":"x"}"#,
        ] {
            ws.send(TMsg::Text(msg.to_string())).await.unwrap();
            let err = next_error_text(&mut ws).await;
            assert!(
                err.contains(r#""t":"error""#) && err.contains("unknown_term"),
                "expected unknown_term for {msg}, got {err}"
            );
        }
    }

    #[tokio::test]
    async fn ws_term_unknown_term_closes_4404() {
        let hub = ControlHub::new(ConfigView::default(), vec![], snapshot("@1"));
        let port = serve(Some(test_services(hub, vec![]))).await;
        let url = format!("ws://127.0.0.1:{port}/ws/term/nope?token=t");
        let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
        // An unregistered termId gets close(4404) on the first frame.
        match ws.next().await.expect("frame").expect("ws ok") {
            TMsg::Close(Some(frame)) => assert_eq!(u16::from(frame.code), 4404),
            other => panic!("expected close 4404, got {other:?}"),
        }
    }

    /// Smoke test that `/ws/term` bridges to the owned PTY. Checks that content written to the owned PTY's
    /// screen beforehand reaches the WS via the initial replay (redraw sequence) **without sending any input**.
    /// (Input echo can't serve as an identifier, since the PTY line discipline reflects it in the kernel.)
    #[tokio::test]
    async fn ws_term_replays_owned_pty_screen() {
        use crate::pty_host::PtyConfig;
        use portable_pty::CommandBuilder;
        use std::time::Duration;

        let hub = ControlHub::new(ConfigView::default(), vec![], snapshot("@1"));
        let services = test_services(hub, vec![]);
        let mut cmd = CommandBuilder::new("sh");
        cmd.arg("-c");
        cmd.arg("cat");
        cmd.env("TERM", "xterm-256color");
        services
            .sessions
            .create("sess-owned".to_string(), PtyConfig::new(cmd))
            .await
            .unwrap();
        // Draw a marker onto the owned PTY's screen (cat echoes it -> reflected onto the vt100 screen).
        let session = services.sessions.get("sess-owned").await.unwrap();
        session.write_input(b"OWNED-REPLAY\n").unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(session.screen_contents().contains("OWNED-REPLAY"));

        services.terms.lock().unwrap().commit(TermEntry::new(
            "owned".to_string(),
            "sess-owned".to_string(),
            80,
            24,
        ));
        let port = serve(Some(services)).await;

        let result = async {
            let url = format!("ws://127.0.0.1:{port}/ws/term/owned?token=t");
            let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
            // Send no input. If the marker arrives from the initial replay alone, it's the owned PTY path.
            loop {
                match ws.next().await {
                    Some(Ok(TMsg::Binary(b)))
                        if String::from_utf8_lossy(&b).contains("OWNED-REPLAY") =>
                    {
                        break true
                    }
                    Some(Ok(_)) => continue,
                    _ => break false,
                }
            }
        };
        let replayed = tokio::time::timeout(Duration::from_secs(5), result)
            .await
            .unwrap_or(false);
        assert!(replayed, "expected owned PTY screen replay over /ws/term");
    }
}
