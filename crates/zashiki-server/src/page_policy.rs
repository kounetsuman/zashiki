//! Response headers for the client pages and assets served from the client dist.

use axum::{
    extract::Request,
    http::{header, HeaderValue},
    middleware::Next,
    response::Response,
};

/// Lets the cockpit run only its own bundled scripts. Styles may be inline because React, xterm,
/// and CodeMirror set them at run time. Images and frames may come from the web because the user
/// can load remote Markdown images and frame a web dashboard. Frames the cockpit creates from
/// `srcdoc` inherit this policy on top of their own.
pub const PAGE_CSP: &str = "default-src 'self'; \
script-src 'self'; \
style-src 'self' 'unsafe-inline'; \
img-src 'self' data: blob: https: http:; \
font-src 'self' data:; \
media-src 'self' blob:; \
connect-src 'self'; \
frame-src 'self' blob: https: http:; \
object-src 'none'; \
base-uri 'none'; \
frame-ancestors 'self'";

pub async fn with_page_headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(PAGE_CSP),
    );
    headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    response
}
