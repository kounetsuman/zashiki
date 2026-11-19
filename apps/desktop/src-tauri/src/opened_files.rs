//! Files macOS hands to the app (`open -a Zashiki note.md`, Finder's "Open With", the default app).
//! They can arrive before the page has loaded, so they wait in a queue the page drains.

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::Url;

/// Tells the page that files are waiting; it carries no payload.
pub const OPENED_EVENT: &str = "zashiki:files-opened";

#[derive(Default)]
pub struct OpenedFiles(Mutex<Vec<PathBuf>>);

impl OpenedFiles {
    /// Queues the local files among `urls` and reports whether there were any.
    pub fn push(&self, urls: &[Url]) -> bool {
        let paths: Vec<PathBuf> = urls
            .iter()
            .filter(|url| url.scheme() == "file")
            .filter_map(|url| url.to_file_path().ok())
            .collect();
        let any = !paths.is_empty();
        self.0.lock().unwrap().extend(paths);
        any
    }

    /// Hands over everything queued so far, in arrival order, leaving the queue empty.
    pub fn take(&self) -> Vec<PathBuf> {
        std::mem::take(&mut *self.0.lock().unwrap())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        s.parse().unwrap()
    }

    #[test]
    fn queues_file_urls_in_arrival_order() {
        let opened = OpenedFiles::default();
        assert!(opened.push(&[url("file:///tmp/a.md"), url("file:///tmp/b%20c.md")]));
        assert!(opened.push(&[url("file:///tmp/d.markdown")]));
        assert_eq!(
            opened.take(),
            vec![
                PathBuf::from("/tmp/a.md"),
                PathBuf::from("/tmp/b c.md"),
                PathBuf::from("/tmp/d.markdown"),
            ]
        );
    }

    #[test]
    fn take_empties_the_queue() {
        let opened = OpenedFiles::default();
        opened.push(&[url("file:///tmp/a.md")]);
        opened.take();
        assert!(opened.take().is_empty());
    }

    #[test]
    fn ignores_urls_that_are_not_local_files() {
        let opened = OpenedFiles::default();
        assert!(!opened.push(&[url("https://example.com/a.md"), url("zashiki://open")]));
        assert!(opened.take().is_empty());
    }

    /// Nothing at build time ties the two spellings together; a rename here would leave handed-over
    /// files waiting in the queue until the page next reloads.
    #[test]
    fn the_page_listens_for_the_event_this_module_sends() {
        let hook = include_str!("../../../../packages/client/src/ui/useOpenedFiles.ts");
        assert!(
            hook.contains(OPENED_EVENT),
            "useOpenedFiles must listen for {OPENED_EVENT}"
        );
    }
}
