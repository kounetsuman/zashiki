//! Watching the memo file for external edits. Like the notes watch, a content edit doesn't
//! necessarily change a directory mtime, so this re-reads the file each tick and broadcasts
//! memo.sync only when it differs from what the hub currently holds. Comparing against the hub
//! (not a local baseline) also avoids a redundant re-broadcast right after a REST write already
//! published the same text.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use crate::control_hub::ControlHub;
use crate::memo::read_memo;

/// Polling interval for the memo file (coarser than repos.conf; memo edits are infrequent).
pub const MEMO_POLL: Duration = Duration::from_millis(500);

/// Spawn a resident task that re-reads the memo file and, when it differs from the hub's held memo,
/// broadcasts memo.sync so an external edit reflects without a restart.
pub fn spawn_memo_watch(
    path: PathBuf,
    hub: Arc<ControlHub>,
    poll: Duration,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(poll);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            let current = read_memo(&path);
            if current != hub.memo() {
                hub.publish_memo(current);
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
    async fn watch_broadcasts_memo_sync_on_external_edit() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memo.md");
        let hub = ControlHub::new(ConfigView::default(), vec![], empty_snapshot());
        let mut rx = hub.subscribe();
        let _task = spawn_memo_watch(path.clone(), hub.clone(), Duration::from_millis(10));

        crate::memo::write_memo(&path, "# Memo\n").unwrap();

        // Wait for the watch to observe the new file and publish it.
        let msg = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("memo.sync within timeout")
            .expect("broadcast channel open");
        match msg {
            ServerMessage::MemoSync { text } => {
                assert_eq!(text, "# Memo\n");
            }
            other => panic!("expected memo.sync, got {other:?}"),
        }
        assert_eq!(hub.memo(), "# Memo\n");
    }
}
