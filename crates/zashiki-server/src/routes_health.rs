use axum::{extract::State, http::StatusCode, Json};
use serde::Serialize;

use crate::app_state::AppState;

/// Response for `GET /healthz`. Beyond `status`, it returns build identifiers (`version` / `git_sha`)
/// so the desktop shell can avoid piggybacking on a stale server.
#[derive(Serialize)]
pub(crate) struct HealthResponse {
    status: &'static str,
    version: &'static str,
    git_sha: &'static str,
    /// The pid of this server process. Lets a desktop that judged the server stale aim a precise
    /// SIGTERM at whoever holds the port (avoiding pid misidentification via lsof and hitting the wrong target).
    pid: u32,
}

/// Response for `GET /api/zk-shell/token-probe` (`{ ok: true }`).
#[derive(Serialize)]
pub(crate) struct TokenProbeResponse {
    ok: bool,
}

/// Response for `GET /api/last-crash`.
#[derive(Serialize)]
pub(crate) struct LastCrashResponse {
    log: Option<String>,
}

/// No authentication (healthz requires no token).
pub(crate) async fn healthz() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
        git_sha: env!("ZK_GIT_SHA"),
        pid: std::process::id(),
    })
}

/// token-probe. Since reaching here means it passed the auth middleware, it returns `{ ok: true }`.
pub(crate) async fn token_probe() -> Json<TokenProbeResponse> {
    Json(TokenProbeResponse { ok: true })
}

/// `GET /api/last-crash`. Idempotent read of the previous run's crash log tail (`null` when clean).
pub(crate) async fn last_crash(State(state): State<AppState>) -> Json<LastCrashResponse> {
    let log = state.last_crash.lock().ok().and_then(|g| g.clone());
    Json(LastCrashResponse { log })
}

/// `POST /api/last-crash/ack`. Clears the stored crash log once the client has shown it.
pub(crate) async fn ack_last_crash(State(state): State<AppState>) -> StatusCode {
    if let Ok(mut g) = state.last_crash.lock() {
        *g = None;
    }
    StatusCode::NO_CONTENT
}
