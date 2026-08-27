//! A single app-wide memo: a free-form Markdown scratchpad stored as `<repos.conf dir>/memo.md`.
//! Unlike per-org notes (one file per org), the memo is one shared document; the canonical spec is
//! the tests below.

use std::io;
use std::path::{Path, PathBuf};

/// Must equal the client's `MEMO_MAX_CHARS`; enforced at the REST boundary, not here.
pub const MEMO_MAX_CHARS: usize = 100_000;

/// The `memo.md` file that sits beside repos.conf (`<conf dir>/memo.md`), so an isolated conf path
/// (e.g. a test/sandbox override) keeps its memo isolated too.
pub fn memo_path_for_conf(conf_path: &Path) -> PathBuf {
    conf_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("memo.md")
}

/// Reads the memo file's contents, or an empty String when it is missing or unreadable (graceful).
pub fn read_memo(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

/// Writes the memo atomically (temp + rename). A blank/whitespace-only `text` removes the file
/// instead (an absent memo is the empty state); removing a missing file is a no-op.
pub fn write_memo(path: &Path, text: &str) -> io::Result<()> {
    if text.trim().is_empty() {
        return match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        };
    }
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(".memo.md.tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memo_path_sits_beside_repos_conf() {
        assert_eq!(
            memo_path_for_conf(Path::new("/home/u/.zashiki/repos.conf")),
            PathBuf::from("/home/u/.zashiki/memo.md")
        );
    }

    #[test]
    fn write_then_read_round_trips_multiline_markdown() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memo.md");
        let body = "# Scratchpad\n\n- todo one\n- todo two\n";
        write_memo(&path, body).unwrap();
        assert_eq!(read_memo(&path), body);
    }

    #[test]
    fn blank_text_removes_the_memo_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memo.md");
        write_memo(&path, "keep").unwrap();
        // A blank save removes the file; re-removing a missing memo is a no-op (not an error).
        write_memo(&path, "   \n").unwrap();
        assert_eq!(read_memo(&path), "");
        write_memo(&path, "").unwrap();
        assert_eq!(read_memo(&path), "");
    }

    #[test]
    fn read_memo_missing_file_is_empty() {
        assert_eq!(read_memo(Path::new("/no/such/memo.md")), "");
    }
}
