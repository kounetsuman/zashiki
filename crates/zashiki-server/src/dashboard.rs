//! Implementation of `GET /api/dashboard`: reads the single file named by the `dashboard.url`
//! setting. There is no path parameter, so the configured path is the whole readable scope.

use std::borrow::Cow;
use std::path::{Path, PathBuf};

use axum::http::StatusCode;

use crate::file::status_for_fs_error;

fn hex_value(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// Decodes the `%20`-style escapes a `file://` url carries. Invalid escapes are left as written.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let escape = (bytes[i] == b'%' && i + 2 < bytes.len())
            .then(|| hex_value(bytes[i + 1]).zip(hex_value(bytes[i + 2])))
            .flatten();
        match escape {
            Some((hi, lo)) => {
                out.push(hi * 16 + lo);
                i += 3;
            }
            None => {
                out.push(bytes[i]);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

const FILE_SCHEME: &str = "file://";

/// The extensions a dashboard file may have. The overlay frames the bytes as a page, and holding the
/// route to that keeps the setting from turning it into a reader for other files. Checked on the
/// resolved path, so a link named `board.html` cannot stand in for something else.
const HTML_EXTENSIONS: [&str; 2] = ["html", "htm"];

const LOCALHOST_AUTHORITY: &str = "localhost";

/// Strips `prefix` case-insensitively, as url schemes and hosts both are.
fn strip_prefix_ignore_case<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    let (head, rest) = value.split_at_checked(prefix.len())?;
    head.eq_ignore_ascii_case(prefix).then_some(rest)
}

/// The path part of a `file://` url, with the optional `localhost` authority dropped.
fn strip_file_scheme(value: &str) -> Option<&str> {
    let rest = strip_prefix_ignore_case(value, FILE_SCHEME)?;
    Some(strip_prefix_ignore_case(rest, LOCALHOST_AUTHORITY).unwrap_or(rest))
}

/// The absolute path the configured value names, or None when it names no local file (blank, a
/// remote url, or a relative path). Accepts a `file://` url, a leading `~`, and a plain path.
pub fn dashboard_path(url: &str, home: &Path) -> Option<PathBuf> {
    let value = url.trim();
    let raw = match strip_file_scheme(value) {
        Some(rest) => Cow::Owned(percent_decode(rest)),
        None if value.contains("://") => return None,
        None => Cow::Borrowed(value),
    };
    let path = match raw.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None => PathBuf::from(raw.as_ref()),
    };
    path.is_absolute().then_some(path)
}

/// Reads the configured dashboard file (blocking; callers use spawn_blocking).
pub fn read_dashboard_file(
    url: &str,
    home: &Path,
    max_bytes: u64,
) -> Result<String, (StatusCode, String)> {
    let Some(path) = dashboard_path(url, home) else {
        return Err((
            StatusCode::BAD_REQUEST,
            "the dashboard address is not a local file path".to_string(),
        ));
    };
    let resolved = std::fs::canonicalize(&path).map_err(|e| status_for_fs_error(&e))?;
    let is_html = resolved
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| HTML_EXTENSIONS.iter().any(|h| e.eq_ignore_ascii_case(h)));
    if !is_html {
        return Err((
            StatusCode::BAD_REQUEST,
            "the dashboard file must be an .html file".to_string(),
        ));
    }
    let meta = std::fs::metadata(&resolved).map_err(|e| status_for_fs_error(&e))?;
    if !meta.is_file() {
        return Err((StatusCode::BAD_REQUEST, "not a file".to_string()));
    }
    if meta.len() > max_bytes {
        return Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            "dashboard file too large to display".to_string(),
        ));
    }
    let bytes = std::fs::read(&resolved).map_err(|e| status_for_fs_error(&e))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOME: &str = "/Users/me";

    fn resolve(url: &str) -> Option<PathBuf> {
        dashboard_path(url, Path::new(HOME))
    }

    #[test]
    fn resolves_an_absolute_path_a_file_url_and_a_tilde() {
        assert_eq!(
            resolve("/Users/me/board.html"),
            Some(PathBuf::from("/Users/me/board.html"))
        );
        assert_eq!(
            resolve("file:///Users/me/board.html"),
            Some(PathBuf::from("/Users/me/board.html"))
        );
        assert_eq!(
            resolve("file://localhost/Users/me/board.html"),
            Some(PathBuf::from("/Users/me/board.html"))
        );
        assert_eq!(
            resolve("~/board.html"),
            Some(PathBuf::from("/Users/me/board.html"))
        );
        assert_eq!(
            resolve("  /Users/me/board.html  "),
            Some(PathBuf::from("/Users/me/board.html"))
        );
    }

    #[test]
    fn accepts_the_file_scheme_in_any_case() {
        assert_eq!(
            resolve("FILE:///Users/me/board.html"),
            Some(PathBuf::from("/Users/me/board.html"))
        );
        assert_eq!(
            resolve("File://localhost/Users/me/board.html"),
            Some(PathBuf::from("/Users/me/board.html"))
        );
        assert_eq!(
            resolve("file://LOCALHOST/Users/me/board.html"),
            Some(PathBuf::from("/Users/me/board.html"))
        );
    }

    #[test]
    fn decodes_escapes_in_a_file_url() {
        assert_eq!(
            resolve("file:///Users/me/My%20Board.html"),
            Some(PathBuf::from("/Users/me/My Board.html"))
        );
        assert_eq!(
            resolve("file:///Users/me/100%25.html"),
            Some(PathBuf::from("/Users/me/100%.html"))
        );
        assert_eq!(
            resolve("file:///Users/me/a%zz.html"),
            Some(PathBuf::from("/Users/me/a%zz.html"))
        );
    }

    #[test]
    fn names_no_file_for_blank_remote_or_relative_values() {
        assert_eq!(resolve(""), None);
        assert_eq!(resolve("   "), None);
        assert_eq!(resolve("https://dash.example/board"), None);
        assert_eq!(resolve("http://127.0.0.1:9000/"), None);
        assert_eq!(resolve("board.html"), None);
        assert_eq!(resolve("./board.html"), None);
    }

    fn temp_dashboard(content: &str) -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("board.html");
        std::fs::write(&file, content).unwrap();
        let url = file.to_string_lossy().into_owned();
        (dir, url)
    }

    #[test]
    fn reads_the_configured_file() {
        let (_d, url) = temp_dashboard("<h1>hi</h1>\n");
        assert_eq!(
            read_dashboard_file(&url, Path::new(HOME), 1024).unwrap(),
            "<h1>hi</h1>\n"
        );
    }

    #[test]
    fn an_address_that_is_not_a_local_path_has_no_file_to_read() {
        for url in ["https://dash.example", "ftp://host/board.html", "board.html", ""] {
            let (code, msg) = read_dashboard_file(url, Path::new(HOME), 1024).unwrap_err();
            assert_eq!(code, StatusCode::BAD_REQUEST, "{url}");
            assert_eq!(msg, "the dashboard address is not a local file path", "{url}");
        }
    }

    #[test]
    fn refuses_to_read_a_file_that_is_not_a_page() {
        let dir = tempfile::tempdir().unwrap();
        let secret = dir.path().join("id_rsa");
        std::fs::write(&secret, "PRIVATE KEY\n").unwrap();
        let (code, msg) =
            read_dashboard_file(&secret.to_string_lossy(), Path::new(HOME), 1024).unwrap_err();
        assert_eq!(code, StatusCode::BAD_REQUEST);
        assert_eq!(msg, "the dashboard file must be an .html file");
    }

    #[cfg(unix)]
    #[test]
    fn a_link_named_like_a_page_cannot_stand_in_for_another_file() {
        let dir = tempfile::tempdir().unwrap();
        let secret = dir.path().join("id_rsa");
        std::fs::write(&secret, "PRIVATE KEY\n").unwrap();
        let link = dir.path().join("board.html");
        std::os::unix::fs::symlink(&secret, &link).unwrap();
        let (code, msg) =
            read_dashboard_file(&link.to_string_lossy(), Path::new(HOME), 1024).unwrap_err();
        assert_eq!(code, StatusCode::BAD_REQUEST);
        assert_eq!(msg, "the dashboard file must be an .html file");
        assert_eq!(std::fs::read_to_string(&secret).unwrap(), "PRIVATE KEY\n");
    }

    #[cfg(unix)]
    #[test]
    fn a_link_to_a_page_is_followed() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real.html");
        std::fs::write(&real, "<h1>goals</h1>\n").unwrap();
        let link = dir.path().join("board.html");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert_eq!(
            read_dashboard_file(&link.to_string_lossy(), Path::new(HOME), 1024).unwrap(),
            "<h1>goals</h1>\n"
        );
    }

    #[test]
    fn reads_either_html_extension_in_any_case() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["board.htm", "board.HTML"] {
            let file = dir.path().join(name);
            std::fs::write(&file, "<h1>hi</h1>\n").unwrap();
            assert_eq!(
                read_dashboard_file(&file.to_string_lossy(), Path::new(HOME), 1024).unwrap(),
                "<h1>hi</h1>\n",
                "{name}"
            );
        }
    }

    #[test]
    fn missing_file_is_404_and_a_directory_is_400() {
        let dir = tempfile::tempdir().unwrap();
        let (code, _) = read_dashboard_file(
            &dir.path().join("nope.html").to_string_lossy(),
            Path::new(HOME),
            1024,
        )
        .unwrap_err();
        assert_eq!(code, StatusCode::NOT_FOUND);

        let masquerading_dir = dir.path().join("board.html");
        std::fs::create_dir(&masquerading_dir).unwrap();
        let (code, msg) =
            read_dashboard_file(&masquerading_dir.to_string_lossy(), Path::new(HOME), 1024)
                .unwrap_err();
        assert_eq!(code, StatusCode::BAD_REQUEST);
        assert_eq!(msg, "not a file");
    }

    #[test]
    fn oversize_file_is_413() {
        let (_d, url) = temp_dashboard(&"x".repeat(100));
        let (code, _) = read_dashboard_file(&url, Path::new(HOME), 32).unwrap_err();
        assert_eq!(code, StatusCode::PAYLOAD_TOO_LARGE);
    }
}
