//! Media files (images, videos, PDFs, ...) chosen via Cmd+O or handed over by macOS. The page gets
//! an id for each instead of the bytes, then fetches the bytes once by that id, so the WebView can
//! only read files the user actually opened.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

#[derive(Default)]
pub struct PickedMedia {
    next_id: AtomicU64,
    paths: Mutex<HashMap<u64, PathBuf>>,
}

impl PickedMedia {
    /// Holds `path` until the page reads it, and returns the id to read it by.
    pub fn hold(&self, path: &Path) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.paths.lock().unwrap().insert(id, path.to_path_buf());
        id
    }

    /// Reads the file held under `id`, releasing the id whether or not the read succeeds.
    pub fn read(&self, id: u64) -> Option<Vec<u8>> {
        let path = self.paths.lock().unwrap().remove(&id)?;
        std::fs::read(path).ok()
    }
}

/// Whether the file's extension is one the page renders as media (it passes the list, so the page
/// stays the one place that decides). The extension is what follows the name's last dot, so `.png`
/// counts as a png as it does on the page (`Path::extension` would see none).
pub fn is_media(path: &Path, media_extensions: &[String]) -> bool {
    path.file_name()
        .map(|name| name.to_string_lossy().to_lowercase())
        .and_then(|name| Some(name.rsplit_once('.')?.1.to_string()))
        .is_some_and(|ext| media_extensions.contains(&ext))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_held_file_is_read_once_by_its_id() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("shot.png");
        std::fs::write(&path, [0x89, 0x50, 0x4e, 0x47]).unwrap();
        let media = PickedMedia::default();
        let id = media.hold(&path);
        assert_eq!(media.read(id), Some(vec![0x89, 0x50, 0x4e, 0x47]));
        assert_eq!(media.read(id), None);
    }

    #[test]
    fn an_unknown_id_or_a_vanished_file_reads_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let media = PickedMedia::default();
        assert_eq!(media.read(42), None);
        let id = media.hold(&dir.path().join("gone.png"));
        assert_eq!(media.read(id), None);
    }

    #[test]
    fn each_held_file_gets_its_own_id() {
        let media = PickedMedia::default();
        assert_ne!(
            media.hold(Path::new("/a.png")),
            media.hold(Path::new("/b.png"))
        );
    }

    #[test]
    fn media_is_told_by_extension_ignoring_case() {
        let exts = vec!["png".to_string(), "pdf".to_string()];
        assert!(is_media(Path::new("/x/shot.PNG"), &exts));
        assert!(is_media(Path::new("/x/doc.pdf"), &exts));
        assert!(!is_media(Path::new("/x/note.md"), &exts));
        assert!(!is_media(Path::new("/x/png"), &exts));
        assert!(is_media(Path::new("/x/.png"), &exts));
    }
}
