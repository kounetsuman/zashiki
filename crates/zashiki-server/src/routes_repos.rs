use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};

use crate::app_state::{scan, AppState};
use crate::control::RefreshRequest;
use crate::wire_support::json_error_with_code;
use crate::{fs, repos};

/// Response for `GET /api/fs/repos` (`FsReposResponse`).
#[derive(Serialize)]
pub(crate) struct FsReposResponse {
    repos: Vec<FsRepo>,
}

#[derive(Serialize)]
pub(crate) struct FsRepo {
    org: String,
    repo: String,
    path: String,
}

/// Response for `GET /api/repos/list` (`ReposListResponse`).
#[derive(Serialize)]
pub(crate) struct ReposListResponse {
    orgs: Vec<OrgRootEntry>,
}

#[derive(Serialize)]
pub(crate) struct OrgRootEntry {
    org: String,
    path: String,
}

/// `GET /api/repos/list`. Lists the registered org roots from repos.conf as {org (root basename), path
/// (absolute)}, so the add-org modal can show what is already registered. Graceful (empty) when no conf.
pub(crate) async fn repos_list(State(state): State<AppState>) -> Json<ReposListResponse> {
    let conf = state.repos_conf.as_ref().clone();
    let roots = tokio::task::spawn_blocking(move || match conf.as_deref() {
        Some(path) => repos::read_repos_state(path).roots,
        None => Vec::new(),
    })
    .await
    .unwrap_or_default();
    let orgs = roots
        .into_iter()
        .filter_map(|path| {
            // Skip a degenerate root with no final segment (only `/`); its empty org would fail the
            // client's `org: min(1)` schema and blank the whole list.
            let org = std::path::Path::new(&path)
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .filter(|s| !s.is_empty())?;
            Some(OrgRootEntry { org, path })
        })
        .collect();
    Json(ReposListResponse { orgs })
}

/// All repos under repos.conf (org/repo/path).
pub(crate) async fn fs_repos(State(state): State<AppState>) -> Json<FsReposResponse> {
    let repos = scan(&state)
        .await
        .into_iter()
        .map(|r| FsRepo {
            org: r.org,
            repo: r.repo,
            path: r.path,
        })
        .collect();
    Json(FsReposResponse { repos })
}

#[derive(Deserialize)]
struct AddRepoBody {
    path: String,
    color: Option<String>,
}

/// `POST /api/repos/add`. Registers a directory as a new org root: validates it, appends a line to
/// repos.conf (the path verbatim so `~` stays portable), then reloads the live repos state and nudges
/// the poller so the org appears in state.sync without a restart. Returns `{"org": <basename>}`.
pub(crate) async fn repos_add(State(state): State<AppState>, body: axum::body::Bytes) -> Response {
    // The error `code` is stable and localized by the client; the `error` string is a human-readable fallback.
    let Some(conf_path) = (*state.repos_conf).clone() else {
        return json_error_with_code(
            StatusCode::SERVICE_UNAVAILABLE,
            "repos.conf path is not configured",
            "no_conf",
        );
    };
    let Ok(req) = serde_json::from_slice::<AddRepoBody>(&body) else {
        return json_error_with_code(
            StatusCode::BAD_REQUEST,
            "invalid request body",
            "invalid_body",
        );
    };
    let path = req.path.trim().to_string();
    if path.is_empty() {
        return json_error_with_code(
            StatusCode::BAD_REQUEST,
            "path must not be empty",
            "path_empty",
        );
    }
    if let Some(color) = req.color.as_deref() {
        if !repos::is_valid_color_token(color) {
            return json_error_with_code(
                StatusCode::BAD_REQUEST,
                "color must be a #rgb or #rrggbb token",
                "color_invalid",
            );
        }
    }
    let org = match repos::classify_add_path(&conf_path, &path) {
        repos::AddPathStatus::PathUnresolved => {
            return json_error_with_code(
                StatusCode::BAD_REQUEST,
                "path could not be resolved",
                "path_unresolved",
            );
        }
        repos::AddPathStatus::NotADirectory => {
            return json_error_with_code(
                StatusCode::BAD_REQUEST,
                "path is not an existing directory",
                "not_a_directory",
            );
        }
        repos::AddPathStatus::NoDirName => {
            return json_error_with_code(
                StatusCode::BAD_REQUEST,
                "path has no final directory name",
                "no_dir_name",
            );
        }
        repos::AddPathStatus::Duplicate => {
            return json_error_with_code(
                StatusCode::CONFLICT,
                "this path is already registered",
                "duplicate",
            );
        }
        repos::AddPathStatus::Ok(org) => org,
    };
    match repos::append_root_to_conf(&conf_path, &path, req.color.as_deref()) {
        Err(e) => {
            return json_error_with_code(
                StatusCode::INTERNAL_SERVER_ERROR,
                &e.to_string(),
                "io",
            )
        }
        Ok(repos::AddOutcome::Duplicate) => {
            return json_error_with_code(
                StatusCode::CONFLICT,
                "this path is already registered",
                "duplicate",
            );
        }
        Ok(repos::AddOutcome::Added(_)) => {}
    }
    // Reflect immediately: refresh the shared live set from the file, then re-evaluate the poller.
    if let Some(control) = &state.control {
        if let Ok(mut guard) = control.repos.write() {
            *guard = repos::read_repos_state(&conf_path);
        }
        let _ = control.refresh.send(RefreshRequest { reply: None }).await;
    }
    Json(serde_json::json!({ "org": org })).into_response()
}

#[derive(Deserialize)]
pub(crate) struct ValidateParams {
    path: Option<String>,
}

/// `GET /api/fs/validate`. Previews whether `path` could be added as an org root, using the same
/// `classify_add_path` as `POST /api/repos/add` so the modal's inline hint never disagrees with the add.
/// Never enumerates a directory — it only reports the single path's status (and org name on `ok`).
pub(crate) async fn fs_validate(
    State(state): State<AppState>,
    Query(params): Query<ValidateParams>,
) -> Response {
    let path = params.path.unwrap_or_default().trim().to_string();
    if path.is_empty() {
        return json_error_with_code(
            StatusCode::BAD_REQUEST,
            "path must not be empty",
            "path_empty",
        );
    }
    let Some(conf_path) = (*state.repos_conf).clone() else {
        return json_error_with_code(
            StatusCode::SERVICE_UNAVAILABLE,
            "repos.conf path is not configured",
            "no_conf",
        );
    };
    let Ok(status) =
        tokio::task::spawn_blocking(move || repos::classify_add_path(&conf_path, &path)).await
    else {
        return json_error_with_code(
            StatusCode::INTERNAL_SERVER_ERROR,
            "validate task failed",
            "io",
        );
    };
    let (code, org) = match status {
        repos::AddPathStatus::Ok(org) => ("ok", Some(org)),
        repos::AddPathStatus::PathUnresolved => ("path_unresolved", None),
        repos::AddPathStatus::NotADirectory => ("not_a_directory", None),
        repos::AddPathStatus::NoDirName => ("no_dir_name", None),
        repos::AddPathStatus::Duplicate => ("duplicate", None),
    };
    // Omit `org` (rather than null) when absent, so the client's `.optional()` schema accepts it.
    let mut body = serde_json::json!({ "status": code });
    if let Some(org) = org {
        body["org"] = serde_json::Value::String(org);
    }
    Json(body).into_response()
}

#[derive(Deserialize)]
pub(crate) struct BrowseParams {
    path: Option<String>,
}

/// `GET /api/fs/browse`. Directory-completion for the org-add input: lists the subdirectories of the
/// parent of the in-progress `path` whose names start with the typed segment. Enumeration is confined to
/// `browse_roots` (HOME + parents of registered roots); an empty/`/`-less input lists nothing.
pub(crate) async fn fs_browse(
    State(state): State<AppState>,
    Query(params): Query<BrowseParams>,
) -> Response {
    let (parent_input, prefix) = fs::split_parent_prefix(params.path.unwrap_or_default().trim());
    let empty = Json(fs::FsListResponse {
        entries: Vec::new(),
        truncated: false,
    });
    if parent_input.is_empty() {
        return empty.into_response();
    }
    let Some(conf_path) = (*state.repos_conf).clone() else {
        return empty.into_response();
    };
    let Some(parent_abs) = repos::resolve_conf_path(&parent_input) else {
        return (StatusCode::BAD_REQUEST, "path could not be resolved").into_response();
    };
    let result = tokio::task::spawn_blocking(move || {
        let roots = repos::browse_roots(&conf_path);
        fs::browse_dirs(&parent_abs, &roots, &prefix, fs::DEFAULT_ENTRY_LIMIT)
    })
    .await
    .unwrap_or_else(|_| {
        Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            "browse task failed".to_string(),
        ))
    });
    match result {
        Ok((entries, truncated)) => Json(fs::FsListResponse { entries, truncated }).into_response(),
        Err((code, msg)) => (code, msg).into_response(),
    }
}

// ---- /api/repos/add wiring (validation + append via in-process HTTP) ----

#[cfg(test)]
mod repos_add_rest_tests {
    use crate::{build_router, ServerConfig};
    use axum::body::{to_bytes, Body};
    use axum::http::{Request as HttpRequest, StatusCode};
    use tower::ServiceExt;

    const OK_HOST: &str = "127.0.0.1:8790";

    fn app(conf: std::path::PathBuf) -> axum::Router {
        build_router(ServerConfig {
            expected_token: Some(secrecy::SecretString::new("t".to_string())),
            repos_conf: Some(conf),
            ..Default::default()
        })
    }

    async fn send(app: axum::Router, body: &str) -> (StatusCode, String) {
        let req = HttpRequest::builder()
            .method("POST")
            .uri("/api/repos/add?token=t")
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

    fn make_dir(parent: &std::path::Path, name: &str) -> String {
        let p = parent.join(name);
        std::fs::create_dir_all(&p).unwrap();
        p.to_string_lossy().into_owned()
    }

    #[tokio::test]
    async fn add_valid_directory_writes_line_and_returns_org() {
        let dir = tempfile::tempdir().unwrap();
        let conf = dir.path().join("repos.conf");
        let path = make_dir(dir.path(), "myorg");
        let (s, b) = send(
            app(conf.clone()),
            &format!(r##"{{"path":"{path}","color":"#7aa2f7"}}"##),
        )
        .await;
        assert_eq!(s, StatusCode::OK, "body: {b}");
        assert!(b.contains(r#""org":"myorg""#), "body: {b}");
        let written = std::fs::read_to_string(&conf).unwrap();
        assert!(
            written.contains(&path) && written.contains("#7aa2f7"),
            "conf: {written}"
        );
    }

    #[tokio::test]
    async fn add_duplicate_returns_409() {
        let dir = tempfile::tempdir().unwrap();
        let conf = dir.path().join("repos.conf");
        let path = make_dir(dir.path(), "dup");
        std::fs::write(&conf, format!("{path}\n")).unwrap();
        let (s, _b) = send(app(conf), &format!(r#"{{"path":"{path}"}}"#)).await;
        assert_eq!(s, StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn add_nonexistent_path_returns_400() {
        let dir = tempfile::tempdir().unwrap();
        let conf = dir.path().join("repos.conf");
        let missing = dir.path().join("nope").to_string_lossy().into_owned();
        let (s, _b) = send(app(conf), &format!(r#"{{"path":"{missing}"}}"#)).await;
        assert_eq!(s, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn add_invalid_color_returns_400() {
        let dir = tempfile::tempdir().unwrap();
        let conf = dir.path().join("repos.conf");
        let path = make_dir(dir.path(), "c");
        let (s, _b) = send(
            app(conf),
            &format!(r#"{{"path":"{path}","color":"blue"}}"#),
        )
        .await;
        assert_eq!(s, StatusCode::BAD_REQUEST);
    }

    /// End-to-end: with a live control runtime, adding an org updates the shared live set and the
    /// new org appears in state.sync without a restart (the core "immediate reflection" contract).
    #[tokio::test]
    async fn add_reflects_in_shared_state_and_state_sync() {
        use crate::control::ConfigView;
        use crate::protocol::ServerMessage;
        use crate::runtime::{spawn_control_runtime, ControlRuntimeConfig};
        use std::time::Duration;

        let dir = tempfile::tempdir().unwrap();
        let conf = dir.path().join("repos.conf");
        std::fs::write(&conf, "").unwrap();
        let org_dir = make_dir(dir.path(), "freshorg");

        let services = spawn_control_runtime(ControlRuntimeConfig {
            projects_root: dir.path().to_path_buf(),
            repos_roots: vec![],
            org_colors: std::collections::BTreeMap::new(),
            repos_conf: Some(conf.clone()),
            poll_sec: 0.05,
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
        let repos_handle = services.repos.clone();
        let mut rx = services.hub.subscribe();

        let router = build_router(ServerConfig {
            expected_token: Some(secrecy::SecretString::new("t".to_string())),
            repos_conf: Some(conf.clone()),
            control: Some(services),
            ..Default::default()
        });
        let (s, b) = send(router, &format!(r#"{{"path":"{org_dir}"}}"#)).await;
        assert_eq!(s, StatusCode::OK, "body: {b}");

        // The live set is updated synchronously by the endpoint (no restart).
        assert!(
            repos_handle
                .read()
                .unwrap()
                .roots
                .iter()
                .any(|r| r.ends_with("freshorg")),
            "shared roots should include the added org"
        );

        // The poller re-evaluates and publishes state.sync carrying the new org.
        let found = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Ok(ServerMessage::StateSync { orgs, .. }) = rx.recv().await {
                    if orgs.contains(&"freshorg".to_string()) {
                        return true;
                    }
                }
            }
        })
        .await
        .unwrap_or(false);
        assert!(found, "state.sync should carry the newly added org");
    }
}
