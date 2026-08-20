//! raw HTTP-over-TCP probing (only healthz / token verification on 127.0.0.1, so raw TCP suffices; avoid adding dependencies).

use std::io::{Read as _, Write as _};
use std::net::TcpStream;
use std::time::{Duration, Instant};

const CONNECT_TIMEOUT: Duration = Duration::from_millis(500);
const READ_CHUNK_TIMEOUT: Duration = Duration::from_millis(500);
/// Upper bound for a whole request (guaranteed to return even if the peer never closes the connection).
const RESPONSE_DEADLINE: Duration = Duration::from_secs(3);

pub fn http_get(
    port: u16,
    path: &str,
    extra_headers: &[(&str, &str)],
) -> std::io::Result<(u16, String)> {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT)?;
    stream.set_read_timeout(Some(READ_CHUNK_TIMEOUT))?;
    stream.set_write_timeout(Some(READ_CHUNK_TIMEOUT))?;
    let mut req = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n");
    for (name, value) in extra_headers {
        req.push_str(&format!("{name}: {value}\r\n"));
    }
    req.push_str("\r\n");
    stream.write_all(req.as_bytes())?;

    // The read timeout is per-read only, so against a peer that never closes the connection
    // read_to_end would be unbounded. Use incremental reads with an overall deadline plus
    // content-length completion detection.
    let deadline = Instant::now() + RESPONSE_DEADLINE;
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        if response_complete(&buf) {
            break;
        }
        if Instant::now() >= deadline {
            break;
        }
        match stream.read(&mut chunk) {
            Ok(0) => break, // EOF
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                continue; // per-read timeout; fall through to the deadline check
            }
            Err(e) => return Err(e),
        }
    }
    let text = String::from_utf8_lossy(&buf).into_owned();
    parse_http_response(&text).ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, "malformed HTTP response")
    })
}

/// Content-length-based response completion detection (node's res.end() produces a content-length
/// response). For header configurations where this cannot be determined, returns false and defers
/// to EOF or the deadline.
pub fn response_complete(buf: &[u8]) -> bool {
    let text = String::from_utf8_lossy(buf);
    let Some((head, body)) = text.split_once("\r\n\r\n") else {
        return false;
    };
    let Some(len) = head.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if name.trim().eq_ignore_ascii_case("content-length") {
            value.trim().parse::<usize>().ok()
        } else {
            None
        }
    }) else {
        return false;
    };
    body.len() >= len
}

pub fn parse_http_response(raw: &str) -> Option<(u16, String)> {
    let (head, body) = raw.split_once("\r\n\r\n").unwrap_or((raw, ""));
    let status_line = head.lines().next()?;
    let mut parts = status_line.split(' ');
    let version = parts.next()?;
    if !version.starts_with("HTTP/") {
        return None;
    }
    let status: u16 = parts.next()?.parse().ok()?;
    Some((status, body.to_string()))
}

/// To avoid mistaking the case where another process merely occupies 8790 for "the server is
/// running", checks the healthz body in addition to the status.
pub fn is_healthy_response(status: u16, body: &str) -> bool {
    status == 200 && body.contains("\"status\":\"ok\"")
}

pub fn check_health(port: u16) -> bool {
    matches!(http_get(port, "/healthz", &[]), Ok((status, body)) if is_healthy_response(status, &body))
}

/// Whether the server's `/` (static serving of the client dist, no token required) returns an HTML
/// document. Riding along on a server that does not serve it (occupying 8790 without a client dist)
/// makes `/` return 401/404 and leaves the WebView blank, so this detects that and turns it into an
/// error with remediation.
pub fn serves_client_ui(port: u16) -> bool {
    matches!(http_get(port, "/", &[]), Ok((status, body)) if status == 200 && is_html_document(&body))
}

/// Whether the response body is an HTML document (detecting the client's index.html). Ignores leading whitespace and is case-insensitive.
pub fn is_html_document(body: &str) -> bool {
    let head = body.trim_start().to_ascii_lowercase();
    head.starts_with("<!doctype html") || head.starts_with("<html")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    /// Disposable server that accepts a single connection and returns a fixed response.
    /// close_after=false is a "peer that never closes the connection" (reproducing the unbounded read).
    fn serve_once_opts(response: &'static str, close_after: bool) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(response.as_bytes());
                if !close_after {
                    std::thread::sleep(Duration::from_secs(20));
                }
            }
        });
        port
    }

    fn serve_once(response: &'static str) -> u16 {
        serve_once_opts(response, true)
    }

    fn closed_port() -> u16 {
        // A port bound and immediately dropped = a port that refuses connections.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    }

    #[test]
    fn parse_http_response_はステータスとボディを取り出す() {
        let raw = "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{\"status\":\"ok\"}";
        assert_eq!(
            parse_http_response(raw),
            Some((200, "{\"status\":\"ok\"}".to_string()))
        );
    }

    #[test]
    fn parse_http_response_はボディ無しも扱う() {
        assert_eq!(
            parse_http_response("HTTP/1.1 403 Forbidden\r\n\r\n"),
            Some((403, String::new()))
        );
    }

    #[test]
    fn parse_http_response_はhttpでないものを拒否する() {
        assert_eq!(parse_http_response("garbage"), None);
        assert_eq!(parse_http_response(""), None);
    }

    #[test]
    fn response_complete_はcontent_length到達で真() {
        assert!(response_complete(
            b"HTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\nhello"
        ));
        assert!(!response_complete(
            b"HTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\nhel"
        ));
        assert!(!response_complete(b"HTTP/1.1 200 OK\r\n")); // headers incomplete
        assert!(!response_complete(
            b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n0\r\n\r\n"
        )); // without content-length, defer to EOF/deadline
    }

    #[test]
    fn is_healthy_response_は200かつステータスokのみ真() {
        assert!(is_healthy_response(200, "{\"status\":\"ok\"}"));
        assert!(!is_healthy_response(200, "hello")); // another process occupying the port
        assert!(!is_healthy_response(403, "{\"status\":\"ok\"}"));
        assert!(!is_healthy_response(500, ""));
    }

    #[test]
    fn check_health_は実サーバ応答で判定する() {
        let healthy = serve_once(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 15\r\n\r\n{\"status\":\"ok\"}",
        );
        assert!(check_health(healthy));

        let forbidden = serve_once("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n");
        assert!(!check_health(forbidden));

        assert!(!check_health(closed_port()));
    }

    #[test]
    fn check_health_は接続を閉じないピアでも応答完了で即返る() {
        // The read timeout is per-read, so against a peer that never closes, read_to_end was
        // unbounded. Verify it returns without waiting for the deadline via content-length completion detection.
        let port = serve_once_opts(
            "HTTP/1.1 200 OK\r\ncontent-length: 15\r\n\r\n{\"status\":\"ok\"}",
            false,
        );
        let started = Instant::now();
        assert!(check_health(port));
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "完了検知で即返るべき（elapsed={:?}）",
            started.elapsed()
        );
    }

    #[test]
    fn http_get_は応答しないピアでもdeadlineで必ず返る() {
        // A peer that holds the connection with incomplete headers (neither response completion nor EOF arrives).
        let port = serve_once_opts("HTTP/1.1 200 OK\r\n", false);
        let started = Instant::now();
        // The return value's contents don't matter (lenient parsing may yield Ok). Only verify boundedness.
        let _ = http_get(port, "/healthz", &[]);
        assert!(
            started.elapsed() < RESPONSE_DEADLINE + Duration::from_secs(1),
            "deadline 超過（elapsed={:?}）",
            started.elapsed()
        );
    }

    #[test]
    fn is_html_document_は先頭がdoctype_htmlのみ真() {
        assert!(is_html_document("<!doctype html>\n<html></html>"));
        assert!(is_html_document("  \n<!DOCTYPE HTML>")); // whitespace + uppercase
        assert!(is_html_document("<html lang=\"ja\">"));
        assert!(!is_html_document("hello")); // the catch-all's implicit 200
        assert!(!is_html_document("{\"ok\":true}"));
        assert!(!is_html_document("")); // the empty body of 401/404
    }

    #[test]
    fn serves_client_ui_は200かつhtmlのみ真() {
        // A server that serves the client dist (returns index.html).
        let served = serve_once(
            "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: 15\r\n\r\n<!doctype html>",
        );
        assert!(serves_client_ui(served));

        // A server occupying the port without a client dist (`/` returns 401 via require_token).
        let unauthorized = serve_once("HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n");
        assert!(!serves_client_ui(unauthorized));

        // Even a 200 that is not HTML (such as the catch-all's hello) is treated as UI not served.
        let hello = serve_once("HTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\nhello");
        assert!(!serves_client_ui(hello));

        assert!(!serves_client_ui(closed_port()));
    }
}
