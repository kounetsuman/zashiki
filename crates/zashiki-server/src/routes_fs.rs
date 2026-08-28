use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;

use crate::app_state::{scan, AppState};
use crate::wire_support::{guard_file_path, json_error, json_ok, parse_json_body};
use crate::{file, fs};

#[derive(Deserialize)]
pub(crate) struct FileReadParams {
    #[serde(rename = "repoPath")]
    repo_path: Option<String>,
    file: Option<String>,
}

pub(crate) async fn file_read(
    State(state): State<AppState>,
    Query(params): Query<FileReadParams>,
) -> Response {
    let repo_path = params.repo_path.unwrap_or_default();
    let file = params.file.unwrap_or_default();
    if let Err((status, msg)) = guard_file_path(&state, &repo_path, &file).await {
        return json_error(status, &msg);
    }
    let max = state.file_max_bytes;
    let result = tokio::task::spawn_blocking(move || file::read_within_repo(&repo_path, &file, max))
        .await
        .unwrap_or_else(|_| {
            Err((StatusCode::INTERNAL_SERVER_ERROR, "read task failed".to_string()))
        });
    match result {
        Ok(content) => Json(serde_json::json!({ "content": content })).into_response(),
        Err((status, msg)) => json_error(status, &msg),
    }
}

#[derive(Deserialize)]
struct FileWriteBody {
    #[serde(rename = "repoPath")]
    repo_path: Option<String>,
    file: Option<String>,
    content: Option<String>,
}

pub(crate) async fn file_write(State(state): State<AppState>, body: axum::body::Bytes) -> Response {
    let parsed: FileWriteBody = match parse_json_body(&body) {
        Err((status, msg)) => return json_error(status, &msg),
        Ok(v) => v,
    };
    // fileWriteRequestSchema: repoPath.min(1) / file.min(1) / content: string.
    let (Some(repo_path), Some(file), Some(content)) =
        (parsed.repo_path, parsed.file, parsed.content)
    else {
        return json_error(StatusCode::BAD_REQUEST, "request failed schema validation");
    };
    if repo_path.is_empty() || file.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "request failed schema validation");
    }
    if content.len() as u64 > state.file_max_bytes {
        return json_error(StatusCode::PAYLOAD_TOO_LARGE, "content too large to save");
    }
    if let Err((status, msg)) = guard_file_path(&state, &repo_path, &file).await {
        return json_error(status, &msg);
    }
    let result =
        tokio::task::spawn_blocking(move || file::write_within_repo(&repo_path, &file, &content))
            .await
            .unwrap_or_else(|_| {
                Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "write task failed".to_string(),
                ))
            });
    match result {
        Ok(()) => json_ok(),
        Err((status, msg)) => json_error(status, &msg),
    }
}

#[derive(Deserialize)]
pub(crate) struct ListParams {
    #[serde(rename = "repoPath")]
    repo_path: Option<String>,
    dir: Option<String>,
}

/// Lists the immediate children of a directory within a repo. repoPath must be in the scanned list, and
/// dir is confined by is_safe_repo_relative_path + realpath containment to block escaping outside the repo.
pub(crate) async fn fs_list(
    State(state): State<AppState>,
    Query(params): Query<ListParams>,
) -> Response {
    let repo_path = params.repo_path.unwrap_or_default();
    let dir = params.dir.unwrap_or_default();
    if repo_path.is_empty() {
        return (StatusCode::BAD_REQUEST, "repoPath is required").into_response();
    }
    // dir="" is the repo root. Since is_safe_repo_relative_path rejects "", allow it first.
    if !dir.is_empty() && !zashiki_core::git::is_safe_repo_relative_path(&dir) {
        return (StatusCode::BAD_REQUEST, "unsafe dir path").into_response();
    }
    if !scan(&state).await.iter().any(|r| r.path == repo_path) {
        return (
            StatusCode::FORBIDDEN,
            "repoPath is not in the scanned repo list",
        )
            .into_response();
    }
    let result = tokio::task::spawn_blocking(move || {
        fs::list_within_repo(&repo_path, &dir, fs::DEFAULT_ENTRY_LIMIT)
    })
    .await
    .unwrap_or_else(|_| {
        Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            "list task failed".to_string(),
        ))
    });
    match result {
        Ok((entries, truncated)) => Json(fs::FsListResponse { entries, truncated }).into_response(),
        Err((code, msg)) => (code, msg).into_response(),
    }
}

#[derive(Deserialize)]
struct FsRevealBody {
    #[serde(rename = "repoPath")]
    repo_path: Option<String>,
    path: Option<String>,
}

/// `POST /api/fs/reveal` — shows a repo entry in the OS file manager. Same three-layer guard as the other
/// fs routes (allowlist -> safe path -> realpath containment); the launch itself is best-effort.
pub(crate) async fn fs_reveal(State(state): State<AppState>, body: axum::body::Bytes) -> Response {
    let parsed: FsRevealBody = match parse_json_body(&body) {
        Err((status, msg)) => return json_error(status, &msg),
        Ok(v) => v,
    };
    let (Some(repo_path), Some(path)) = (parsed.repo_path, parsed.path) else {
        return json_error(StatusCode::BAD_REQUEST, "request failed schema validation");
    };
    if let Err((status, msg)) = guard_file_path(&state, &repo_path, &path).await {
        return json_error(status, &msg);
    }
    let resolved = tokio::task::spawn_blocking(move || fs::reveal_target(&repo_path, &path))
        .await
        .unwrap_or_else(|_| {
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                "reveal task failed".to_string(),
            ))
        });
    match resolved {
        Ok(abs) => {
            let _ = crate::app_state::spawn_reveal(&abs);
            json_ok()
        }
        Err((status, msg)) => json_error(status, &msg),
    }
}

#[derive(Deserialize)]
struct FsRenameBody {
    #[serde(rename = "repoPath")]
    repo_path: Option<String>,
    path: Option<String>,
    #[serde(rename = "newName")]
    new_name: Option<String>,
}

/// `POST /api/fs/rename` — renames an entry within its parent directory. Returns `{ok, newPath}` so the
/// client can retarget any open tab/buffer.
pub(crate) async fn fs_rename(State(state): State<AppState>, body: axum::body::Bytes) -> Response {
    let parsed: FsRenameBody = match parse_json_body(&body) {
        Err((status, msg)) => return json_error(status, &msg),
        Ok(v) => v,
    };
    let (Some(repo_path), Some(path), Some(new_name)) =
        (parsed.repo_path, parsed.path, parsed.new_name)
    else {
        return json_error(StatusCode::BAD_REQUEST, "request failed schema validation");
    };
    if !fs::is_single_path_segment(&new_name) {
        return json_error(StatusCode::BAD_REQUEST, "invalid new name");
    }
    if let Err((status, msg)) = guard_file_path(&state, &repo_path, &path).await {
        return json_error(status, &msg);
    }
    let result =
        tokio::task::spawn_blocking(move || fs::rename_within_repo(&repo_path, &path, &new_name))
            .await
            .unwrap_or_else(|_| {
                Err((
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "rename task failed".to_string(),
                ))
            });
    match result {
        Ok(new_path) => Json(serde_json::json!({ "ok": true, "newPath": new_path })).into_response(),
        Err((status, msg)) => json_error(status, &msg),
    }
}

#[derive(Deserialize)]
struct FsDeleteBody {
    #[serde(rename = "repoPath")]
    repo_path: Option<String>,
    path: Option<String>,
}

/// `POST /api/fs/delete` — moves a repo entry to the OS trash (recoverable, not an unlink).
pub(crate) async fn fs_delete(State(state): State<AppState>, body: axum::body::Bytes) -> Response {
    let parsed: FsDeleteBody = match parse_json_body(&body) {
        Err((status, msg)) => return json_error(status, &msg),
        Ok(v) => v,
    };
    let (Some(repo_path), Some(path)) = (parsed.repo_path, parsed.path) else {
        return json_error(StatusCode::BAD_REQUEST, "request failed schema validation");
    };
    if let Err((status, msg)) = guard_file_path(&state, &repo_path, &path).await {
        return json_error(status, &msg);
    }
    let result = tokio::task::spawn_blocking(move || fs::delete_to_trash(&repo_path, &path))
        .await
        .unwrap_or_else(|_| {
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                "delete task failed".to_string(),
            ))
        });
    match result {
        Ok(()) => json_ok(),
        Err((status, msg)) => json_error(status, &msg),
    }
}

#[cfg(test)]
mod fs_mutation_rest_tests {
    use crate::{build_router, ServerConfig};
    use axum::body::{to_bytes, Body};
    use axum::http::{Request as HttpRequest, StatusCode};
    use std::path::Path;
    use tower::ServiceExt;

    const OK_HOST: &str = "127.0.0.1:8790";

    /// A scanned repo (org1/repo-a with a .git marker) plus its repos.conf; returns (router, repo abs path).
    fn app_with_repo(root: &Path) -> (axum::Router, String) {
        let repo = root.join("org1/repo-a");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        let conf = root.join("repos.conf");
        std::fs::write(&conf, format!("{}\n", root.join("org1").display())).unwrap();
        let app = build_router(ServerConfig {
            expected_token: Some(secrecy::SecretString::new("t".to_string())),
            repos_conf: Some(conf),
            ..Default::default()
        });
        (app, repo.to_string_lossy().into_owned())
    }

    async fn post(app: axum::Router, uri: &str, body: &str) -> (StatusCode, String) {
        let req = HttpRequest::builder()
            .method("POST")
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
    async fn rename_renames_and_returns_new_path() {
        let root = tempfile::tempdir().unwrap();
        let (app, repo) = app_with_repo(root.path());
        let repo_dir = root.path().join("org1/repo-a");
        std::fs::create_dir_all(repo_dir.join("sub")).unwrap();
        std::fs::write(repo_dir.join("sub/old.txt"), "x").unwrap();

        let (s, b) = post(
            app,
            "/api/fs/rename?token=t",
            &format!(r#"{{"repoPath":"{repo}","path":"sub/old.txt","newName":"new.txt"}}"#),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(b, r#"{"ok":true,"newPath":"sub/new.txt"}"#);
        assert!(!repo_dir.join("sub/old.txt").exists());
        assert!(repo_dir.join("sub/new.txt").exists());
    }

    #[tokio::test]
    async fn rename_rejects_unsafe_new_name_and_unknown_repo() {
        let root = tempfile::tempdir().unwrap();
        let (app, repo) = app_with_repo(root.path());
        std::fs::write(root.path().join("org1/repo-a/a.txt"), "x").unwrap();

        let (s400, _) = post(
            app.clone(),
            "/api/fs/rename?token=t",
            &format!(r#"{{"repoPath":"{repo}","path":"a.txt","newName":"../escape"}}"#),
        )
        .await;
        assert_eq!(s400, StatusCode::BAD_REQUEST);

        let (s403, _) = post(
            app,
            "/api/fs/rename?token=t",
            r#"{"repoPath":"/tmp/not-scanned","path":"a.txt","newName":"b.txt"}"#,
        )
        .await;
        assert_eq!(s403, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn reveal_and_delete_enforce_the_repo_allowlist() {
        let root = tempfile::tempdir().unwrap();
        let (app, _repo) = app_with_repo(root.path());

        let (s_reveal, _) = post(
            app.clone(),
            "/api/fs/reveal?token=t",
            r#"{"repoPath":"/tmp/not-scanned","path":"a.txt"}"#,
        )
        .await;
        assert_eq!(s_reveal, StatusCode::FORBIDDEN);

        let (s_delete, _) = post(
            app,
            "/api/fs/delete?token=t",
            r#"{"repoPath":"/tmp/not-scanned","path":"a.txt"}"#,
        )
        .await;
        assert_eq!(s_delete, StatusCode::FORBIDDEN);
    }

    #[cfg(target_os = "macos")]
    #[ignore = "moves a real file to the OS trash; run with `cargo test -- --ignored`"]
    #[tokio::test]
    async fn delete_moves_a_repo_file_to_trash() {
        let root = tempfile::tempdir().unwrap();
        let (app, repo) = app_with_repo(root.path());
        let repo_dir = root.path().join("org1/repo-a");
        std::fs::write(repo_dir.join("trash-me.txt"), "x").unwrap();

        let (s, b) = post(
            app,
            "/api/fs/delete?token=t",
            &format!(r#"{{"repoPath":"{repo}","path":"trash-me.txt"}}"#),
        )
        .await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(b, r#"{"ok":true}"#);
        assert!(!repo_dir.join("trash-me.txt").exists());
    }
}
