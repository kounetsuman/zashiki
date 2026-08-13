//! Watching repos.conf for live org changes. Mirrors `config::spawn_config_watch`: an mtime-polling
//! resident task that, on change, re-reads repos.conf into the shared `ReposState` and nudges the
//! poller (via a refresh request) so a new/edited org appears in state.sync without a restart.
//!
//! The mtime approach catches inode replacement (atomic rename) via a re-stat each tick, but misses
//! writes that don't change the mtime and a second edit within the same second on 1-second-granularity
//! filesystems (same trade-off as the config watch). Harmless for the add flow, which additionally
//! reloads the shared state synchronously.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use tokio::sync::mpsc;

use crate::control::RefreshRequest;
use crate::repos::{read_repos_state, SharedRepos};

/// Polling interval for repos.conf watching (same cadence as the config watch).
pub const REPOS_POLL: Duration = Duration::from_millis(250);

fn file_mtime(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// Spawn a resident task that polls repos.conf and, on mtime change, swaps the shared `ReposState`
/// and sends a fire-and-forget refresh so the poller re-evaluates immediately. The startup mtime is
/// captured as the baseline (the initial roots are already seeded), so only later changes are applied.
pub fn spawn_repos_watch(
    path: PathBuf,
    repos: SharedRepos,
    refresh: mpsc::Sender<RefreshRequest>,
    poll: Duration,
) -> tokio::task::JoinHandle<()> {
    let mut last_mtime = file_mtime(&path);
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(poll);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            let mtime = file_mtime(&path);
            if mtime == last_mtime {
                continue;
            }
            last_mtime = mtime;
            if let Ok(mut guard) = repos.write() {
                *guard = read_repos_state(&path);
            }
            let _ = refresh.send(RefreshRequest { reply: None }).await;
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repos::shared_repos;

    async fn settle() {
        tokio::time::sleep(Duration::from_millis(60)).await;
    }

    #[tokio::test]
    async fn watch_reloads_shared_state_and_refreshes_on_change() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("repos.conf");
        std::fs::write(&path, format!("{}/charlie\n", dir.path().display())).unwrap();
        let repos = shared_repos(
            vec![format!("{}/charlie", dir.path().display())],
            Default::default(),
        );
        let (tx, mut rx) = mpsc::channel(8);
        let _task = spawn_repos_watch(path.clone(), repos.clone(), tx, Duration::from_millis(10));
        settle().await;

        std::fs::write(
            &path,
            format!(
                "{0}/charlie\n{0}/whiskey  #7aa2f7\n",
                dir.path().display()
            ),
        )
        .unwrap();

        let req = tokio::time::timeout(Duration::from_secs(3), rx.recv())
            .await
            .expect("watch should send a refresh within timeout")
            .expect("channel open");
        assert!(req.reply.is_none());
        let state = repos.read().unwrap();
        assert_eq!(state.roots.len(), 2);
        assert_eq!(
            state.colors.get("whiskey"),
            Some(&"#7aa2f7".to_string())
        );
    }
}
