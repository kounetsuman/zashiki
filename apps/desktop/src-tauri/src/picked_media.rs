//! Serves the media files chosen with Cmd+O to the WebView as `zkpicked://localhost/<id>?type=<mime>`,
//! in byte ranges, so a large video streams and seeks without being read into memory. Files are looked
//! up by the id of the latest pick, never by path, and served as the MIME type the client derived from
//! the extension (never sniffed), so a file cannot turn into a page that runs script.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use tauri::http::{header, Response, StatusCode, Uri};

pub const SCHEME: &str = "zkpicked";

/// The most bytes one ranged response carries; the WebView asks again for the rest.
const MAX_RANGE_BYTES: u64 = 4 * 1024 * 1024;

/// Same policy as the server's `/api/media`: inert for `<img>` / `<video>` / `<audio>`, and stops an
/// SVG opened as a page from running script. Left off PDFs, where it could stop the PDF viewer.
const MEDIA_CSP: &str = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

#[derive(Debug, PartialEq, Eq)]
pub struct MediaRequest {
    pub id: u64,
    pub mime: String,
}

fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn is_media_mime(mime: &str) -> bool {
    let well_formed = mime
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "/+.-".contains(c));
    let media = ["image/", "video/", "audio/"]
        .iter()
        .any(|prefix| mime.len() > prefix.len() && mime.starts_with(prefix));
    well_formed && (media || mime == "application/pdf")
}

/// The picked file id and media type a `zkpicked` URL asks for, or None when it is not one we serve.
pub fn parse_request(uri: &Uri) -> Option<MediaRequest> {
    let id = uri.path().strip_prefix('/')?.parse().ok()?;
    let mime = uri
        .query()?
        .split('&')
        .find_map(|pair| pair.strip_prefix("type="))
        .and_then(percent_decode)?;
    is_media_mime(&mime).then_some(MediaRequest { id, mime })
}

/// The inclusive byte range a `Range` header asks for, clamped to MAX_RANGE_BYTES, or None when it
/// cannot be satisfied. Only the first range of a multi-range request is honoured.
fn requested_range(range: &str, len: u64) -> Option<(u64, u64)> {
    let spec = range
        .trim()
        .strip_prefix("bytes=")?
        .split(',')
        .next()?
        .trim();
    let (start, end) = spec.split_once('-')?;
    let (start, end) = match (start.trim(), end.trim()) {
        ("", suffix) => {
            let suffix: u64 = suffix.parse().ok()?;
            (len.checked_sub(suffix.min(len))?, len.checked_sub(1)?)
        }
        (start, "") => (start.parse().ok()?, len.checked_sub(1)?),
        (start, end) => (
            start.parse().ok()?,
            end.parse::<u64>().ok()?.min(len.checked_sub(1)?),
        ),
    };
    if start > end || start >= len {
        return None;
    }
    Some((start, end.min(start + MAX_RANGE_BYTES - 1)))
}

pub fn not_found() -> Response<Vec<u8>> {
    status(StatusCode::NOT_FOUND)
}

fn status(code: StatusCode) -> Response<Vec<u8>> {
    let mut response = Response::new(Vec::new());
    *response.status_mut() = code;
    response
}

fn read_span(file: &mut File, start: u64, len: u64) -> std::io::Result<Vec<u8>> {
    file.seek(SeekFrom::Start(start))?;
    let mut body = Vec::with_capacity(len as usize);
    file.take(len).read_to_end(&mut body)?;
    Ok(body)
}

fn starts_like_a_pdf(file: &mut File) -> bool {
    let mut magic = [0u8; 5];
    file.read_exact(&mut magic).is_ok() && &magic == b"%PDF-"
}

/// The response for `path` served as `mime`, honouring a `Range` header.
pub fn respond(path: &Path, mime: &str, range: Option<&str>) -> Response<Vec<u8>> {
    let Ok(mut file) = File::open(path) else {
        return status(StatusCode::NOT_FOUND);
    };
    let Ok(len) = file.metadata().map(|meta| meta.len()) else {
        return status(StatusCode::NOT_FOUND);
    };
    let is_pdf = mime == "application/pdf";
    if is_pdf && !starts_like_a_pdf(&mut file) {
        return status(StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }
    let (code, start, end) = match range {
        None => (StatusCode::OK, 0, len.saturating_sub(1)),
        Some(range) => match requested_range(range, len) {
            Some((start, end)) => (StatusCode::PARTIAL_CONTENT, start, end),
            None => {
                let mut response = status(StatusCode::RANGE_NOT_SATISFIABLE);
                if let Ok(value) = format!("bytes */{len}").parse() {
                    response.headers_mut().insert(header::CONTENT_RANGE, value);
                }
                return response;
            }
        },
    };
    let span = if len == 0 { 0 } else { end - start + 1 };
    let Ok(body) = read_span(&mut file, start, span) else {
        return status(StatusCode::NOT_FOUND);
    };
    let mut builder = Response::builder()
        .status(code)
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff");
    if code == StatusCode::PARTIAL_CONTENT {
        builder = builder.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"));
    }
    if !is_pdf {
        builder = builder.header(header::CONTENT_SECURITY_POLICY, MEDIA_CSP);
    }
    builder
        .body(body)
        .unwrap_or_else(|_| status(StatusCode::INTERNAL_SERVER_ERROR))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uri(s: &str) -> Uri {
        s.parse().unwrap()
    }

    #[test]
    fn parses_the_id_and_decoded_media_type() {
        assert_eq!(
            parse_request(&uri("zkpicked://localhost/12?type=image%2Fsvg%2Bxml")),
            Some(MediaRequest {
                id: 12,
                mime: "image/svg+xml".to_string()
            })
        );
    }

    #[test]
    fn rejects_types_that_are_not_media() {
        for query in [
            "type=text%2Fhtml",
            "type=application%2Fjavascript",
            "type=image%2F",
            "type=image%2Fpng%3Bcharset%3Dx",
            "",
        ] {
            let url = format!("zkpicked://localhost/1?{query}");
            assert_eq!(parse_request(&uri(&url)), None, "{query}");
        }
        assert_eq!(
            parse_request(&uri("zkpicked://localhost/x?type=audio%2Faiff")),
            None
        );
    }

    #[test]
    fn clamps_ranges_to_the_file_and_the_chunk_cap() {
        assert_eq!(requested_range("bytes=0-1", 10), Some((0, 1)));
        assert_eq!(requested_range("bytes=4-", 10), Some((4, 9)));
        assert_eq!(requested_range("bytes=-3", 10), Some((7, 9)));
        assert_eq!(requested_range("bytes=5-99", 10), Some((5, 9)));
        assert_eq!(
            requested_range("bytes=0-", u64::MAX),
            Some((0, MAX_RANGE_BYTES - 1))
        );
        assert_eq!(requested_range("bytes=10-", 10), None);
        assert_eq!(requested_range("bytes=5-2", 10), None);
        assert_eq!(requested_range("items=0-1", 10), None);
    }

    #[test]
    fn serves_the_requested_bytes_with_a_fixed_type() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("Hero.aiff");
        std::fs::write(&path, b"0123456789").unwrap();
        let response = respond(&path, "audio/aiff", Some("bytes=2-4"));
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body(), b"234");
        let headers = response.headers();
        assert_eq!(headers[header::CONTENT_TYPE], "audio/aiff");
        assert_eq!(headers[header::CONTENT_RANGE], "bytes 2-4/10");
        assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(headers[header::CONTENT_SECURITY_POLICY], MEDIA_CSP);

        let whole = respond(&path, "audio/aiff", None);
        assert_eq!(whole.status(), StatusCode::OK);
        assert_eq!(whole.body(), b"0123456789");

        let past = respond(&path, "audio/aiff", Some("bytes=20-"));
        assert_eq!(past.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(past.headers()[header::CONTENT_RANGE], "bytes */10");
    }

    #[test]
    fn serves_a_pdf_only_when_it_is_one() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("spec.pdf");
        std::fs::write(&real, b"%PDF-1.7 ...").unwrap();
        let fake = dir.path().join("invoice.pdf");
        std::fs::write(&fake, b"<script>alert(1)</script>").unwrap();
        let ok = respond(&real, "application/pdf", None);
        assert_eq!(ok.status(), StatusCode::OK);
        assert!(ok.headers().get(header::CONTENT_SECURITY_POLICY).is_none());
        assert_eq!(
            respond(&fake, "application/pdf", None).status(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE
        );
    }

    #[test]
    fn a_missing_file_is_not_found() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            respond(&dir.path().join("gone.mp3"), "audio/mpeg", None).status(),
            StatusCode::NOT_FOUND
        );
    }
}
