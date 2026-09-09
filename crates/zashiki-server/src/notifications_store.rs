//! Disk persistence for the in-app notification list, stored as `<repos.conf dir>/notifications.json`.
//! Mirrors the Memo persistence (atomic temp + rename; an empty list leaves no file). Without it the
//! list lives only in server RAM and every restart (an app update / relaunch) wipes it. The canonical
//! spec is the tests below.

use std::io;
use std::path::{Path, PathBuf};

use crate::protocol::Notification;

/// The `notifications.json` file beside repos.conf (`<conf dir>/notifications.json`), so an isolated
/// conf path (a test/sandbox override) keeps its notifications isolated too.
pub fn notifications_path_for_conf(conf_path: &Path) -> PathBuf {
    conf_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("notifications.json")
}

/// Reads the persisted notifications, or an empty Vec when the file is missing, unreadable, or malformed.
/// A corrupt store must not block startup, so it degrades to the empty state rather than erroring.
pub fn read_notifications(path: &Path) -> Vec<Notification> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

/// Writes the list atomically (temp + rename). An empty list removes the file instead (an absent store
/// is the empty state), matching the Memo convention; removing a missing file is a no-op.
pub fn write_notifications(path: &Path, items: &[Notification]) -> io::Result<()> {
    if items.is_empty() {
        return match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        };
    }
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(".notifications.json.tmp");
    let text =
        serde_json::to_string(items).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::NotificationLevel;

    fn note(id: &str, created_at: u64) -> Notification {
        Notification {
            id: id.to_string(),
            level: NotificationLevel::Info,
            title: id.to_string(),
            body: None,
            created_at,
            sticky: false,
            dismissible: true,
            toast: None,
            cockpit_terminal_id: None,
        }
    }

    #[test]
    fn notifications_path_sits_beside_repos_conf() {
        assert_eq!(
            notifications_path_for_conf(Path::new("/home/u/.zashiki/repos.conf")),
            PathBuf::from("/home/u/.zashiki/notifications.json")
        );
    }

    #[test]
    fn write_then_read_round_trips_the_list_and_its_fields() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notifications.json");
        let mut sticky = note("sys", 2);
        sticky.sticky = true;
        sticky.dismissible = false;
        sticky.body = Some("body".to_string());
        sticky.cockpit_terminal_id = Some("@1".to_string());
        let items = vec![note("a", 1), sticky];
        write_notifications(&path, &items).unwrap();
        assert_eq!(read_notifications(&path), items);
    }

    #[test]
    fn empty_list_removes_the_file_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notifications.json");
        write_notifications(&path, &[note("a", 1)]).unwrap();
        // An empty save removes the file; re-removing a missing store is a no-op (not an error).
        write_notifications(&path, &[]).unwrap();
        assert!(!path.exists());
        assert_eq!(read_notifications(&path), Vec::<Notification>::new());
        write_notifications(&path, &[]).unwrap();
    }

    #[test]
    fn read_missing_or_malformed_file_is_empty() {
        assert_eq!(
            read_notifications(Path::new("/no/such/notifications.json")),
            Vec::<Notification>::new()
        );
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notifications.json");
        std::fs::write(&path, "{not valid json").unwrap();
        assert_eq!(read_notifications(&path), Vec::<Notification>::new());
    }
}
