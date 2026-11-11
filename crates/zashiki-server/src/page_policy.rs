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

/// The page that shows repo and dashboard HTML with that HTML's own scripts running.
pub const HTML_FRAME_PATH: &str = "/html-frame.html";

/// Leaves the shown HTML free to load what it needs, but keeps it in an opaque origin even when
/// the page is opened outside the app's sandboxed frame, and lets only the app frame it.
pub const HTML_FRAME_CSP: &str = "sandbox allow-scripts; frame-ancestors 'self'";

pub async fn with_page_headers(request: Request, next: Next) -> Response {
    let csp = if request.uri().path() == HTML_FRAME_PATH {
        HTML_FRAME_CSP
    } else {
        PAGE_CSP
    };
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(csp));
    headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    response
}
