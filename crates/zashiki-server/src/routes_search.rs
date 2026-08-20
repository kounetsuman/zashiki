use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};

use crate::app_state::{scan, AppState};
use crate::search;

/// Cross-repo text search (runs ripgrep in a single process across all scanned repos).
pub(crate) async fn search_route(
    State(state): State<AppState>,
    Json(req): Json<search::SearchRequest>,
) -> Response {
    if req.query.is_empty() {
        return (StatusCode::BAD_REQUEST, "query is required").into_response();
    }
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
    let args = search::build_rg_args(&req, &search::DEFAULT_SEARCH_LIMITS);
    match search::run_ripgrep(&args, &paths).await {
        Ok(stdout) => Json(search::parse_rg_json(
            &stdout,
            &roots,
            &search::DEFAULT_SEARCH_LIMITS,
        ))
        .into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "ripgrep unavailable").into_response(),
    }
}
