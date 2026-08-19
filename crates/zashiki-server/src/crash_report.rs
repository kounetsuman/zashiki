//! Surfacing the previous server run's log when it did not shut down cleanly.

use std::fs;
use std::io::{Read as _, Seek as _, SeekFrom};
use std::path::{Path, PathBuf};

/// Bytes read from the end of the log before line/char trimming.
pub const TAIL_READ_BYTES: u64 = 128 * 1024;
pub const TAIL_MAX_LINES: usize = 400;
pub const TAIL_MAX_BYTES: usize = 64 * 1024;

/// The running marker for `port`, next to the token file. Port-scoped so servers on different ports
/// don't clear each other's.
pub fn marker_path(token_file: &Path, port: u16) -> PathBuf {
    let dir = token_file.parent().unwrap_or_else(|| Path::new("."));
    dir.join(format!("server-running.{port}"))
}

/// The trailing slice of `content` for reporting: the last `max_lines` lines, then the trailing
/// `max_bytes` at a char boundary if still over. `None` when empty after trimming.
pub fn tail(content: &str, max_lines: usize, max_bytes: usize) -> Option<String> {
    let trimmed = content.trim_end_matches('\n');
    if trimmed.trim().is_empty() {
        return None;
    }
    let lines: Vec<&str> = trimmed.lines().collect();
    let start = lines.len().saturating_sub(max_lines);
    let by_lines = lines[start..].join("\n");
    Some(clamp_bytes(&by_lines, max_bytes))
}

/// Keeps the trailing `max_bytes` of `s`, cut on a char boundary.
fn clamp_bytes(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let mut cut = s.len() - max_bytes;
    while cut < s.len() && !s.is_char_boundary(cut) {
        cut += 1;
    }
    s[cut..].to_string()
}

/// Reads the reportable tail of the log at `path`, seeking to the last [`TAIL_READ_BYTES`] rather than
/// loading the whole file. `None` when the file is missing or empty.
pub fn read_tail(path: &Path) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let from = len.saturating_sub(TAIL_READ_BYTES);
    file.seek(SeekFrom::Start(from)).ok()?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    tail(&text, TAIL_MAX_LINES, TAIL_MAX_BYTES)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_is_none_for_empty_or_blank() {
        assert_eq!(tail("", 10, 1024), None);
        assert_eq!(tail("\n\n  \n", 10, 1024), None);
    }

    #[test]
    fn tail_returns_full_small_content() {
        assert_eq!(tail("a\nb\nc", 10, 1024), Some("a\nb\nc".to_string()));
    }

    #[test]
    fn tail_keeps_only_the_last_lines() {
        let content = (1..=10).map(|n| n.to_string()).collect::<Vec<_>>().join("\n");
        assert_eq!(tail(&content, 3, 1024), Some("8\n9\n10".to_string()));
    }

    #[test]
    fn tail_clamps_bytes_on_a_char_boundary() {
        let content = "あ".repeat(100);
        let out = tail(&content, 400, 10).unwrap();
        assert!(out.len() <= 10);
        assert!(content.ends_with(&out));
    }

    #[test]
    fn marker_path_is_port_scoped_next_to_token() {
        let p = marker_path(Path::new("/home/u/.zashiki/token"), 8790);
        assert_eq!(p, PathBuf::from("/home/u/.zashiki/server-running.8790"));
    }

    #[test]
    fn read_tail_none_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_tail(&dir.path().join("nope.log")), None);
    }

    #[test]
    fn read_tail_returns_end_of_a_large_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("err.log");
        let mut content = "filler line\n".repeat(50_000);
        content.push_str("panicked at 'boom'\n");
        fs::write(&path, &content).unwrap();
        let out = read_tail(&path).unwrap();
        assert!(out.contains("panicked at 'boom'"));
        assert!(out.len() <= TAIL_MAX_BYTES);
    }
}
