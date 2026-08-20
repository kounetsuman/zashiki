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
