//! Per-org notes: free-form Markdown memos stored one file per org under `<repos.conf dir>/notes`.
//! The org identity (root basename) is the key, mirroring colors/aliases. The store is separate from
//! repos.conf so multi-line memos are edited independently; the canonical spec is the tests below.

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};

/// The notes directory that sits beside repos.conf (`<conf dir>/notes`), so an isolated conf path
/// (e.g. a test/sandbox override) keeps its notes isolated too.
pub fn notes_dir_for_conf(conf_path: &Path) -> PathBuf {
    conf_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("notes")
}

/// The `<org>.md` file name for an org, or None when the org is not a safe single path component
/// (guards the store against traversal via `/`, `..`, or embedded separators).
pub fn note_file_name(org: &str) -> Option<String> {
    if org.is_empty()
        || org == "."
        || org == ".."
        || org.contains('/')
        || org.contains('\\')
        || org.contains('\0')
    {
        return None;
    }
    Some(format!("{org}.md"))
}

/// Reads every `<org>.md` in `dir` into an org→text map (missing/unreadable dir yields empty; graceful).
pub fn read_notes(dir: &Path) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Some(org) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if let Ok(text) = std::fs::read_to_string(&path) {
            out.insert(org.to_string(), text);
        }
    }
    out
}

/// Writes an org's note atomically (temp + rename). A blank/whitespace-only `text` removes the note
/// file instead (an absent note is the empty state). An unsafe org name is rejected before any I/O.
pub fn write_note(dir: &Path, org: &str, text: &str) -> io::Result<()> {
    let Some(name) = note_file_name(org) else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "org is not a valid note name",
        ));
    };
    let path = dir.join(&name);
    if text.trim().is_empty() {
        return match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        };
    }
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(".{name}.tmp"));
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, &path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notes_dir_sits_beside_repos_conf() {
        assert_eq!(
            notes_dir_for_conf(Path::new("/home/u/.zashiki/repos.conf")),
            PathBuf::from("/home/u/.zashiki/notes")
        );
    }

    #[test]
    fn note_file_name_accepts_plain_org_and_rejects_traversal() {
        assert_eq!(note_file_name("frontend"), Some("frontend.md".to_string()));
        assert_eq!(note_file_name(""), None);
        assert_eq!(note_file_name("."), None);
        assert_eq!(note_file_name(".."), None);
        assert_eq!(note_file_name("a/b"), None);
        assert_eq!(note_file_name("../etc/passwd"), None);
    }

    #[test]
    fn write_then_read_round_trips_multiline_markdown() {
        let dir = tempfile::tempdir().unwrap();
        let notes = dir.path().join("notes");
        let body = "# Team\n\n- customer org\n- Jira: FOO\n";
        write_note(&notes, "acme", body).unwrap();
        assert_eq!(
            read_notes(&notes),
            BTreeMap::from([("acme".to_string(), body.to_string())])
        );
    }

    #[test]
    fn blank_text_removes_the_note_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let notes = dir.path().join("notes");
        write_note(&notes, "acme", "keep").unwrap();
        // A blank save removes the file; re-removing a missing note is a no-op (not an error).
        write_note(&notes, "acme", "   \n").unwrap();
        assert!(read_notes(&notes).is_empty());
        write_note(&notes, "acme", "").unwrap();
        assert!(read_notes(&notes).is_empty());
    }

    #[test]
    fn read_notes_missing_dir_is_empty() {
        assert!(read_notes(Path::new("/no/such/notes")).is_empty());
    }

    #[test]
    fn write_note_rejects_unsafe_org_before_touching_disk() {
        let dir = tempfile::tempdir().unwrap();
        let notes = dir.path().join("notes");
        let err = write_note(&notes, "../evil", "x").unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert!(!notes.exists());
    }
}
