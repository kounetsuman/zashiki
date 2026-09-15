//! A registry that bundles multiple [`PtySession`]s by id.
//!
//! In line with the B-1 decision (single viewer, 1 work = 1 terminal; multi-viewer sharing is split out
//! separately), this is a straightforward ownership map without multiplexing of grouped sessions. The source
//! of truth for behavior is the `tests` at the end of this file.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Mutex;

use crate::pty_host::{PtyConfig, PtySession};

/// What [`SessionRegistry::replace`] did, so the caller can say why nothing happened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplaceOutcome {
    /// The PTY behind the registration was swapped for the new one.
    Replaced,
    /// Another replacement of this id is already in flight.
    Busy,
    /// The terminal was closed while the replacement was being prepared.
    Gone,
}

/// Holds the "this id is being replaced" claim for as long as the replacement runs, and releases it on
/// Drop so a cancelled replacement cannot leave the id claimed forever.
struct ReplaceClaim<'a> {
    claimed: &'a std::sync::Mutex<HashSet<String>>,
    id: String,
}

impl<'a> ReplaceClaim<'a> {
    fn take(claimed: &'a std::sync::Mutex<HashSet<String>>, id: &str) -> Option<Self> {
        let taken = claimed
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.to_string());
        taken.then(|| Self {
            claimed,
            id: id.to_string(),
        })
    }
}

impl Drop for ReplaceClaim<'_> {
    fn drop(&mut self) {
        self.claimed
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.id);
    }
}

/// Grace period between sending SIGTERM and SIGKILL when ending a session (gives claude a chance to flush).
const TERMINATE_GRACE: Duration = Duration::from_millis(300);

/// Display/decision metadata tied to a session (cwd / window name). The poller uses it as material for state decisions.
/// Per-session meta (for now just cwd / wname). Defaults to empty strings.
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
    /// Ids currently being replaced. A replacement runs across several awaits, so without this two of
    /// them could both launch a claude on the same conversation. Held by [`ReplaceClaim`], whose Drop
    /// releases it however the replacement ends.
    replacing: std::sync::Mutex<HashSet<String>>,
    /// User-chosen display order of ids (the SESSION LIST). Ids present here sort by their position; ids
    /// absent (e.g. freshly created) sort after them by id. Empty means "no manual order" — pure id order.
    order: Mutex<Vec<String>>,
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

    /// Returns all registered sessions as `(id, session, meta)` in display order: ids named in the manual
    /// `order` first (by their position), then any unordered ids by ascending id. With no manual order this
    /// is plain ascending id order.
    pub async fn entries(&self) -> Vec<(String, Arc<PtySession>, SessionMeta)> {
        let sessions = self.sessions.lock().await;
        let order = self.order.lock().await;
        let rank: HashMap<&String, usize> =
            order.iter().enumerate().map(|(i, id)| (id, i)).collect();
        let mut ids: Vec<&String> = sessions.keys().collect();
        ids.sort_by(|a, b| {
            let ra = rank.get(a).copied().unwrap_or(usize::MAX);
            let rb = rank.get(b).copied().unwrap_or(usize::MAX);
            ra.cmp(&rb).then_with(|| a.cmp(b))
        });
        ids.into_iter()
            .map(|id| {
                let e = &sessions[id];
                (id.clone(), e.session.clone(), e.meta.clone())
            })
            .collect()
    }

    /// Sets the manual display order of ids (the SESSION LIST after a drag reorder). Ids not registered are
    /// harmless (ignored by {@link Self::entries}); registered ids omitted here sort after the named ones.
    pub async fn set_order(&self, order: Vec<String>) {
        *self.order.lock().await = order;
    }

    /// Swaps in a freshly launched PTY for `id`, keeping the registration and its place in the manual
    /// order. `Gone` means the terminal was closed while the swap was in progress, so the new PTY is
    /// discarded rather than resurrecting a row the user just dismissed.
    ///
    /// One replacement per id at a time; a second call while one is in flight reports `Busy`.
    /// The old process is torn down **before** the replacement is launched: both are started with the
    /// same Claude session id, and two of them would be writing one conversation at once. A launch
    /// that then fails returns `Err` with the registration still in place, on its now-dead session —
    /// the row stays in the list (its id is the conversation's only handle) and can be restarted again.
    pub async fn replace(
        &self,
        id: &str,
        config: PtyConfig,
        meta: SessionMeta,
    ) -> std::io::Result<ReplaceOutcome> {
        let Some(_claim) = ReplaceClaim::take(&self.replacing, id) else {
            return Ok(ReplaceOutcome::Busy);
        };
        self.replace_held(id, config, meta).await
    }

    /// The body of [`Self::replace`], run while this id is claimed.
    async fn replace_held(
        &self,
        id: &str,
        config: PtyConfig,
        meta: SessionMeta,
    ) -> std::io::Result<ReplaceOutcome> {
        let previous = {
            let sessions = self.sessions.lock().await;
            if self.shutting_down.load(Ordering::SeqCst) {
                None
            } else {
                sessions.get(id).map(|e| Arc::clone(&e.session))
            }
        };
        let Some(previous) = previous else {
            return Ok(ReplaceOutcome::Gone);
        };
        previous.terminate();
        tokio::time::sleep(TERMINATE_GRACE).await;
        let teardown = Arc::clone(&previous);
        // `stop`, not `shutdown`: the child is killed and collected here, but the reader thread is left
        // to finish on its own. Joining it can take as long as a descendant that escaped the group kill
        // keeps the pty slave open, and this call holds the per-id claim — a terminal whose reader never
        // returns would otherwise be stuck reporting "restart in progress" for the life of the daemon.
        let _ = tokio::task::spawn_blocking(move || teardown.stop()).await;

        // Launch under the lock, the way `create_with_meta` does: the teardown above spans awaits, and
        // a quit that drained the registry meanwhile would otherwise get a claude started behind it.
        let mut sessions = self.sessions.lock().await;
        // Only swap over the entry this call tore down: anything else means the row was closed and
        // re-created meanwhile, and replacing that would strand a live session.
        let still_ours = sessions
            .get(id)
            .is_some_and(|e| Arc::ptr_eq(&e.session, &previous));
        if self.shutting_down.load(Ordering::SeqCst) || !still_ours {
            return Ok(ReplaceOutcome::Gone);
        }
        let session = Arc::new(PtySession::spawn(config)?);
        sessions.insert(id.to_string(), Entry { session, meta });
        drop(sessions);
        // Only now: until the replacement is registered, the old session is what the row still points
        // at, and a failed spawn leaves it there for the user to read.
        previous.discard_history();
        Ok(ReplaceOutcome::Replaced)
    }

    /// Whether a replacement for `id` is in flight. The poller uses it so the teardown window — where
    /// the process is being swapped but its pid has not visibly changed yet — is not mistaken for that
    /// terminal's background work finishing.
    pub fn is_replacing(&self, id: &str) -> bool {
        self.replacing
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(id)
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
    /// KILL + reap are consolidated into `shutdown()` and completed within remove **regardless of the
    /// Arc owner count** (it leaves no zombie even if another task holds an Arc obtained via `get()`).
    /// The reader thread is joined too, except on a session a `stop()` already tore down, where waiting
    /// on a reader a descendant can hold open forever is the worse trade — see [`PtySession::stop`].
    /// `shutdown()` is blocking, so it is offloaded to the blocking pool and does not stall the tokio workers.
    pub async fn remove(&self, id: &str) -> bool {
        let entry = self.sessions.lock().await.remove(id);
        let Some(session) = entry.map(|e| e.session) else {
            return false;
        };
        self.order.lock().await.retain(|o| o != id);
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
    /// Does nothing if empty.
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
    async fn entries_follow_manual_order_then_fall_back_to_id_order() {
        let reg = SessionRegistry::new();
        for id in ["a", "b", "c"] {
            reg.create(id, sleep_cfg()).await.unwrap();
        }
        // No manual order → ascending id order.
        let ids = |v: Vec<(String, _, _)>| v.into_iter().map(|(id, _, _)| id).collect::<Vec<_>>();
        assert_eq!(ids(reg.entries().await), vec!["a", "b", "c"]);

        // Manual order wins; an id omitted from it (c) sorts after the named ones.
        reg.set_order(vec!["b".to_string(), "a".to_string()]).await;
        assert_eq!(ids(reg.entries().await), vec!["b", "a", "c"]);

        // Removing a manually-ordered id drops it from the order (no stale slot).
        reg.remove("b").await;
        assert_eq!(ids(reg.entries().await), vec!["a", "c"]);
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
        // A create without meta is registered with default (empty) meta.
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
        // shutdown_all on an empty registry is a no-op (must not panic).
        reg.shutdown_all().await;
    }

    /// Two restarts of one terminal cannot both launch a claude on its conversation: the second one
    /// finds the id claimed and declines.
    #[cfg(unix)]
    #[tokio::test]
    async fn replace_serializes_per_id() {
        let reg = Arc::new(SessionRegistry::new());
        reg.create_with_meta("x".to_string(), sleep_cfg(), SessionMeta::default())
            .await
            .unwrap();

        let first = {
            let reg = Arc::clone(&reg);
            tokio::spawn(async move {
                reg.replace("x", sleep_cfg(), SessionMeta::default()).await
            })
        };
        // Long enough to be inside the teardown grace, where the id is claimed.
        tokio::time::sleep(Duration::from_millis(50)).await;
        let second = reg.replace("x", sleep_cfg(), SessionMeta::default()).await;

        assert!(
            matches!(second, Ok(ReplaceOutcome::Busy)),
            "a concurrent replace declines instead of launching a second claude"
        );
        assert!(matches!(
            first.await.unwrap(),
            Ok(ReplaceOutcome::Replaced)
        ));
        assert_eq!(reg.len().await, 1);
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
