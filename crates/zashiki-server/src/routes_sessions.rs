use axum::{extract::State, http::StatusCode, response::IntoResponse, response::Response, Json};
use serde::Deserialize;

use crate::app_state::AppState;
use crate::session_persist;
use crate::wire_support::{json_error, parse_json_body, persist_error_response};

#[derive(Deserialize)]
struct SessionsRestoreBody {
    file: Option<String>,
}

/// `POST /api/sessions/save`. Saves all claude sessions in the owned registry to last.tsv + a backup.
pub(crate) async fn sessions_save(State(state): State<AppState>) -> Response {
    let Some(control) = state.control.as_ref() else {
        return json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "session services not available",
        );
    };
    let _guard = state.persist_lock.lock().await;
    match session_persist::save_sessions(&control.sessions, state.saves_dir.as_path()).await {
        Ok(out) => Json(serde_json::json!({
            "saved": out.saved,
            "skipped": out.skipped,
            "path": out.path,
        }))
        .into_response(),
        Err(e) => persist_error_response(e),
    }
}

/// `POST /api/sessions/restore`. Rebuilds the owned registry from a save (destructive operations are serialized via persist_lock).
pub(crate) async fn sessions_restore(
    State(state): State<AppState>,
    body: axum::body::Bytes,
) -> Response {
    let Some(control) = state.control.as_ref() else {
        return json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "session services not available",
        );
    };
    let parsed: SessionsRestoreBody = match parse_json_body(&body) {
        Ok(v) => v,
        Err((status, msg)) => return json_error(status, &msg),
    };
    if let Some(file) = &parsed.file {
        if !session_persist::is_valid_save_filename(file) {
            return json_error(
                StatusCode::BAD_REQUEST,
                "file must be a plain file name in saves/",
            );
        }
    }
    let shell = crate::session_restore::login_shell();
    let settings =
        crate::session_launch::account_usage_settings(control.hub.account_usage_enabled());
    let _guard = state.persist_lock.lock().await;
    match session_persist::restore_sessions(
        &control.sessions,
        state.saves_dir.as_path(),
        parsed.file.as_deref(),
        control.launch_claude,
        &shell,
        settings.as_deref(),
    )
    .await
    {
        Ok(out) => Json(serde_json::json!({
            "restored": out.restored,
            "warnings": out.warnings,
            "backupPath": out.backup_path,
        }))
        .into_response(),
        Err(e) => persist_error_response(e),
    }
}

// ---- session save/restore REST wiring (owned registry + in-process HTTP) ----

#[cfg(test)]
mod sessions_persist_rest_tests {
    use crate::control::{ConfigView, ControlHub, ControlServices};
    use crate::session_launch::{plan_new_session, plan_to_config};
    use crate::session_registry::{SessionMeta, SessionRegistry};
    use crate::status_poller::StateSnapshot;
    use crate::term_registry::TermRegistry;
    use crate::{build_router, ServerConfig};
    use axum::body::{to_bytes, Body};
    use axum::http::{Request as HttpRequest, StatusCode};
    use std::collections::BTreeMap;
    use std::sync::Arc;
    use tower::ServiceExt;

    const OK_HOST: &str = "127.0.0.1:8790";

    fn empty_snapshot() -> StateSnapshot {
        StateSnapshot {
            sessions: vec![],
            orgs: vec![],
            org_colors: BTreeMap::new(),
            org_aliases: BTreeMap::new(),
        }
    }

    /// Owned services without a poller (the persist handlers only look at sessions and launch_claude,
    /// so the rest can be bogus).
    fn services(sessions: Arc<SessionRegistry>) -> ControlServices {
        let (refresh, rx) = tokio::sync::mpsc::channel(8);
        drop(rx);
        ControlServices {
            hub: ControlHub::new(ConfigView::default(), vec![], empty_snapshot()),
            refresh,
            repos: crate::repos::shared_repos(vec![], Default::default(), Default::default()),
            launch_claude: true,
            terms: Arc::new(std::sync::Mutex::new(TermRegistry::new())),
            sessions,
            hook_events: Arc::new(crate::hook_event_store::HookEventStore::new()),
            heartbeat: crate::control::HEARTBEAT_INTERVAL,
            notify_mode: crate::hooks::NotifyMode::Web,
            mac_notify: std::sync::Arc::new(|_| {}),
            config_path: None,
            claude_settings: None,
            app_version: None,
        }
    }

    fn app(dir: &std::path::Path, sessions: Arc<SessionRegistry>) -> axum::Router {
        build_router(ServerConfig {
            expected_token: Some("t".to_string()),
            control: Some(services(sessions)),
            saves_dir: Some(dir.to_path_buf()),
            ..Default::default()
        })
    }

    async fn send(app: axum::Router, method: &str, uri: &str, body: &str) -> (StatusCode, String) {
        let req = HttpRequest::builder()
            .method(method)
            .uri(uri)
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
    async fn save_empty_registry_returns_409_with_code() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = Arc::new(SessionRegistry::new());
        let (s, b) = send(app(dir.path(), sessions), "POST", "/api/sessions/save?token=t", "").await;
        assert_eq!(s, StatusCode::CONFLICT);
        // PersistError responses carry a `code` (drop-in contract).
        assert!(b.contains(r#""code":"save_empty""#), "body: {b}");
    }

    #[tokio::test]
    async fn restore_missing_file_returns_404() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = Arc::new(SessionRegistry::new());
        let (s, _b) = send(app(dir.path(), sessions), "POST", "/api/sessions/restore?token=t", "{}").await;
        assert_eq!(s, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn restore_empty_file_returns_422() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("last.tsv"), "").unwrap();
        let sessions = Arc::new(SessionRegistry::new());
        let (s, _b) = send(app(dir.path(), sessions), "POST", "/api/sessions/restore?token=t", "{}").await;
        assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[tokio::test]
    async fn restore_bad_filename_returns_400() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = Arc::new(SessionRegistry::new());
        let (s, _b) = send(
            app(dir.path(), sessions),
            "POST",
            "/api/sessions/restore?token=t",
            r#"{"file":"../escape.tsv"}"#,
        )
        .await;
        assert_eq!(s, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn wrong_method_returns_405() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = Arc::new(SessionRegistry::new());
        let (s, _b) = send(app(dir.path(), sessions), "GET", "/api/sessions/save?token=t", "").await;
        assert_eq!(s, StatusCode::METHOD_NOT_ALLOWED);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn restore_happy_returns_camelcase_body() {
        let dir = tempfile::tempdir().unwrap();
        let sid = "579fa8cf-4901-45cb-b9ec-17e229231a37";
        std::fs::write(
            dir.path().join("last.tsv"),
            format!("1\talpha\t/tmp\t{sid}\n"),
        )
        .unwrap();
        let sessions = Arc::new(SessionRegistry::new());

        let (s, b) = send(
            app(dir.path(), sessions.clone()),
            "POST",
            "/api/sessions/restore?token=t",
            "{}",
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        // Enforce the camelCase contract of the response body (restored / warnings / backupPath) at the HTTP layer.
        assert!(b.contains(r#""restored":1"#), "body: {b}");
        assert!(b.contains(r#""warnings":[]"#), "body: {b}");
        // Since the pre-restore registry is empty, backupPath is null (camelCase, nullified).
        assert!(b.contains(r#""backupPath":null"#), "body: {b}");

        for id in sessions.list().await {
            sessions.remove(&id).await;
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn save_happy_writes_last_and_returns_body() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = Arc::new(SessionRegistry::new());
        let sid = "579fa8cf-4901-45cb-b9ec-17e229231a37";
        let plan = plan_new_session(sid, "/tmp", "alpha", false, None, "/bin/sh", "claude", None);
        sessions
            .create_with_meta(
                sid.to_string(),
                plan_to_config(&plan),
                SessionMeta {
                    cwd: "/tmp".to_string(),
                    wname: "alpha".to_string(),
                },
            )
            .await
            .unwrap();

        let (s, b) = send(
            app(dir.path(), sessions.clone()),
            "POST",
            "/api/sessions/save?token=t",
            "",
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        assert!(b.contains(r#""saved":1"#), "body: {b}");
        assert!(b.contains(r#""skipped":[]"#), "body: {b}");
        assert!(std::fs::read_to_string(dir.path().join("last.tsv"))
            .unwrap()
            .contains(sid));

        for id in sessions.list().await {
            sessions.remove(&id).await;
        }
    }
}
