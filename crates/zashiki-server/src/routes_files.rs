use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};

use crate::app_state::{scan, AppState};
use crate::search;

/// Lists every non-ignored file across all scanned repos for the quick-open palette
/// (`rg --files` in a single process). The active-org ranking is done client-side.
pub(crate) async fn files_route(State(state): State<AppState>) -> Response {
    let roots: Vec<search::ScannedRoot> = scan(&state)
        .await
        .into_iter()
        .map(|r| search::ScannedRoot {
            org: r.org,
            repo: r.repo,
            path: r.path,
        })
        .collect();
    let paths: Vec<String> = roots.iter().map(|r| r.path.clone()).collect();
    let program = crate::session_launch::resolve_program("rg");
    match search::run_ripgrep(&program, &["--files".to_string()], &paths).await {
        Ok(stdout) => {
            Json(search::parse_rg_files(&stdout, &roots, search::FILE_LIST_MAX)).into_response()
        }
        Err(_) => {
            if let Some(control) = &state.control {
                control.hub.record_boundary_failure(
                    crate::notifications::BoundaryFailure::RgMissing,
                    crate::now_ms(),
                );
            }
            (StatusCode::INTERNAL_SERVER_ERROR, "ripgrep unavailable").into_response()
        }
    }
}
