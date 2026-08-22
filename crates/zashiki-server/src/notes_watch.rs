//! Watching the per-org notes directory for external edits. Unlike repos.conf (a single file whose
//! mtime is polled), a note edit changes a file's content without touching the directory mtime, so
//! this re-reads the whole store each tick and broadcasts notes.sync only when it differs from what
//! the hub currently holds. Comparing against the hub (not a local baseline) also avoids a redundant
//! re-broadcast right after a REST write already published the same set.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use crate::control_hub::ControlHub;
use crate::notes::read_notes;

/// Polling interval for the notes directory (coarser than repos.conf; note edits are infrequent).
pub const NOTES_POLL: Duration = Duration::from_millis(500);

/// Spawn a resident task that re-reads the notes directory and, when it differs from the hub's held
/// notes, broadcasts notes.sync so an external edit reflects without a restart.
pub fn spawn_notes_watch(
    dir: PathBuf,
    hub: Arc<ControlHub>,
    poll: Duration,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(poll);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            let current = read_notes(&dir);
            if current != hub.notes() {
                hub.publish_notes(current);
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control::ConfigView;
    use crate::protocol::ServerMessage;
    use std::collections::BTreeMap;

    fn empty_snapshot() -> crate::status_poller::StateSnapshot {
        crate::status_poller::StateSnapshot {
            sessions: Vec::new(),
            orgs: Vec::new(),
            org_colors: BTreeMap::new(),
            org_aliases: BTreeMap::new(),
        }
    }

    #[tokio::test]
    async fn watch_broadcasts_notes_sync_on_external_edit() {
        let dir = tempfile::tempdir().unwrap();
        let notes = dir.path().join("notes");
        let hub = ControlHub::new(ConfigView::default(), vec![], empty_snapshot());
        let mut rx = hub.subscribe();
        let _task = spawn_notes_watch(notes.clone(), hub.clone(), Duration::from_millis(10));

        crate::notes::write_note(&notes, "acme", "# Acme\n").unwrap();

        // Wait for the watch to observe the new file and publish it.
        let msg = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("notes.sync within timeout")
            .expect("broadcast channel open");
        match msg {
            ServerMessage::NotesSync { notes } => {
                assert_eq!(notes.get("acme").map(String::as_str), Some("# Acme\n"));
            }
            other => panic!("expected notes.sync, got {other:?}"),
        }
        assert_eq!(hub.notes().get("acme").map(String::as_str), Some("# Acme\n"));
    }
}
