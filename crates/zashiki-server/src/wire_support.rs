use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;

use crate::app_state::{scan, AppState};
use crate::{git, session_persist};

/// JSON error response of `{"error": msg}`.
pub(crate) fn json_error(status: StatusCode, msg: &str) -> Response {
    (status, Json(serde_json::json!({ "error": msg }))).into_response()
}

/// JSON response of `{"ok": true}` (the success body of stage/unstage/commit etc.).
pub(crate) fn json_ok() -> Response {
    Json(serde_json::json!({ "ok": true })).into_response()
}

/// JSON error response of `{"error": msg, "code": code}`. Unlike the git-side `json_error` that has
/// `{error}` only, the `code` is a persist-specific contract for PersistError.
pub(crate) fn json_error_with_code(status: StatusCode, msg: &str, code: &str) -> Response {
    (
        status,
        Json(serde_json::json!({ "error": msg, "code": code })),
    )
        .into_response()
}

/// Maps `session_persist::PersistError` to an HTTP status + `code`.
pub(crate) fn persist_error_response(err: session_persist::PersistError) -> Response {
    use session_persist::PersistError::{Io, RestoreEmpty, RestoreFileNotFound, SaveEmpty};
    match err {
        SaveEmpty => json_error_with_code(
            StatusCode::CONFLICT,
            "no running claude session was found to save",
            "save_empty",
        ),
        RestoreFileNotFound(path) => json_error_with_code(
            StatusCode::NOT_FOUND,
            &format!("save file not found: {path}"),
            "restore_file_not_found",
        ),
        RestoreEmpty(path) => json_error_with_code(
            StatusCode::UNPROCESSABLE_ENTITY,
            &format!("save file has no restorable entry: {path}"),
            "restore_empty",
        ),
        // 500 has no code.
        Io(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

#[derive(Deserialize)]
pub(crate) struct GitFileBody {
    #[serde(rename = "repoPath")]
    pub(crate) repo_path: Option<String>,
    pub(crate) file: Option<String>,
}

/// Shared 400 error (`(status, msg)` is mapped to `json_error` at the handler boundary; keeps Err small).
pub(crate) type GuardErr = (StatusCode, String);

pub(crate) fn bad(msg: &str) -> GuardErr {
    (StatusCode::BAD_REQUEST, msg.to_string())
}

/// bytes to JSON. An empty body is treated as `{}`. Failure is 400 `invalid JSON body`.
pub(crate) fn parse_json_body<T: for<'de> Deserialize<'de>>(body: &[u8]) -> Result<T, GuardErr> {
    let trimmed = std::str::from_utf8(body).unwrap_or("").trim();
    let value: serde_json::Value = if trimmed.is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str(trimmed).map_err(|_| bad("invalid JSON body"))?
    };
    serde_json::from_value(value).map_err(|_| bad("request failed schema validation"))
}

/// Whether repoPath is in the scanned list (judged by the scan at each request).
pub(crate) async fn is_allowed_repo(state: &AppState, repo_path: &str) -> bool {
    scan(state).await.iter().any(|r| r.path == repo_path)
}

/// Shared guard for file actions (stage/unstage/open). Order: schema -> safe path -> repo allowlist.
/// Open additionally calls realpath verification.
pub(crate) async fn guard_file_action(
    state: &AppState,
    body: &[u8],
) -> Result<(String, String), GuardErr> {
    let parsed: GitFileBody = parse_json_body(body)?;
    // gitFileRequestSchema: repoPath.min(1) / file.min(1). Empty or missing is a schema violation.
    let (Some(repo_path), Some(file)) = (parsed.repo_path, parsed.file) else {
        return Err(bad("request failed schema validation"));
    };
    if repo_path.is_empty() || file.is_empty() {
        return Err(bad("request failed schema validation"));
    }
    if !zashiki_core::git::is_safe_repo_relative_path(&file) {
        return Err(bad("unsafe file path"));
    }
    if !is_allowed_repo(state, &repo_path).await {
        return Err(forbidden_repo());
    }
    Ok((repo_path, file))
}

pub(crate) fn forbidden_repo() -> GuardErr {
    (
        StatusCode::FORBIDDEN,
        "repoPath is not in the scanned repo list".to_string(),
    )
}

/// repoPath allowlist guard for repo actions (stage-all/unstage-all/commit).
pub(crate) async fn guard_repo(state: &AppState, repo_path: &str) -> Result<(), GuardErr> {
    if !is_allowed_repo(state, repo_path).await {
        return Err(forbidden_repo());
    }
    Ok(())
}

/// Maps a git mutation result to 200 `{ok:true}` / 500 `{error}` (failures become 500).
pub(crate) fn git_result(result: Result<(), git::GitError>) -> Response {
    match result {
        Ok(()) => json_ok(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

/// Allowlist + safe-path guard for `/api/file` (from realpath onward it's file.rs).
pub(crate) async fn guard_file_path(
    state: &AppState,
    repo_path: &str,
    file: &str,
) -> Result<(), GuardErr> {
    if repo_path.is_empty() || file.is_empty() {
        return Err(bad("repoPath and file are required"));
    }
    if !zashiki_core::git::is_safe_repo_relative_path(file) {
        return Err(bad("unsafe file path"));
    }
    if !is_allowed_repo(state, repo_path).await {
        return Err(forbidden_repo());
    }
    Ok(())
}
