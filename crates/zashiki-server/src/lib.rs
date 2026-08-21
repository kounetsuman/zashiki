//! A standalone Rust server: the HTTP/WS backend the Tauri sidecar launches.
//!
//! Serves the REST endpoints (git status/write, `/api/file`, `/api/fs`, hooks), the `/ws/control`
//! and `/ws/term` channels, and the status poller, behind Host/Origin verification, token auth for
//! `/api/*`, and static serving of the client dist.

pub mod claude_projects;
pub mod config;
pub mod control;
pub mod crash_report;
pub mod file;
pub mod fs;
pub mod git;
pub mod hooks;
pub mod jsonl;
pub mod launchd;
pub mod lsof;
pub mod mac_notifier;
pub mod notifications;
pub mod orphan_detector;
pub mod poller_driver;
pub mod poller_ports_pty;
pub mod protocol;
pub mod ps;
pub mod shells;
pub mod pty_host;
pub mod repos;
pub mod repos_watch;
pub mod runtime;
pub mod scrollback_monitor;
pub mod search;
pub mod self_update;
pub mod session_launch;
pub mod session_persist;
pub mod session_registry;
pub mod session_restore;
pub mod session_status;
pub mod status_poller;
pub mod term_attach_pty;
pub mod token;
pub mod term_registry;
pub mod update_checker;

mod app_state;
mod poller_types;
mod poller_eval_helpers;
mod control_dispatch;
mod control_hub;
mod control_session;
mod control_term;
mod middleware;
mod routes_fs;
mod routes_git;
mod routes_health;
mod routes_repos;
mod routes_search;
mod routes_hooks;
mod routes_sessions;
mod routes_ws;
mod security;
mod wire_support;
pub use app_state::{default_saves_dir, OpenFile};
pub(crate) use app_state::now_ms;
pub use security::{is_allowed_host, is_allowed_origin, token_from_query, token_matches};

use crate::app_state::AppState;
use crate::middleware::{host_origin_guard, require_token};
use crate::routes_fs::{file_read, file_write, fs_list};
use crate::routes_git::{
    git_commit, git_open, git_stage, git_stage_all, git_status, git_unstage, git_unstage_all,
};
use crate::routes_health::{ack_last_crash, healthz, last_crash, token_probe};
use crate::routes_repos::{fs_browse, fs_repos, fs_validate, repos_add, repos_list};
use crate::routes_hooks::{focus_session, hooks_event, hooks_statusline};
use crate::routes_search::search_route;
use crate::routes_sessions::{sessions_restore, sessions_save};
use crate::routes_ws::{activity, ws_control, ws_term};

use std::path::PathBuf;
use std::sync::Arc;

use axum::{
    extract::DefaultBodyLimit,
    http::header,
    routing::{get, post},
    Router,
};

use crate::control::ControlServices;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::services::ServeDir;

/// Server configuration. Passed to `build_router` from tests and main.
#[derive(Default)]
pub struct ServerConfig {
    /// Expected token. If unset, token-required routes always return 401 (fail-safe).
    pub expected_token: Option<String>,
    /// Client dist (no static serving if None).
    pub client_dist: Option<PathBuf>,
    /// Path to repos.conf (if None, `/api/fs/repos` returns empty).
    pub repos_conf: Option<PathBuf>,
    /// Control services (if None, `/ws/control` is not wired = REST only).
    pub control: Option<ControlServices>,
    /// Editor command (ZK_EDITOR). Default `cursor -g`.
    pub editor: Option<String>,
    /// Replacement for the `POST /api/git/open` editor launch (for test injection; spawns the editor if None).
    pub open_file: Option<OpenFile>,
    /// Maximum bytes per file for `/api/file` (for test injection; FILE_MAX_BYTES if None).
    pub file_max_bytes: Option<u64>,
    /// Destination for session save/restore (ZK_SAVES_DIR; `~/.zashiki/saves` if None).
    pub saves_dir: Option<PathBuf>,
    /// The previous run's log tail when it did not shut down cleanly, served once via `/api/last-crash`.
    pub last_crash: Option<String>,
}

/// Builds the router. `/healthz` and static serving require no token, `/api/*` requires a token,
/// and Host/Origin verification applies to all routes.
pub fn build_router(config: ServerConfig) -> Router {
    let state = AppState {
        expected_token: Arc::new(config.expected_token),
        repos_conf: Arc::new(config.repos_conf),
        control: config.control,
        editor: Arc::new(config.editor.unwrap_or_else(|| "cursor -g".to_string())),
        open_file: config.open_file,
        file_max_bytes: config.file_max_bytes.unwrap_or(file::FILE_MAX_BYTES),
        saves_dir: Arc::new(config.saves_dir.unwrap_or_else(default_saves_dir)),
        persist_lock: Arc::new(tokio::sync::Mutex::new(())),
        scan_cache: Arc::new(tokio::sync::Mutex::new(None)),
        last_crash: Arc::new(std::sync::Mutex::new(config.last_crash)),
    };

    // Token-required API group (/api/* has requireToken=true). `/ws/control` also requires a token.
    let mut authed_routes = Router::new()
        .route("/api/zk-shell/token-probe", get(token_probe))
        .route("/api/fs/repos", get(fs_repos))
        .route("/api/repos/add", post(repos_add))
        .route("/api/repos/list", get(repos_list))
        .route("/api/fs/list", get(fs_list))
        .route("/api/fs/validate", get(fs_validate))
        .route("/api/fs/browse", get(fs_browse))
        .route("/api/git/status", get(git_status))
        .route("/api/git/stage", post(git_stage))
        .route("/api/git/unstage", post(git_unstage))
        .route("/api/git/open", post(git_open))
        .route("/api/git/stage-all", post(git_stage_all))
        .route("/api/git/unstage-all", post(git_unstage_all))
        .route("/api/git/commit", post(git_commit))
        // /api/file writes allow a larger body: maxBytes + 64KiB (content max + slack for the JSON
        // envelope), overriding axum's default 2MiB so the 413 is content-based rather than transport-level.
        .route(
            "/api/file",
            get(file_read).post(file_write).layer(DefaultBodyLimit::max(
                (state.file_max_bytes + 64 * 1024) as usize,
            )),
        )
        .route("/api/search", post(search_route))
        .route("/api/sessions/save", post(sessions_save))
        .route("/api/sessions/restore", post(sessions_restore))
        .route("/api/hooks/event", post(hooks_event))
        .route("/api/hooks/statusline", post(hooks_statusline))
        .route("/api/focus", post(focus_session))
        .route("/api/activity", get(activity))
        .route("/api/last-crash", get(last_crash))
        .route("/api/last-crash/ack", post(ack_last_crash));
    if state.control.is_some() {
        authed_routes = authed_routes
            .route("/ws/control", get(ws_control))
            .route("/ws/term/:term_id", get(ws_term));
    }
    let authed = authed_routes
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            require_token,
        ))
        .with_state(state);

    let mut app = Router::new().route("/healthz", get(healthz)).merge(authed);

    if let Some(dist) = config.client_dist {
        // Serve GET / and extension-bearing assets from the client dist. No token required.
        app = app.fallback_service(ServeDir::new(dist).append_index_html_on_directories(true));
    }

    // Host/Origin verification applies to all routes, including static serving.
    // CORS sits outside that (the outermost layer). In dev, webview (localhost:5173) -> server (127.0.0.1:8790)
    // is cross-origin with x-zashiki-token (a non-safelisted header) = subject to preflight. Making CorsLayer
    // outermost handles OPTIONS ahead of token auth and host_origin_guard, so preflight isn't killed by 401/403.
    app.layer(axum::middleware::from_fn(host_origin_guard))
        .layer(cors_layer())
}

/// A CORS layer that echoes Origin only for allowed origins (same check as `is_allowed_origin` = http(s) on the localhost family).
/// The wildcard `*` is not used because it is incompatible with Authorization/credentials.
fn cors_layer() -> CorsLayer {
    CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(|origin, _req| {
            origin
                .to_str()
                .map(|o| is_allowed_origin(Some(o)))
                .unwrap_or(false)
        }))
        .allow_methods([
            axum::http::Method::GET,
            axum::http::Method::POST,
            axum::http::Method::OPTIONS,
        ])
        // The client's authHeaders send x-zashiki-token.
        // This is a non-safelisted header = it triggers preflight, so unless it's allowed, dev requests are blocked.
        .allow_headers([
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            header::HeaderName::from_static("x-zashiki-token"),
        ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use axum::http::{Request as HttpRequest, StatusCode};
    use tower::ServiceExt;

    const OK_HOST: &str = "127.0.0.1:8790";

    async fn request(
        app: Router,
        uri: &str,
        host: Option<&str>,
        extra: &[(&str, &str)],
    ) -> (StatusCode, String) {
        let mut builder = HttpRequest::builder().uri(uri);
        if let Some(h) = host {
            builder = builder.header("host", h);
        }
        for (k, v) in extra {
            builder = builder.header(*k, *v);
        }
        let resp = app
            .oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = resp.status();
        let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        (status, String::from_utf8(bytes.to_vec()).unwrap())
    }

    fn router(token: Option<&str>) -> Router {
        build_router(ServerConfig {
            expected_token: token.map(str::to_string),
            ..Default::default()
        })
    }

    /// Requests with the given method + arbitrary headers, and returns the status and the selected response headers (None if absent).
    async fn request_full(
        app: Router,
        method: &str,
        uri: &str,
        headers: &[(&str, &str)],
        want: &[&str],
    ) -> (StatusCode, Vec<Option<String>>) {
        let mut builder = HttpRequest::builder().method(method).uri(uri);
        for (k, v) in headers {
            builder = builder.header(*k, *v);
        }
        let resp = app
            .oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = resp.status();
        let picked = want
            .iter()
            .map(|name| {
                resp.headers()
                    .get(*name)
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_string)
            })
            .collect();
        (status, picked)
    }

    const ACAO: &str = "access-control-allow-origin";
    const ACAM: &str = "access-control-allow-methods";
    const ACAH: &str = "access-control-allow-headers";

    #[tokio::test]
    async fn cors_echoes_acao_for_allowed_origin() {
        let (status, hs) = request_full(
            router(Some("s3cret")),
            "GET",
            "/healthz",
            &[("host", OK_HOST), ("origin", "http://localhost:5173")],
            &[ACAO],
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(hs[0].as_deref(), Some("http://localhost:5173"));
    }

    #[tokio::test]
    async fn cors_omits_acao_for_disallowed_origin() {
        // A disallowed origin gets 403 from host_origin_guard. ACAO is not added either (the browser blocks it).
        let (status, hs) = request_full(
            router(Some("s3cret")),
            "GET",
            "/healthz",
            &[("host", OK_HOST), ("origin", "http://evil.example")],
            &[ACAO],
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(hs[0], None);
    }

    #[tokio::test]
    async fn cors_preflight_passes_without_token_and_returns_headers() {
        // preflight (OPTIONS) has no Authorization. Even on a token-required route it passes with 2xx before auth,
        // returning the required CORS headers (ACAO echo / methods / headers).
        let (status, hs) = request_full(
            router(Some("s3cret")),
            "OPTIONS",
            "/api/git/status",
            &[
                ("host", OK_HOST),
                ("origin", "http://localhost:5173"),
                ("access-control-request-method", "GET"),
                // The auth header the client actually sends.
                ("access-control-request-headers", "x-zashiki-token"),
            ],
            &[ACAO, ACAM, ACAH],
        )
        .await;
        assert!(status.is_success(), "preflight status = {status}");
        assert_eq!(hs[0].as_deref(), Some("http://localhost:5173"));
        let methods = hs[1].as_deref().unwrap_or("").to_ascii_uppercase();
        assert!(methods.contains("GET"), "methods = {methods:?}");
        assert!(methods.contains("POST"), "methods = {methods:?}");
        assert!(methods.contains("OPTIONS"), "methods = {methods:?}");
        let allow_headers = hs[2].as_deref().unwrap_or("").to_ascii_lowercase();
        assert!(allow_headers.contains("authorization"), "headers = {allow_headers:?}");
        assert!(allow_headers.contains("content-type"), "headers = {allow_headers:?}");
        // Unless the client's x-zashiki-token is allowed, the dev preflight is blocked by the browser.
        assert!(allow_headers.contains("x-zashiki-token"), "headers = {allow_headers:?}");
    }

    #[tokio::test]
    async fn cors_preflight_does_not_leak_to_disallowed_origin() {
        let (_status, hs) = request_full(
            router(Some("s3cret")),
            "OPTIONS",
            "/api/git/status",
            &[
                ("host", OK_HOST),
                ("origin", "http://evil.example"),
                ("access-control-request-method", "GET"),
            ],
            &[ACAO],
        )
        .await;
        assert_eq!(hs[0], None);
    }

    #[tokio::test]
    async fn token_auth_still_enforced_on_real_request_with_origin() {
        // Even after adding CORS, token auth on real GETs still holds (with an Origin but no token, it's 401).
        let (status, _) = request_full(
            router(Some("s3cret")),
            "GET",
            "/api/git/status",
            &[("host", OK_HOST), ("origin", "http://localhost:5173")],
            &[ACAO],
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn healthz_returns_ok_json_without_auth() {
        let (status, body) = request(router(None), "/healthz", Some(OK_HOST), &[]).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains(r#""status":"ok""#), "body={body}");
    }

    #[tokio::test]
    async fn healthz_carries_build_identifiers_for_stale_detection() {
        // Material for the desktop to distinguish a stale server. Since the values themselves are
        // determined at build time, we only hold the presence and non-emptiness of the keys as the contract.
        let (_status, body) = request(router(None), "/healthz", Some(OK_HOST), &[]).await;
        let v: serde_json::Value = serde_json::from_str(&body).expect("healthz is JSON");
        assert_eq!(v["status"], "ok");
        assert!(v["version"].as_str().is_some_and(|s| !s.is_empty()), "body={body}");
        assert!(v["git_sha"].as_str().is_some_and(|s| !s.is_empty()), "body={body}");
        assert!(v["pid"].as_u64().is_some_and(|p| p > 0), "body={body}");
    }

    #[tokio::test]
    async fn token_probe_accepts_valid_token_via_query_and_header() {
        let app = router(Some("s3cret"));
        let (s1, b1) = request(
            app.clone(),
            "/api/zk-shell/token-probe?token=s3cret",
            Some(OK_HOST),
            &[],
        )
        .await;
        assert_eq!(s1, StatusCode::OK);
        assert_eq!(b1, r#"{"ok":true}"#);

        let (s2, _) = request(
            app,
            "/api/zk-shell/token-probe",
            Some(OK_HOST),
            &[("x-zashiki-token", "s3cret")],
        )
        .await;
        assert_eq!(s2, StatusCode::OK);
    }

    #[tokio::test]
    async fn api_requires_token() {
        let app = router(Some("s3cret"));
        // Wrong token or no token is 401
        let (s1, _) = request(
            app.clone(),
            "/api/zk-shell/token-probe?token=nope",
            Some(OK_HOST),
            &[],
        )
        .await;
        assert_eq!(s1, StatusCode::UNAUTHORIZED);
        let (s2, _) = request(app, "/api/fs/repos", Some(OK_HOST), &[]).await;
        assert_eq!(s2, StatusCode::UNAUTHORIZED);
        // Always 401 if no token is configured
        let (s3, _) = request(
            router(None),
            "/api/fs/repos?token=anything",
            Some(OK_HOST),
            &[],
        )
        .await;
        assert_eq!(s3, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn fs_repos_returns_scanned_repos_as_json() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("org1/repo-a/.git")).unwrap();
        let conf = root.path().join("repos.conf");
        std::fs::write(&conf, format!("{}\n", root.path().join("org1").display())).unwrap();

        let app = build_router(ServerConfig {
            expected_token: Some("s3cret".to_string()),
            repos_conf: Some(conf),
            ..Default::default()
        });
        let (status, body) = request(app, "/api/fs/repos?token=s3cret", Some(OK_HOST), &[]).await;
        assert_eq!(status, StatusCode::OK);
        let expected_path = root.path().join("org1/repo-a");
        assert_eq!(
            body,
            format!(
                r#"{{"repos":[{{"org":"org1","repo":"repo-a","path":"{}"}}]}}"#,
                expected_path.display()
            )
        );
    }

    #[tokio::test]
    async fn last_crash_is_idempotent_until_acked() {
        let app = build_router(ServerConfig {
            expected_token: Some("t".to_string()),
            last_crash: Some("panicked at 'boom'".to_string()),
            ..Default::default()
        });
        let (s1, b1) = request(app.clone(), "/api/last-crash?token=t", Some(OK_HOST), &[]).await;
        assert_eq!(s1, StatusCode::OK);
        assert_eq!(b1, r#"{"log":"panicked at 'boom'"}"#);
        let (s2, b2) = request(app.clone(), "/api/last-crash?token=t", Some(OK_HOST), &[]).await;
        assert_eq!(b2, r#"{"log":"panicked at 'boom'"}"#, "read must not clear (s={s2})");

        let ack = app
            .clone()
            .oneshot(
                HttpRequest::builder()
                    .method("POST")
                    .uri("/api/last-crash/ack?token=t")
                    .header("host", OK_HOST)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(ack.status(), StatusCode::NO_CONTENT);

        let (_, b3) = request(app.clone(), "/api/last-crash?token=t", Some(OK_HOST), &[]).await;
        assert_eq!(b3, r#"{"log":null}"#, "ack clears the crash");
    }

    #[tokio::test]
    async fn last_crash_requires_a_token() {
        let app = build_router(ServerConfig {
            expected_token: Some("t".to_string()),
            last_crash: Some("boom".to_string()),
            ..Default::default()
        });
        let (status, _) = request(app, "/api/last-crash", Some(OK_HOST), &[]).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn fs_list_lists_dir_and_enforces_repo_allowlist_and_safe_dir() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("org1/repo-a");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::create_dir_all(repo.join("src")).unwrap();
        std::fs::write(repo.join("README.md"), "r").unwrap();
        let conf = root.path().join("repos.conf");
        std::fs::write(&conf, format!("{}\n", root.path().join("org1").display())).unwrap();
        let app = build_router(ServerConfig {
            expected_token: Some("t".to_string()),
            repos_conf: Some(conf),
            ..Default::default()
        });
        let repo_path = repo.to_string_lossy().into_owned();

        // Normal: dir-first sort gives src(dir) -> README.md(file), and .git is excluded.
        let (status, body) = request(
            app.clone(),
            &format!("/api/fs/list?token=t&repoPath={repo_path}"),
            Some(OK_HOST),
            &[],
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body,
            r#"{"entries":[{"name":"src","kind":"dir"},{"name":"README.md","kind":"file"}],"truncated":false}"#
        );

        // A repoPath outside the allowlist is 403
        let (s403, _) = request(
            app.clone(),
            "/api/fs/list?token=t&repoPath=/tmp/not-scanned",
            Some(OK_HOST),
            &[],
        )
        .await;
        assert_eq!(s403, StatusCode::FORBIDDEN);

        // A dangerous dir (..) is 400
        let (s400, _) = request(
            app.clone(),
            &format!("/api/fs/list?token=t&repoPath={repo_path}&dir=../escape"),
            Some(OK_HOST),
            &[],
        )
        .await;
        assert_eq!(s400, StatusCode::BAD_REQUEST);

        // Missing repoPath is 400, no token is 401
        let (s_req, _) = request(app.clone(), "/api/fs/list?token=t", Some(OK_HOST), &[]).await;
        assert_eq!(s_req, StatusCode::BAD_REQUEST);
        let (s401, _) = request(app, "/api/fs/list", Some(OK_HOST), &[]).await;
        assert_eq!(s401, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn repos_list_returns_org_roots_with_names_and_paths() {
        let root = tempfile::tempdir().unwrap();
        let orgdir = root.path().join("myorg");
        std::fs::create_dir_all(&orgdir).unwrap();
        let conf = root.path().join("repos.conf");
        std::fs::write(&conf, format!("{}\n", orgdir.display())).unwrap();
        let app = build_router(ServerConfig {
            expected_token: Some("t".to_string()),
            repos_conf: Some(conf),
            ..Default::default()
        });

        let (s, body) = request(app.clone(), "/api/repos/list?token=t", Some(OK_HOST), &[]).await;
        assert_eq!(s, StatusCode::OK);
        assert!(body.contains(r#""org":"myorg""#), "{body}");
        assert!(
            body.contains(&format!(r#""path":"{}""#, orgdir.to_string_lossy())),
            "{body}"
        );

        // No token is 401.
        let (s401, _) = request(app, "/api/repos/list", Some(OK_HOST), &[]).await;
        assert_eq!(s401, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn repos_list_skips_a_rootless_slash_entry() {
        let root = tempfile::tempdir().unwrap();
        let orgdir = root.path().join("realorg");
        std::fs::create_dir_all(&orgdir).unwrap();
        let conf = root.path().join("repos.conf");
        // A degenerate `/` root must not blank the list (its empty org would fail the client schema).
        std::fs::write(&conf, format!("/\n{}\n", orgdir.display())).unwrap();
        let app = build_router(ServerConfig {
            expected_token: Some("t".to_string()),
            repos_conf: Some(conf),
            ..Default::default()
        });
        let (s, body) = request(app, "/api/repos/list?token=t", Some(OK_HOST), &[]).await;
        assert_eq!(s, StatusCode::OK);
        assert!(body.contains(r#""org":"realorg""#), "{body}");
        assert!(!body.contains(r#""org":"""#), "{body}");
    }

    #[tokio::test]
    async fn repos_list_is_empty_without_a_conf() {
        let app = build_router(ServerConfig {
            expected_token: Some("t".to_string()),
            ..Default::default()
        });
        let (s, body) = request(app, "/api/repos/list?token=t", Some(OK_HOST), &[]).await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(body, r#"{"orgs":[]}"#);
    }

    #[tokio::test]
    async fn fs_validate_reports_add_status_and_enforces_token() {
        let root = tempfile::tempdir().unwrap();
        let neworg = root.path().join("neworg");
        std::fs::create_dir_all(&neworg).unwrap();
        let dup = root.path().join("dup");
        std::fs::create_dir_all(&dup).unwrap();
        let conf = root.path().join("repos.conf");
        std::fs::write(&conf, format!("{}\n", dup.display())).unwrap();
        let app = build_router(ServerConfig {
            expected_token: Some("t".to_string()),
            repos_conf: Some(conf),
            ..Default::default()
        });

        // An existing, unregistered directory validates as ok with org = basename.
        let (s, body) = request(
            app.clone(),
            &format!("/api/fs/validate?token=t&path={}", neworg.to_string_lossy()),
            Some(OK_HOST),
            &[],
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        assert!(body.contains(r#""status":"ok""#), "{body}");
        assert!(body.contains(r#""org":"neworg""#), "{body}");

        // An already-registered path is duplicate; a missing path is not_a_directory (org omitted).
        let (_, dbody) = request(
            app.clone(),
            &format!("/api/fs/validate?token=t&path={}", dup.to_string_lossy()),
            Some(OK_HOST),
            &[],
        )
        .await;
        assert!(dbody.contains(r#""status":"duplicate""#), "{dbody}");
        assert!(!dbody.contains(r#""org""#), "{dbody}");
        let (_, nbody) = request(
            app.clone(),
            &format!(
                "/api/fs/validate?token=t&path={}",
                root.path().join("nope").to_string_lossy()
            ),
            Some(OK_HOST),
            &[],
        )
        .await;
        assert!(nbody.contains(r#""status":"not_a_directory""#), "{nbody}");

        // Empty path is 400, no token is 401.
        let (s400, _) = request(app.clone(), "/api/fs/validate?token=t", Some(OK_HOST), &[]).await;
        assert_eq!(s400, StatusCode::BAD_REQUEST);
        let (s401, _) = request(
            app,
            &format!("/api/fs/validate?path={}", neworg.to_string_lossy()),
            Some(OK_HOST),
            &[],
        )
        .await;
        assert_eq!(s401, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn fs_browse_lists_scoped_subdirs_and_rejects_out_of_scope() {
        let root = tempfile::tempdir().unwrap();
        let ws = root.path().join("workspace");
        std::fs::create_dir_all(ws.join("workshop")).unwrap();
        std::fs::create_dir_all(ws.join("other")).unwrap();
        // Register an org under ws, so ws (the registered root's parent) becomes browseable.
        let conf = root.path().join("repos.conf");
        std::fs::write(&conf, format!("{}\n", ws.join("workshop").display())).unwrap();
        let app = build_router(ServerConfig {
            expected_token: Some("t".to_string()),
            repos_conf: Some(conf),
            ..Default::default()
        });

        // Browsing under ws with prefix "wo" returns only the matching subdir.
        let (s, body) = request(
            app.clone(),
            &format!("/api/fs/browse?token=t&path={}/wo", ws.to_string_lossy()),
            Some(OK_HOST),
            &[],
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        assert!(body.contains(r#""name":"workshop""#), "{body}");
        assert!(!body.contains(r#""name":"other""#), "{body}");

        // A parent outside HOME and every registered-root parent is 403.
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(outside.path().join("sub")).unwrap();
        let (s403, _) = request(
            app.clone(),
            &format!(
                "/api/fs/browse?token=t&path={}/su",
                outside.path().to_string_lossy()
            ),
            Some(OK_HOST),
            &[],
        )
        .await;
        assert_eq!(s403, StatusCode::FORBIDDEN);

        // Empty input lists nothing (no error); no token is 401.
        let (s_empty, ebody) =
            request(app.clone(), "/api/fs/browse?token=t", Some(OK_HOST), &[]).await;
        assert_eq!(s_empty, StatusCode::OK);
        assert!(ebody.contains(r#""entries":[]"#), "{ebody}");
        let (s401, _) = request(
            app,
            &format!("/api/fs/browse?path={}/wo", ws.to_string_lossy()),
            Some(OK_HOST),
            &[],
        )
        .await;
        assert_eq!(s401, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn guard_rejects_bad_host_missing_host_and_bad_origin() {
        let (s1, _) = request(router(None), "/healthz", Some("evil.com"), &[]).await;
        assert_eq!(s1, StatusCode::FORBIDDEN);
        let (s2, _) = request(router(None), "/healthz", None, &[]).await;
        assert_eq!(s2, StatusCode::FORBIDDEN);
        let (s3, _) = request(
            router(None),
            "/healthz",
            Some(OK_HOST),
            &[("origin", "http://evil.example")],
        )
        .await;
        assert_eq!(s3, StatusCode::FORBIDDEN);
        let (s4, _) = request(
            router(None),
            "/healthz",
            Some(OK_HOST),
            &[("origin", "http://localhost:5173")],
        )
        .await;
        assert_eq!(s4, StatusCode::OK);
    }

    #[tokio::test]
    async fn serves_client_dist_index_at_root() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("index.html"), "<!doctype html>zk").unwrap();
        let app = build_router(ServerConfig {
            client_dist: Some(dir.path().to_path_buf()),
            ..Default::default()
        });
        let (status, body) = request(app, "/", Some(OK_HOST), &[]).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, "<!doctype html>zk");
    }
}
