//! A registry that bundles multiple [`PtySession`]s by id (tmux removal / Phase B).
//!
//! In line with the B-1 decision (single viewer, 1 work = 1 terminal; multi-viewer sharing is split out
//! separately), this is a straightforward ownership map without multiplexing of grouped sessions. The source
//! of truth for behavior is the `tests` at the end of this file.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Mutex;

use crate::pty_host::{PtyConfig, PtySession};

/// Grace period between sending SIGTERM and SIGKILL when ending a session (gives claude a chance to flush).
const TERMINATE_GRACE: Duration = Duration::from_millis(300);

/// Display/decision metadata tied to a session (cwd / window name). The poller uses it as material for state decisions.
/// The foundation for meta that will grow in PR-D (for now just cwd / wname). Defaults to empty strings (compatible with the tmux version).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionMeta {
    pub cwd: String,
    pub wname: String,
}

/// A map of id → single-owner PTY session (plus meta).
struct Entry {
    session: Arc<PtySession>,
    meta: SessionMeta,
}

/// A map of id → single-owner PTY session.
#[derive(Default)]
pub struct SessionRegistry {
    sessions: Mutex<HashMap<String, Entry>>,
    /// A flag that blocks new creates after graceful shutdown begins (prevents orphaning a claude launched during teardown).
    shutting_down: AtomicBool,
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Launches and registers a PTY session under `id` (empty meta). An existing `id` yields `AlreadyExists`.
    pub async fn create(
        &self,
        id: impl Into<String>,
        config: PtyConfig,
    ) -> std::io::Result<Arc<PtySession>> {
        self.create_with_meta(id, config, SessionMeta::default())
            .await
    }

    /// Launches a PTY session under `id` and registers it with meta such as cwd / wname. An existing `id` yields `AlreadyExists`.
    pub async fn create_with_meta(
        &self,
        id: impl Into<String>,
        config: PtyConfig,
        meta: SessionMeta,
    ) -> std::io::Result<Arc<PtySession>> {
        let id = id.into();
        let mut sessions = self.sessions.lock().await;
        // After graceful shutdown begins, reject new launches (do not spawn a claude after teardown and orphan it).
        // The check is done under the lock to serialize create with shutdown_all's drain.
        if self.shutting_down.load(Ordering::SeqCst) {
            return Err(std::io::Error::other("session registry is shutting down"));
        }
        if sessions.contains_key(&id) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                format!("session {id} already exists"),
            ));
        }
        let session = Arc::new(PtySession::spawn(config)?);
        sessions.insert(
            id,
            Entry {
                session: session.clone(),
                meta,
            },
        );
        Ok(session)
    }

    /// Gets the session for `id`.
    pub async fn get(&self, id: &str) -> Option<Arc<PtySession>> {
        self.sessions.lock().await.get(id).map(|e| e.session.clone())
    }

    /// Gets the meta (cwd / wname) for `id`.
    pub async fn meta(&self, id: &str) -> Option<SessionMeta> {
        self.sessions.lock().await.get(id).map(|e| e.meta.clone())
    }

    /// The list of registered ids (ascending).
    pub async fn list(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.sessions.lock().await.keys().cloned().collect();
        ids.sort();
        ids
    }

    /// Returns all registered sessions as `(id, session, meta)` in ascending id order (material the poller maps onto windows).
    pub async fn entries(&self) -> Vec<(String, Arc<PtySession>, SessionMeta)> {
        let sessions = self.sessions.lock().await;
        let mut ids: Vec<&String> = sessions.keys().collect();
        ids.sort();
        ids.into_iter()
            .map(|id| {
                let e = &sessions[id];
                (id.clone(), e.session.clone(), e.meta.clone())
            })
            .collect()
    }

    /// The number of registrations.
    pub async fn len(&self) -> usize {
        self.sessions.lock().await.len()
    }

    /// Whether it is empty.
    pub async fn is_empty(&self) -> bool {
        self.sessions.lock().await.is_empty()
    }

    /// Unregisters `id` and reliably kills the process group via SIGTERM → grace → SIGKILL.
    /// Only the removal from the map is done under the lock; the lock is not held during the grace sleep. Returns `false` if it does not exist.
    ///
    /// KILL + reap + reader join are consolidated into `shutdown()` and completed within remove **regardless of the
    /// Arc owner count** (it leaves no zombie/thread even if another task holds an Arc obtained via `get()`).
    /// `shutdown()` is blocking, so it is offloaded to the blocking pool and does not stall the tokio workers.
    pub async fn remove(&self, id: &str) -> bool {
        let entry = self.sessions.lock().await.remove(id);
        let Some(session) = entry.map(|e| e.session) else {
            return false;
        };
        session.terminate();
        tokio::time::sleep(TERMINATE_GRACE).await;
        let _ = tokio::task::spawn_blocking(move || session.shutdown()).await;
        true
    }

    /// Whether graceful teardown has begun. The periodic autosave consults this so it never clobbers the
    /// shutdown save's `last.tsv` with a mid-drain (partial) snapshot (#372).
    pub fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::SeqCst)
    }

    /// Marks teardown as begun (rejects later creates and fences off the autosave). Idempotent.
    /// Called first in `save_then_shutdown` so the graceful save runs after the autosave has been fenced off.
    pub fn begin_shutdown(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
    }

    /// Kills every registered session via [`Self::remove`] (killpg + reap each session).
    /// Called during the server's graceful shutdown as a full teardown so that setsid-ed claude are not orphaned.
    /// Does nothing if empty (the registry is often empty on the tmux path).
    ///
    /// It first sets `shutting_down` to block subsequent [`Self::create_with_meta`] calls, then drains until empty.
    /// Because the flag is checked under create's lock, a create that was in-flight when the drain started is still
    /// picked up on the next pass, while a create after the flag is set is rejected (no claude spawned during teardown is missed).
    pub async fn shutdown_all(&self) {
        self.begin_shutdown();
        loop {
            let ids = self.list().await;
            if ids.is_empty() {
                return;
            }
            for id in ids {
                self.remove(&id).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use portable_pty::CommandBuilder;

    fn sleep_cfg() -> PtyConfig {
        let mut cmd = CommandBuilder::new("sh");
        cmd.arg("-c");
        cmd.arg("sleep 60");
        cmd.env("TERM", "xterm-256color");
        PtyConfig::new(cmd)
    }

    #[tokio::test]
    async fn create_get_list_remove_lifecycle() {
        let reg = SessionRegistry::new();
        reg.create("a", sleep_cfg()).await.unwrap();
        reg.create("b", sleep_cfg()).await.unwrap();

        assert_eq!(reg.list().await, vec!["a".to_string(), "b".to_string()]);
        assert!(reg.get("a").await.is_some());
        // Recreating the same id is an error.
        assert!(reg.create("a", sleep_cfg()).await.is_err());

        assert!(reg.remove("a").await);
        assert_eq!(reg.list().await, vec!["b".to_string()]);
        assert!(reg.get("a").await.is_none());
        // remove of an id that no longer exists is false.
        assert!(!reg.remove("a").await);

        assert!(reg.remove("b").await);
        assert!(reg.is_empty().await);
    }

    #[tokio::test]
    async fn create_with_meta_exposes_cwd_and_entries_in_id_order() {
        let reg = SessionRegistry::new();
        reg.create_with_meta(
            "b",
            sleep_cfg(),
            SessionMeta {
                cwd: "/repos/org/b".to_string(),
                wname: "beta".to_string(),
            },
        )
        .await
        .unwrap();
        reg.create_with_meta(
            "a",
            sleep_cfg(),
            SessionMeta {
                cwd: "/repos/org/a".to_string(),
                wname: "alpha".to_string(),
            },
        )
        .await
        .unwrap();
        // A create without meta is registered with default (empty) meta (compatible with the tmux version).
        reg.create("c", sleep_cfg()).await.unwrap();

        assert_eq!(reg.meta("a").await.unwrap().cwd, "/repos/org/a");
        assert_eq!(reg.meta("a").await.unwrap().wname, "alpha");
        assert_eq!(reg.meta("c").await.unwrap(), SessionMeta::default());
        assert!(reg.meta("missing").await.is_none());

        let entries = reg.entries().await;
        let ids: Vec<&str> = entries.iter().map(|(id, _, _)| id.as_str()).collect();
        assert_eq!(ids, vec!["a", "b", "c"]);
        assert_eq!(entries[1].2.cwd, "/repos/org/b");

        for id in ["a", "b", "c"] {
            reg.remove(id).await;
        }
    }

    /// Evidence that remove kills the process group via TERM→grace→KILL and reaps it.
    #[cfg(unix)]
    #[tokio::test]
    async fn remove_kills_the_session_process() {
        let reg = SessionRegistry::new();
        let pid = reg.create("x", sleep_cfg()).await.unwrap().pid() as i32;

        assert_eq!(
            unsafe { libc::kill(pid, 0) },
            0,
            "session process {pid} should be alive before remove"
        );
        assert!(reg.remove("x").await);
        assert_eq!(
            unsafe { libc::kill(pid, 0) },
            -1,
            "session process {pid} should be killed and reaped after remove"
        );
    }

    /// Full teardown of graceful shutdown: `shutdown_all` removes every entry (0 remaining) and each session's
    /// process group is killpg + reaped (so claude are not orphaned when the server exits).
    #[cfg(unix)]
    #[tokio::test]
    async fn shutdown_all_removes_every_entry_and_kills_processes() {
        let reg = SessionRegistry::new();
        let pid_a = reg.create("a", sleep_cfg()).await.unwrap().pid() as i32;
        let pid_b = reg.create("b", sleep_cfg()).await.unwrap().pid() as i32;
        assert_eq!(reg.len().await, 2);

        reg.shutdown_all().await;

        assert!(reg.is_empty().await, "全セッションが登録解除されること");
        for pid in [pid_a, pid_b] {
            assert_eq!(
                unsafe { libc::kill(pid, 0) },
                -1,
                "process {pid} should be killed and reaped by shutdown_all"
            );
        }
        // shutdown_all on an empty registry is a no-op (must not panic on the tmux path).
        reg.shutdown_all().await;
    }

    /// After shutdown_all, new creates are rejected (a claude spawned during teardown is not orphaned).
    #[tokio::test]
    async fn create_is_rejected_after_shutdown_all() {
        let reg = SessionRegistry::new();
        reg.shutdown_all().await;
        let err = match reg.create("late", sleep_cfg()).await {
            Ok(_) => panic!("撤収開始後の create は拒否されること"),
            Err(e) => e,
        };
        assert!(reg.is_empty().await);
        assert!(
            err.to_string().contains("shutting down"),
            "撤収開始後の create は拒否されること: {err}"
        );
    }

    /// remove's reap completion does not depend on the Arc owner count: even if remove happens while another task
    /// holds an Arc (as via `get()`), the process is killed + reaped and leaves no zombie.
    #[cfg(unix)]
    #[tokio::test]
    async fn remove_reaps_even_while_a_handle_is_held() {
        let reg = SessionRegistry::new();
        let held = reg.create("y", sleep_cfg()).await.unwrap();
        let pid = held.pid() as i32;

        assert!(reg.remove("y").await);
        assert_eq!(
            unsafe { libc::kill(pid, 0) },
            -1,
            "process {pid} should be reaped by remove even though a handle is still held"
        );
        drop(held);
    }
}
