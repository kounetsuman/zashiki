use axum::{
    extract::{Request, State},
    http::{header, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};

use crate::app_state::AppState;
use crate::security::{is_allowed_host, is_allowed_origin, token_from_query, token_matches};

/// Guard for token-required routes. Passes if either the query ?token= or x-zashiki-token matches.
pub(crate) async fn require_token(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Response {
    let header = req
        .headers()
        .get("x-zashiki-token")
        .and_then(|v| v.to_str().ok());
    let query_token = token_from_query(req.uri().query());
    let expected = state.expected_token.as_ref().as_ref().map(secrecy::ExposeSecret::expose_secret);
    let ok = match expected {
        Some(expected) if !expected.is_empty() => {
            token_matches(query_token, expected) || token_matches(header, expected)
        }
        _ => false,
    };
    if ok {
        next.run(req).await
    } else {
        (StatusCode::UNAUTHORIZED, "unauthorized").into_response()
    }
}

/// Verifies Host/Origin and rejects anything outside the localhost family with 403 (all routes, including static serving).
pub(crate) async fn host_origin_guard(req: Request, next: Next) -> Response {
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok());
    if !is_allowed_host(host) {
        return (StatusCode::FORBIDDEN, "forbidden host").into_response();
    }
    let origin = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok());
    if !is_allowed_origin(origin) {
        return (StatusCode::FORBIDDEN, "forbidden origin").into_response();
    }
    next.run(req).await
}
