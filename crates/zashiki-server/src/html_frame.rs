//! The page the client loads in a sandboxed frame to show repo and dashboard HTML with that HTML's
//! own scripts running. The HTML arrives from the cockpit by message.

use axum::{
    http::{header, HeaderValue},
    response::{IntoResponse, Response},
};

pub const HTML_FRAME_PAGE: &str = include_str!("../assets/html-frame.html");

/// Leaves the shown HTML free to load what it needs, but keeps it in an opaque origin even when
/// the page is opened outside the cockpit's sandboxed frame.
pub const HTML_FRAME_CSP: &str = "sandbox allow-scripts; frame-ancestors 'self'";

pub async fn html_frame_page() -> Response {
    let mut response = (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        HTML_FRAME_PAGE,
    )
        .into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(HTML_FRAME_CSP),
    );
    headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    response
}
