use axum::{extract::Query, extract::State, http::StatusCode, response::IntoResponse, response::Response, Json};
use serde::Deserialize;

use crate::app_state::AppState;
use crate::protocol::{
    CockpitTerminalLastActivity, CockpitTerminalLastActivityResponse, CockpitTerminalTailResponse,
    SessionLinksResponse,
};
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

/// How many screen lines `GET /api/cockpit-terminals/tail` returns.
const TAIL_LINES: usize = 10;

#[derive(Deserialize)]
pub(crate) struct CockpitTerminalQuery {
    id: String,
}

/// `GET /api/cockpit-terminals/last-activity`. When each owned Cockpit Terminal last saw input or output.
pub(crate) async fn cockpit_terminals_last_activity(State(state): State<AppState>) -> Response {
    let Some(control) = state.control.as_ref() else {
        return json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "session services not available",
        );
    };
    let terminals = control
        .sessions
        .entries()
        .await
        .into_iter()
        .map(|(id, session, _)| CockpitTerminalLastActivity {
            cockpit_terminal_id: id,
            last_activity_at: session.last_activity_ms(),
        })
        .collect();
    Json(CockpitTerminalLastActivityResponse { terminals }).into_response()
}

/// `GET /api/cockpit-terminals/tail?id=`. The last lines of a Cockpit Terminal's visible screen.
pub(crate) async fn cockpit_terminal_tail(
    State(state): State<AppState>,
    Query(query): Query<CockpitTerminalQuery>,
) -> Response {
    let Some(control) = state.control.as_ref() else {
        return json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "session services not available",
        );
    };
    match control.sessions.get(&query.id).await {
        Some(session) => Json(CockpitTerminalTailResponse {
            lines: session.screen_tail(TAIL_LINES),
        })
        .into_response(),
        None => json_error(StatusCode::NOT_FOUND, "no such cockpit terminal"),
    }
}

#[derive(Deserialize)]
pub(crate) struct LinksQuery {
    id: String,
    details: Option<String>,
}

/// `GET /api/cockpit-terminals/links?id=[&details=1]`. The links seen by the Claude Session running in
/// a Cockpit Terminal (empty until one is detected). `details=1` adds the GitHub titles and states
/// cached so far and starts looking up the rest, without waiting for them.
pub(crate) async fn cockpit_terminal_links(
    State(state): State<AppState>,
    Query(query): Query<LinksQuery>,
) -> Response {
    let Some(control) = state.control.as_ref() else {
        return json_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "session services not available",
        );
    };
    if control.sessions.get(&query.id).await.is_none() {
        return json_error(StatusCode::NOT_FOUND, "no such cockpit terminal");
    }
    let mut links = match control.hub.claude_session_of(&query.id) {
        Some((cwd, sid)) => control.projects.session_links(&cwd, &sid).await,
        None => Vec::new(),
    };
    if query.details.as_deref() == Some("1") {
        control.github_details.annotate(&mut links);
    }
    Json(SessionLinksResponse { links }).into_response()
}

// ---- session save/restore REST wiring (owned registry + in-process HTTP) ----

#[cfg(test)]
mod sessions_persist_rest_tests {
    use crate::control::{ConfigView, ControlHub, ControlServices};
    use crate::github_details::{GithubDetails, GithubDetailsCache};
    use crate::protocol::GithubState;
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
        services_seeing(sessions, empty_snapshot(), std::env::temp_dir())
    }

    fn services_seeing(
        sessions: Arc<SessionRegistry>,
        snapshot: StateSnapshot,
        projects_root: std::path::PathBuf,
    ) -> ControlServices {
        let (refresh, rx) = tokio::sync::mpsc::channel(8);
        drop(rx);
        ControlServices {
            hub: ControlHub::new(ConfigView::default(), vec![], snapshot),
            refresh,
            repos: crate::repos::shared_repos(vec![], Default::default(), Default::default()),
            launch_claude: true,
            terms: Arc::new(std::sync::Mutex::new(TermRegistry::new())),
            sessions,
            hook_events: Arc::new(crate::hook_event_store::HookEventStore::new()),
            session_models: Arc::new(crate::session_model_store::SessionModelStore::new()),
            projects: Arc::new(crate::claude_projects::ClaudeProjectsAdapter::new(projects_root)),
            github_details: Arc::default(),
            heartbeat: crate::control::HEARTBEAT_INTERVAL,
            notify_mode: crate::hooks::NotifyMode::Web,
            notify_history: true,
            mac_notify: std::sync::Arc::new(|_| {}),
            config_path: None,
            claude_settings: None,
            app_version: None,
        }
    }

    fn app(dir: &std::path::Path, sessions: Arc<SessionRegistry>) -> axum::Router {
        build_router(ServerConfig {
            expected_token: Some(secrecy::SecretString::new("t".to_string())),
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
                    claude_session: None,
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

    async fn sessions_running(script: &str) -> Arc<SessionRegistry> {
        let sessions = Arc::new(SessionRegistry::new());
        let mut cmd = portable_pty::CommandBuilder::new("sh");
        cmd.arg("-c");
        cmd.arg(script);
        cmd.env("TERM", "xterm-256color");
        sessions
            .create("t1".to_string(), crate::pty_host::PtyConfig::new(cmd))
            .await
            .unwrap();
        sessions
    }

    #[tokio::test]
    async fn last_activity_lists_each_terminal_with_its_epoch_ms() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = sessions_running("sleep 5").await;
        let (s, b) = send(
            app(dir.path(), sessions.clone()),
            "GET",
            "/api/cockpit-terminals/last-activity",
            "",
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        let body: serde_json::Value = serde_json::from_str(&b).unwrap();
        let terminals = body["terminals"].as_array().unwrap();
        assert_eq!(terminals.len(), 1);
        assert_eq!(terminals[0]["cockpitTerminalId"], "t1");
        assert!(terminals[0]["lastActivityAt"].as_u64().unwrap() > 1_600_000_000_000);
        sessions.shutdown_all().await;
    }

    #[tokio::test]
    async fn tail_returns_the_last_screen_lines() {
        let dir = tempfile::tempdir().unwrap();
        let sessions =
            sessions_running("for i in $(seq 1 15); do echo line-$i; done; sleep 5").await;
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        let (s, b) = send(
            app(dir.path(), sessions.clone()),
            "GET",
            "/api/cockpit-terminals/tail?id=t1",
            "",
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        let body: serde_json::Value = serde_json::from_str(&b).unwrap();
        let lines: Vec<&str> = body["lines"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| l.as_str().unwrap())
            .collect();
        let expected: Vec<String> = (6..=15).map(|i| format!("line-{i}")).collect();
        assert_eq!(lines, expected);
        sessions.shutdown_all().await;
    }

    #[tokio::test]
    async fn tail_of_an_unknown_terminal_is_404() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = Arc::new(SessionRegistry::new());
        let (s, _b) = send(
            app(dir.path(), sessions),
            "GET",
            "/api/cockpit-terminals/tail?id=missing",
            "",
        )
        .await;
        assert_eq!(s, StatusCode::NOT_FOUND);
    }

    const LINKS_CWD: &str = "/Users/test/workspace/org/repo";
    const LINKS_SID: &str = "0b6cbc45-83a9-4f2e-9c3d-1a2b3c4d5e6f";

    fn snapshot_with_claude(cockpit_terminal_id: &str, sid: Option<&str>) -> StateSnapshot {
        let info = serde_json::from_value(serde_json::json!({
            "cockpitTerminalId": cockpit_terminal_id,
            "name": "repo",
            "org": "org",
            "repo": "repo",
            "cwd": LINKS_CWD,
            "state": "idle",
            "title": null,
            "sid": sid,
            "active": true,
        }))
        .unwrap();
        StateSnapshot {
            sessions: vec![info],
            ..empty_snapshot()
        }
    }

    fn links_app(
        dir: &std::path::Path,
        sessions: Arc<SessionRegistry>,
        snapshot: StateSnapshot,
        projects_root: &std::path::Path,
    ) -> axum::Router {
        links_app_looking_up(dir, sessions, snapshot, projects_root, Arc::default())
    }

    fn links_app_looking_up(
        dir: &std::path::Path,
        sessions: Arc<SessionRegistry>,
        snapshot: StateSnapshot,
        projects_root: &std::path::Path,
        github_details: Arc<GithubDetailsCache>,
    ) -> axum::Router {
        let mut services = services_seeing(sessions, snapshot, projects_root.to_path_buf());
        services.github_details = github_details;
        build_router(ServerConfig {
            expected_token: Some(secrecy::SecretString::new("t".to_string())),
            control: Some(services),
            saves_dir: Some(dir.to_path_buf()),
            ..Default::default()
        })
    }

    #[tokio::test]
    async fn links_lists_the_claude_sessions_links_in_wire_shape() {
        let dir = tempfile::tempdir().unwrap();
        let projects = tempfile::tempdir().unwrap();
        let project_dir = projects
            .path()
            .join(crate::jsonl::claude_project_dir_name(LINKS_CWD));
        std::fs::create_dir_all(&project_dir).unwrap();
        std::fs::write(
            project_dir.join(format!("{LINKS_SID}.jsonl")),
            r#"{"type":"user","message":{"content":"https://github.com/o/r/pull/7/files"}}"#,
        )
        .unwrap();
        let sessions = sessions_running("sleep 5").await;
        let (s, b) = send(
            links_app(
                dir.path(),
                sessions.clone(),
                snapshot_with_claude("t1", Some(LINKS_SID)),
                projects.path(),
            ),
            "GET",
            "/api/cockpit-terminals/links?id=t1",
            "",
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        let body: serde_json::Value = serde_json::from_str(&b).unwrap();
        assert_eq!(
            body,
            serde_json::json!({"links": [{
                "url": "https://github.com/o/r/pull/7",
                "tab": "conversation",
                "kind": "pr",
                "source": "user",
                "github": {"owner": "o", "repo": "r", "number": 7},
            }]})
        );
        sessions.shutdown_all().await;
    }

    fn write_links_transcript(projects: &std::path::Path, line: &str) {
        let project_dir = projects.join(crate::jsonl::claude_project_dir_name(LINKS_CWD));
        std::fs::create_dir_all(&project_dir).unwrap();
        std::fs::write(project_dir.join(format!("{LINKS_SID}.jsonl")), line).unwrap();
    }

    #[tokio::test]
    async fn links_carry_github_titles_only_when_details_are_asked_for() {
        let dir = tempfile::tempdir().unwrap();
        let projects = tempfile::tempdir().unwrap();
        write_links_transcript(
            projects.path(),
            r#"{"type":"user","message":{"content":"https://github.com/o/r/pull/7"}}"#,
        );
        let lookups = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = Arc::clone(&lookups);
        let github_details = Arc::new(GithubDetailsCache::with_fetch(
            Arc::new(move |_| {
                counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Box::pin(async {
                    Some(GithubDetails { title: "Add links".into(), state: GithubState::Merged })
                })
            }),
            Arc::new(std::time::Instant::now),
        ));
        let sessions = sessions_running("sleep 5").await;
        let app = links_app_looking_up(
            dir.path(),
            sessions.clone(),
            snapshot_with_claude("t1", Some(LINKS_SID)),
            projects.path(),
            github_details,
        );
        let github_of = |body: &str| {
            serde_json::from_str::<serde_json::Value>(body).unwrap()["links"][0]["github"].clone()
        };

        let (_, plain) = send(app.clone(), "GET", "/api/cockpit-terminals/links?id=t1", "").await;
        assert_eq!(github_of(&plain), serde_json::json!({"owner": "o", "repo": "r", "number": 7}));
        assert_eq!(lookups.load(std::sync::atomic::Ordering::SeqCst), 0);

        let detailed_uri = "/api/cockpit-terminals/links?id=t1&details=1";
        let (_, first) = send(app.clone(), "GET", detailed_uri, "").await;
        assert_eq!(github_of(&first)["title"], serde_json::Value::Null);
        let mut found = serde_json::Value::Null;
        for _ in 0..100 {
            let (_, body) = send(app.clone(), "GET", detailed_uri, "").await;
            found = github_of(&body);
            if found.get("title").is_some() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert_eq!(
            found,
            serde_json::json!({"owner": "o", "repo": "r", "number": 7, "title": "Add links", "state": "merged"})
        );
        assert_eq!(lookups.load(std::sync::atomic::Ordering::SeqCst), 1);
        sessions.shutdown_all().await;
    }

    #[tokio::test]
    async fn links_of_a_terminal_without_a_claude_session_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let projects = tempfile::tempdir().unwrap();
        let sessions = sessions_running("sleep 5").await;
        let (s, b) = send(
            links_app(
                dir.path(),
                sessions.clone(),
                snapshot_with_claude("t1", None),
                projects.path(),
            ),
            "GET",
            "/api/cockpit-terminals/links?id=t1",
            "",
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(b, r#"{"links":[]}"#);
        sessions.shutdown_all().await;
    }

    #[tokio::test]
    async fn links_of_an_unknown_terminal_is_404() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = Arc::new(SessionRegistry::new());
        let (s, _b) = send(
            app(dir.path(), sessions),
            "GET",
            "/api/cockpit-terminals/links?id=missing",
            "",
        )
        .await;
        assert_eq!(s, StatusCode::NOT_FOUND);
    }
}
