use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;

use crate::app_state::{scan, AppState};
use crate::file_list::{self, FileListResponse, ListingPlan};
use crate::repos;
use crate::search::{self, ScannedRoot};

#[derive(Deserialize)]
pub(crate) struct FilesParams {
    /// The active terminal's working directory.
    cwd: Option<String>,
    /// A path query's directory (`/…` or `~/…`); when present, `cwd` is ignored.
    dir: Option<String>,
}

/// Lists non-ignored files for the quick-open palette: the active terminal's org (its repo first), or
/// a path query's directory. Ranking is done client-side.
pub(crate) async fn files_route(
    State(state): State<AppState>,
    Query(params): Query<FilesParams>,
) -> Response {
    let roots: Vec<ScannedRoot> = scan(&state)
        .await
        .into_iter()
        .map(|r| ScannedRoot {
            org: r.org,
            repo: r.repo,
            path: r.path,
        })
        .collect();
    let conf = state.repos_conf.as_ref().clone();
    let planned = tokio::task::spawn_blocking(move || {
        let plan = match params.dir {
            Some(dir) => path_query_plan(&dir, &roots),
            None => {
                let org_roots: Vec<String> = conf
                    .as_deref()
                    .map(repos::read_conf_roots)
                    .unwrap_or_default()
                    .iter()
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect();
                let org_roots: Vec<&str> = org_roots.iter().map(String::as_str).collect();
                file_list::workspace_plan(&roots, &org_roots, params.cwd.as_deref())
            }
        };
        (roots, plan)
    })
    .await;
    let Ok((roots, plan)) = planned else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "listing task failed").into_response();
    };

    let program = crate::session_launch::resolve_program("rg");
    let args = ["--files".to_string()];
    let [first, rest] = &plan.groups;
    let (first, rest) = tokio::join!(
        search::run_ripgrep(&program, &args, first),
        search::run_ripgrep(&program, &args, rest),
    );
    let (Ok(first), Ok(rest)) = (first, rest) else {
        if let Some(control) = &state.control {
            control.hub.record_boundary_failure(
                crate::notifications::BoundaryFailure::RgMissing,
                crate::now_ms(),
            );
        }
        return (StatusCode::INTERNAL_SERVER_ERROR, "ripgrep unavailable").into_response();
    };
    let (files, truncated) = file_list::parse_rg_files(
        &[first.as_str(), rest.as_str()],
        &roots,
        plan.org.as_deref(),
        file_list::FILE_LIST_MAX,
    );
    Json(FileListResponse {
        truncated,
        home: std::env::var("HOME").unwrap_or_default(),
        files,
    })
    .into_response()
}

/// Only absolute and home-relative directories are listed; anything else lists nothing.
fn path_query_plan(dir: &str, roots: &[ScannedRoot]) -> ListingPlan {
    let resolved = (dir.starts_with('/') || dir.starts_with("~/"))
        .then(|| repos::resolve_conf_path(dir))
        .flatten();
    match resolved {
        Some(abs) => file_list::path_plan(&abs, roots),
        None => ListingPlan {
            groups: [Vec::new(), Vec::new()],
            org: None,
        },
    }
}
