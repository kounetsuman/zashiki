use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};

use crate::app_state::{now_ms, AppState};
use crate::control::ControlServices;
use crate::hooks;
use crate::wire_support::{json_error, parse_json_body};

// ---- Claude Code hooks intake REST ----

/// Requests an immediate re-evaluation from the poller and receives the post-evaluation snapshot
/// (None on no response). Used for the mac notification body (session title).
async fn hooks_refresh(control: &ControlServices) -> Option<crate::status_poller::StateSnapshot> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    if control
        .refresh
        .send(crate::control::RefreshRequest { reply: Some(tx) })
        .await
        .is_err()
    {
        return None;
    }
    rx.await.ok()
}

/// Resolves the window for a hook event / focus request from the work window list and the ps snapshot.
/// The window is derived from the owned PTY's SessionRegistry.
async fn hooks_resolve(
    control: &ControlServices,
    sid: Option<&str>,
    cwd: Option<&str>,
) -> Option<hooks::ResolvedWindow> {
    let windows = crate::poller_ports_pty::owned_work_windows(&control.sessions).await;
    let ps = crate::ps::PsAdapter.snapshot().await;
    hooks::resolve_window(sid, cwd, &windows, &ps)
}

/// `POST /api/hooks/event`. refresh -> window resolution -> delivery (notify push / macOS) / accumulation / git.dirty.
/// Does not return 500 even if the window can't be resolved (the hook side is fire-and-forget).
pub(crate) async fn hooks_event(State(state): State<AppState>, body: axum::body::Bytes) -> Response {
    let Some(control) = state.control.as_ref() else {
        return json_error(StatusCode::SERVICE_UNAVAILABLE, "control not available");
    };
    let req: crate::protocol::HookEventRequest = match parse_json_body(&body) {
        Ok(v) => v,
        Err((status, msg)) => return json_error(status, &msg),
    };

    let snap = hooks_refresh(control).await;
    let resolved = match req.kind {
        crate::protocol::HookKind::Waiting | crate::protocol::HookKind::Done => {
            hooks_resolve(control, req.sid.as_deref(), req.cwd.as_deref()).await
        }
        _ => None,
    };
    let snap_title = resolved.as_ref().and_then(|r| {
        snap.as_ref()?
            .sessions
            .iter()
            .find(|s| s.cockpit_terminal_id == r.cockpit_terminal_id)
            .and_then(|s| s.title.clone())
    });
    let actions = hooks::decide(
        req.kind,
        resolved.as_ref(),
        control.notify_mode,
        control.hub.client_count(),
        snap_title,
    );

    if actions.git_dirty {
        control.hub.broadcast(crate::protocol::ServerMessage::GitDirty);
    }
    if let Some((kind, name)) = actions.record {
        control
            .hub
            .record_activity(uuid::Uuid::new_v4().to_string(), kind, &name, now_ms());
    }
    if let Some((kind, cockpit_terminal_id, title)) = actions.push {
        control.hub.broadcast(crate::protocol::ServerMessage::Notify {
            kind,
            cockpit_terminal_id,
            title,
        });
    }
    if let Some(mac) = actions.mac {
        (control.mac_notify)(mac);
    }

    Json(crate::protocol::HookEventResponse {
        ok: true,
        matched: actions.matched,
    })
    .into_response()
}

/// `POST /api/hooks/statusline`. Receives Claude Code's statusLine payload (which carries
/// `rate_limits`, unavailable from the transcript) and records the account usage limits per sid so
/// the session footer can show them. Confluence, not replacement: never fails Claude Code.
pub(crate) async fn hooks_statusline(
    State(state): State<AppState>,
    body: axum::body::Bytes,
) -> Response {
    let Some(control) = state.control.as_ref() else {
        return json_error(StatusCode::SERVICE_UNAVAILABLE, "control not available");
    };
    let json: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return json_error(StatusCode::BAD_REQUEST, "invalid json"),
    };
    let matched = match crate::hooks::parse_statusline_limits(&json) {
        Some((sid, limits)) => {
            control.hub.publish_rate_limits(&sid, limits, now_ms());
            true
        }
        None => false,
    };
    Json(crate::protocol::HookEventResponse { ok: true, matched }).into_response()
}

/// already-connected app brings that session to the front. The response reports whether it
/// resolved (and to which window) so the caller can decide how to raise the native window.
pub(crate) async fn focus_session(
    State(state): State<AppState>,
    body: axum::body::Bytes,
) -> Response {
    let Some(control) = state.control.as_ref() else {
        return json_error(StatusCode::SERVICE_UNAVAILABLE, "control not available");
    };
    let req: crate::protocol::FocusRequest = match parse_json_body(&body) {
        Ok(v) => v,
        Err((status, msg)) => return json_error(status, &msg),
    };

    let cockpit_terminal_id = hooks_resolve(control, req.sid.as_deref(), req.cwd.as_deref())
        .await
        .map(|r| r.cockpit_terminal_id);
    if let Some(cockpit_terminal_id) = cockpit_terminal_id.clone() {
        control
            .hub
            .broadcast(crate::protocol::ServerMessage::Select { cockpit_terminal_id });
    }

    Json(crate::protocol::FocusResponse {
        resolved: cockpit_terminal_id.is_some(),
        cockpit_terminal_id,
    })
    .into_response()
}

// ---- hooks/event REST wiring (owned control + in-process HTTP) ----

#[cfg(test)]
mod hooks_rest_tests {
    const OK_HOST: &str = "127.0.0.1:8790";
    use crate::control::{ConfigView, ControlHub, ControlServices};
    use crate::hooks::{MacNotification, NotifyMode};
    use crate::protocol::ServerMessage;
    use crate::session_registry::SessionRegistry;
    use crate::status_poller::StateSnapshot;
    use crate::term_registry::TermRegistry;
    use crate::{build_router, ServerConfig};
    use axum::body::{to_bytes, Body};
    use axum::http::{Request as HttpRequest, StatusCode};
    use std::collections::BTreeMap;
    use std::sync::{Arc, Mutex};
    use tower::ServiceExt;

    type MacLog = Arc<Mutex<Vec<MacNotification>>>;

    fn empty_snapshot() -> StateSnapshot {
        StateSnapshot {
            sessions: vec![],
            orgs: vec![],
            org_colors: BTreeMap::new(),
        }
    }

    fn services(hub: Arc<ControlHub>, mode: NotifyMode, mac_log: MacLog) -> ControlServices {
        services_with_registry(hub, mode, mac_log, Arc::new(SessionRegistry::new()))
    }

    fn services_with_registry(
        hub: Arc<ControlHub>,
        mode: NotifyMode,
        mac_log: MacLog,
        sessions: Arc<SessionRegistry>,
    ) -> ControlServices {
        let (refresh, rx) = tokio::sync::mpsc::channel(8);
        drop(rx);
        ControlServices {
            hub,
            refresh,
            repos: crate::repos::shared_repos(vec![], Default::default()),
            launch_claude: false,
            terms: Arc::new(std::sync::Mutex::new(TermRegistry::new())),
            sessions,
            heartbeat: crate::control::HEARTBEAT_INTERVAL,
            notify_mode: mode,
            mac_notify: Arc::new(move |n| mac_log.lock().unwrap().push(n)),
            config_path: None,
            app_version: None,
        }
    }

    fn app(services: ControlServices) -> axum::Router {
        build_router(ServerConfig {
            expected_token: Some("t".to_string()),
            control: Some(services),
            ..Default::default()
        })
    }

    async fn send(app: axum::Router, method: &str, body: &str) -> (StatusCode, String) {
        let req = HttpRequest::builder()
            .method(method)
            .uri("/api/hooks/event?token=t")
            .header("host", OK_HOST)
            .header("x-zashiki-token", "t")
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        let status = resp.status();
        let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        (status, String::from_utf8(bytes.to_vec()).unwrap())
    }

    #[tokio::test]
    async fn wrong_method_returns_405() {
        let hub = ControlHub::new(ConfigView::default(), vec![], empty_snapshot());
        let (s, _) = send(
            app(services(hub, NotifyMode::Web, Arc::new(Mutex::new(vec![])))),
            "GET",
            "",
        )
        .await;
        assert_eq!(s, StatusCode::METHOD_NOT_ALLOWED);
    }

    #[tokio::test]
    async fn tool_broadcasts_git_dirty_and_matched_false() {
        let hub = ControlHub::new(ConfigView::default(), vec![], empty_snapshot());
        let mut rx = hub.subscribe();
        let (s, b) = send(
            app(services(hub.clone(), NotifyMode::Web, Arc::new(Mutex::new(vec![])))),
            "POST",
            r#"{"kind":"tool"}"#,
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        assert!(b.contains(r#""matched":false"#), "body: {b}");
        // The git.dirty that triggers a git-panel refetch flows to all connections.
        assert!(matches!(rx.try_recv(), Ok(ServerMessage::GitDirty)));
    }

    #[tokio::test]
    async fn waiting_without_resolvable_window_is_not_matched() {
        // Empty registry -> window can't be resolved -> resolve None -> matched=false, no delivery
        // (returns 200 rather than 500 even when unresolvable = the hook is fire-and-forget).
        let hub = ControlHub::new(ConfigView::default(), vec![], empty_snapshot());
        let mac_log: MacLog = Arc::new(Mutex::new(vec![]));
        let (s, b) = send(
            app(services(hub, NotifyMode::Both, mac_log.clone())),
            "POST",
            r#"{"kind":"waiting","cwd":"/nope"}"#,
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        assert!(b.contains(r#""ok":true"#) && b.contains(r#""matched":false"#), "body: {b}");
        assert!(mac_log.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn prompt_is_accepted_and_not_matched() {
        let hub = ControlHub::new(ConfigView::default(), vec![], empty_snapshot());
        let (s, b) = send(
            app(services(hub, NotifyMode::Web, Arc::new(Mutex::new(vec![])))),
            "POST",
            r#"{"kind":"prompt"}"#,
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        assert!(b.contains(r#""matched":false"#), "body: {b}");
    }

    #[tokio::test]
    async fn invalid_kind_is_bad_request() {
        let hub = ControlHub::new(ConfigView::default(), vec![], empty_snapshot());
        let (s, _) = send(
            app(services(hub, NotifyMode::Web, Arc::new(Mutex::new(vec![])))),
            "POST",
            r#"{"kind":"bogus"}"#,
        )
        .await;
        assert_eq!(s, StatusCode::BAD_REQUEST);
    }

    /// Places an owned session in the registry, resolves by cwd match -> matched=true, notify push, and mac
    /// fire (verifies over HTTP that notification delivery works for owned sessions and that the wiring holds).
    #[cfg(unix)]
    #[tokio::test]
    async fn owned_waiting_matches_by_cwd_and_delivers() {
        use crate::session_launch::{plan_new_session, plan_to_config};
        use crate::session_registry::SessionMeta;

        let sessions = Arc::new(SessionRegistry::new());
        let sid = "579fa8cf-4901-45cb-b9ec-17e229231a37";
        let plan = plan_new_session(sid, "/tmp", "repo-a", false, None, "/bin/sh", "claude");
        sessions
            .create_with_meta(
                sid.to_string(),
                plan_to_config(&plan),
                SessionMeta {
                    cwd: "/tmp".to_string(),
                    wname: "repo-a".to_string(),
                },
            )
            .await
            .unwrap();

        let hub = ControlHub::new(ConfigView::default(), vec![], empty_snapshot());
        let mut rx = hub.subscribe();
        let mac_log: MacLog = Arc::new(Mutex::new(vec![]));
        // Both does both push+mac regardless of clientCount (makes the wiring verification deterministic).
        let svc =
            services_with_registry(hub.clone(), NotifyMode::Both, mac_log.clone(), sessions.clone());
        let (s, b) = send(app(svc), "POST", r#"{"kind":"waiting","cwd":"/tmp"}"#).await;
        assert_eq!(s, StatusCode::OK);
        assert!(b.contains(r#""matched":true"#), "body: {b}");

        // The notify push ({t:"notify",...}) flows to all connections.
        let mut saw_notify = false;
        while let Ok(msg) = rx.try_recv() {
            if let ServerMessage::Notify { title, kind, .. } = msg {
                assert_eq!(title, "repo-a");
                assert_eq!(kind, crate::protocol::NotifyKind::Waiting);
                saw_notify = true;
            }
        }
        assert!(saw_notify, "notify broadcast expected");
        // Both also emits a mac notification (the body is empty since there's no snap; the title is the window name).
        {
            let macs = mac_log.lock().unwrap();
            assert_eq!(macs.len(), 1);
            assert_eq!(macs[0].title, "repo-a");
        }
        for id in sessions.list().await {
            sessions.remove(&id).await;
        }
    }

    async fn send_focus(app: axum::Router, body: &str) -> (StatusCode, String) {
        let req = HttpRequest::builder()
            .method("POST")
            .uri("/api/focus?token=t")
            .header("host", OK_HOST)
            .header("x-zashiki-token", "t")
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        let status = resp.status();
        let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        (status, String::from_utf8(bytes.to_vec()).unwrap())
    }

    #[tokio::test]
    async fn focus_unresolved_returns_resolved_false_and_broadcasts_nothing() {
        let hub = ControlHub::new(ConfigView::default(), vec![], empty_snapshot());
        let mut rx = hub.subscribe();
        let (s, b) = send_focus(
            app(services(hub.clone(), NotifyMode::Web, Arc::new(Mutex::new(vec![])))),
            r#"{"cwd":"/nope"}"#,
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        assert!(b.contains(r#""resolved":false"#), "body: {b}");
        assert!(rx.try_recv().is_err(), "no select expected when unresolved");
    }

    /// Resolving a focus request by cwd broadcasts a `select` for the owned window and
    /// echoes the resolved cockpitTerminalId (so a clicked notification can select the session).
    #[cfg(unix)]
    #[tokio::test]
    async fn focus_resolved_broadcasts_select_with_cockpit_terminal_id() {
        use crate::session_launch::{plan_new_session, plan_to_config};
        use crate::session_registry::SessionMeta;

        let sessions = Arc::new(SessionRegistry::new());
        let sid = "579fa8cf-4901-45cb-b9ec-17e229231a37";
        let plan = plan_new_session(sid, "/tmp", "repo-a", false, None, "/bin/sh", "claude");
        sessions
            .create_with_meta(
                sid.to_string(),
                plan_to_config(&plan),
                SessionMeta {
                    cwd: "/tmp".to_string(),
                    wname: "repo-a".to_string(),
                },
            )
            .await
            .unwrap();

        let hub = ControlHub::new(ConfigView::default(), vec![], empty_snapshot());
        let mut rx = hub.subscribe();
        let svc = services_with_registry(
            hub.clone(),
            NotifyMode::Web,
            Arc::new(Mutex::new(vec![])),
            sessions.clone(),
        );
        let (s, b) = send_focus(app(svc), r#"{"cwd":"/tmp"}"#).await;
        assert_eq!(s, StatusCode::OK);
        assert!(b.contains(r#""resolved":true"#), "body: {b}");
        assert!(b.contains(&format!(r#""cockpitTerminalId":"{sid}""#)), "body: {b}");

        let mut saw_select = false;
        while let Ok(msg) = rx.try_recv() {
            if let ServerMessage::Select { cockpit_terminal_id } = msg {
                assert_eq!(cockpit_terminal_id, sid);
                saw_select = true;
            }
        }
        assert!(saw_select, "select broadcast expected");
        for id in sessions.list().await {
            sessions.remove(&id).await;
        }
    }
}
