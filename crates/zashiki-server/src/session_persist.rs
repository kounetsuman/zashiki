//! Save/restore usecase for the session list (tmux removal; owned-only).
//!
//! Moves the tmux version's `POST /api/sessions/save` / `/restore`
//! onto the owned-mode `SessionRegistry`. The tmux version walked the process tree to pick up claude sids,
//! but in owned mode **the registry id itself is the sid (UUID)** and meta holds wname/cwd, so no walk is needed.
//! The destructive sequence (backup → remove all → rebuild) assumes it is serialized within the server (`persist_lock`).
//! The save format (`saves/last.tsv` = `widx\twname\tcwd\tsid` TSV) reuses [`zashiki_core::save_file`].
//! The source of truth for behavior is the `tests` at the end.
//!
//! owned-only tradeoff: for now, save/restore in tmux mode is handled by Node.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use zashiki_core::save_file::{is_uuid_sid, parse_save_file, serialize_save_file, SaveEntry};

use crate::session_launch::{
    plan_new_session, plan_to_config as new_plan_to_config, resolve_claude_program, resolve_cwd,
};
use crate::session_registry::{SessionMeta, SessionRegistry};
use crate::session_restore::{plan_resume, plan_to_config as resume_plan_to_config, write_save_file};

const LAST_FILE: &str = "last.tsv";

/// Precondition errors for save/restore.
/// The tmux version's `work_not_found` does not occur in owned mode because there is no "work session" concept
/// (the registry always exists, and if there is no registration holding claude it is [`PersistError::SaveEmpty`]).
#[derive(Debug)]
pub enum PersistError {
    /// No save targets (registrations with a UUID sid) at all (409).
    SaveEmpty,
    /// The restore file does not exist (404). The accompanying string is the path.
    RestoreFileNotFound(String),
    /// The restore file exists but has zero entries to restore (422). The accompanying string is the path.
    RestoreEmpty(String),
    /// Disk I/O failure (500).
    Io(io::Error),
}

/// Result of `POST /api/sessions/save`.
#[derive(Debug)]
pub struct SaveOutcome {
    pub saved: usize,
    /// Window names of registrations skipped for lacking a claude sid (UUID).
    pub skipped: Vec<String>,
    pub path: String,
}

/// Result of `POST /api/sessions/restore`.
#[derive(Debug)]
pub struct RestoreOutcome {
    pub restored: usize,
    pub warnings: Vec<String>,
    /// A backup of the current state saved before kill (`None` if there was nothing to save).
    pub backup_path: Option<String>,
}

/// Whether the name is valid as a file directly under `saves/` (must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`).
/// The first character is alphanumeric; the rest are only alphanumeric, `.`, `_`, `-`. It disallows `/`, so path escape is impossible.
pub fn is_valid_save_filename(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Splits the current registry into save entries and skipped window names (the owned version of the tmux `collectEntries`).
/// Registrations with a UUID id become save targets; non-UUID registrations are considered to have no claude running, so their window names go to skip.
/// widx is a 1-based ordinal over all registrations (including skipped ones; for display, unused on restore).
async fn collect_entries(registry: &SessionRegistry) -> (Vec<SaveEntry>, Vec<String>) {
    let mut entries = Vec::new();
    let mut skipped = Vec::new();
    for (i, (id, _session, meta)) in registry.entries().await.into_iter().enumerate() {
        if is_uuid_sid(&id) {
            entries.push(SaveEntry {
                widx: (i + 1).to_string(),
                wname: meta.wname,
                cwd: meta.cwd,
                sid: id,
            });
        } else {
            skipped.push(meta.wname);
        }
    }
    (entries, skipped)
}

/// Local time `YYYYMMDD-HHMMSS` (follows the cw archive naming).
fn stamp_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as libc::time_t)
        .unwrap_or(0);
    stamp_of(secs)
}

/// Formats UNIX seconds into local-time `YYYYMMDD-HHMMSS` (reflecting the TZ via `localtime_r`).
fn stamp_of(secs: libc::time_t) -> String {
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe {
        libc::localtime_r(&secs, &mut tm);
    }
    format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}",
        tm.tm_year + 1900,
        tm.tm_mon + 1,
        tm.tm_mday,
        tm.tm_hour,
        tm.tm_min,
        tm.tm_sec
    )
}

/// Writes the same content to last.tsv and a timestamped backup. Both are atomic writes.
fn write_last_and_backup(
    dir: &Path,
    entries: &[SaveEntry],
    stamp: &str,
) -> io::Result<(PathBuf, PathBuf)> {
    fs::create_dir_all(dir)?;
    let last = dir.join(LAST_FILE);
    let backup = dir.join(format!("{stamp}.tsv"));
    write_save_file(&last, entries)?;
    write_save_file(&backup, entries)?;
    Ok((last, backup))
}

/// Writes to a labeled backup (`YYYYMMDD-HHMMSS-<label>.tsv`).
fn write_backup(dir: &Path, entries: &[SaveEntry], stamp: &str, label: &str) -> io::Result<PathBuf> {
    fs::create_dir_all(dir)?;
    let backup = dir.join(format!("{stamp}-{label}.tsv"));
    write_save_file(&backup, entries)?;
    Ok(backup)
}

/// The path of the restore source (last.tsv when `file` is omitted; resolved directly under `dir` when given).
/// Assumes the caller has validated it via [`is_valid_save_filename`] (it contains no `/`, so it cannot leave `dir`).
fn save_path(dir: &Path, file: Option<&str>) -> PathBuf {
    match file {
        None => dir.join(LAST_FILE),
        Some(f) => dir.join(f),
    }
}

/// Saves the current registry to a `-prerestore` backup (`None` if there is nothing to save).
/// Called before restore's destructive operation (remove all) to guarantee that the kill is non-destructive.
async fn backup_current_state(
    registry: &SessionRegistry,
    dir: &Path,
) -> Result<Option<String>, PersistError> {
    let (entries, _skipped) = collect_entries(registry).await;
    if entries.is_empty() {
        return Ok(None);
    }
    let path = write_backup(dir, &entries, &stamp_now(), "prerestore").map_err(PersistError::Io)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Rebuilds the registry from the save entries.
/// For a UUID sid with `launch_claude`, it creates the session with `claude --resume`; otherwise with a plain
/// login shell (as in the tmux version, **it does not drop the tab** and instead warns about claude not launching).
/// A UUID entry uses the sid as its id; a non-UUID entry uses a non-colliding synthetic id (`shell:<i>:<wname>`)
/// (a synthetic id is non-UUID, so it becomes a skip target on the next save).
async fn rebuild(
    registry: &SessionRegistry,
    entries: &[SaveEntry],
    launch_claude: bool,
    shell: &str,
    settings: Option<&str>,
    warnings: &mut Vec<String>,
) {
    let claude = resolve_claude_program();
    for (i, entry) in entries.iter().enumerate() {
        let cwd = resolve_cwd(&entry.cwd);
        let meta = SessionMeta {
            cwd: cwd.clone(),
            wname: entry.wname.clone(),
        };
        let (id, config) = if launch_claude && is_uuid_sid(&entry.sid) {
            let mut plan = plan_resume(entry, shell, &claude, settings).expect("uuid sid plans a resume");
            plan.cwd = cwd.clone();
            (entry.sid.to_lowercase(), resume_plan_to_config(&plan))
        } else {
            if launch_claude && !is_uuid_sid(&entry.sid) {
                warnings.push(format!(
                    "{}: sid が UUID でないため claude を起動しません ({})",
                    entry.wname, entry.sid
                ));
            }
            let plan = plan_new_session(&entry.sid, &cwd, &entry.wname, false, None, shell, &claude, None);
            let id = if is_uuid_sid(&entry.sid) {
                entry.sid.to_lowercase()
            } else {
                format!("shell:{}:{}", i, entry.wname)
            };
            (id, new_plan_to_config(&plan))
        };
        if let Err(e) = registry.create_with_meta(id, config, meta).await {
            warnings.push(format!("{}: セッション作成に失敗しました ({e})", entry.wname));
        }
    }
}

/// The body of `POST /api/sessions/save`. Saves every UUID registration in the registry to last.tsv plus a timestamped backup.
pub async fn save_sessions(
    registry: &SessionRegistry,
    dir: &Path,
) -> Result<SaveOutcome, PersistError> {
    let (entries, skipped) = collect_entries(registry).await;
    if entries.is_empty() {
        return Err(PersistError::SaveEmpty);
    }
    let (last, _backup) =
        write_last_and_backup(dir, &entries, &stamp_now()).map_err(PersistError::Io)?;
    Ok(SaveOutcome {
        saved: entries.len(),
        skipped,
        path: last.to_string_lossy().into_owned(),
    })
}

/// Interval between periodic `last.tsv` autosaves. A crash / SIGKILL loses at most this much of the session-list edits
/// made since the previous tick (the old graceful-shutdown-only save lost everything since the last clean exit; #372).
pub const AUTOSAVE_INTERVAL: Duration = Duration::from_secs(10);

/// Refreshes only `last.tsv` (no timestamped backup) from the live registry, skipping the write when the body is
/// unchanged from `prev`. This keeps `last.tsv` fresh so a non-graceful exit restores to a recent state instead of the
/// last clean shutdown (#372), without the per-tick `{stamp}.tsv` spam that [`save_sessions`] would produce.
///
/// The primary fence against clobbering the graceful save is that `shutdown_signal` aborts+joins this task before
/// [`save_then_shutdown`], so the shutdown save is the deterministic final writer. The `is_shutting_down()` check here
/// is a cheap secondary guard (e.g. if invoked directly after teardown began) — it skips writing once teardown starts.
/// An empty registry leaves `last.tsv` untouched (matching [`PersistError::SaveEmpty`], never clearing it).
async fn autosave_last(
    registry: &SessionRegistry,
    dir: &Path,
    prev: &mut Option<String>,
) -> io::Result<()> {
    let (entries, _skipped) = collect_entries(registry).await;
    if entries.is_empty() || registry.is_shutting_down() {
        return Ok(());
    }
    let body = serialize_save_file(&entries);
    if prev.as_deref() == Some(body.as_str()) {
        return Ok(());
    }
    fs::create_dir_all(dir)?;
    write_save_file(&dir.join(LAST_FILE), &entries)?;
    *prev = Some(body);
    Ok(())
}

/// Starts a resident task that periodically refreshes `last.tsv` from the live registry (crash resilience; #372).
/// It writes only when the save body changed, so a quiescent session list produces no disk churn and no backup spam.
pub fn spawn_session_autosave(
    registry: Arc<SessionRegistry>,
    dir: PathBuf,
    interval: Duration,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut prev: Option<String> = None;
        loop {
            ticker.tick().await;
            if let Err(e) = autosave_last(&registry, &dir, &mut prev).await {
                tracing::error!("zashiki-server: 定期セッション保存に失敗しました: {e}");
            }
        }
    })
}

/// The body of `POST /api/sessions/restore`. Reads the restore source → saves the current state → removes all → rebuilds.
/// Serializing the destructive operation (persist_lock) is the caller's (REST handler's) responsibility.
pub async fn restore_sessions(
    registry: &SessionRegistry,
    dir: &Path,
    file: Option<&str>,
    launch_claude: bool,
    shell: &str,
    settings: Option<&str>,
) -> Result<RestoreOutcome, PersistError> {
    let path = save_path(dir, file);
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return Err(PersistError::RestoreFileNotFound(
                path.to_string_lossy().into_owned(),
            ));
        }
        Err(e) => return Err(PersistError::Io(e)),
    };
    let entries = parse_save_file(&content);
    if entries.is_empty() {
        return Err(PersistError::RestoreEmpty(path.to_string_lossy().into_owned()));
    }
    // Save the current state before the destructive operation (on write failure we return here, having broken nothing yet).
    let backup_path = backup_current_state(registry, dir).await?;
    for id in registry.list().await {
        registry.remove(&id).await;
    }
    let mut warnings = Vec::new();
    rebuild(registry, &entries, launch_claude, shell, settings, &mut warnings).await;
    Ok(RestoreOutcome {
        restored: entries.len(),
        warnings,
        backup_path,
    })
}

/// Auto-restore at daemon startup. Rebuilds the owned registry from `last.tsv`.
/// The registry is empty right after startup, so the destructive operations (prerestore save, remove all) are
/// effectively no-ops, letting us reuse [`restore_sessions`]'s rebuild logic as-is. A missing or empty restore
/// file (= there was no claude worth saving beforehand) is a normal case of "nothing to restore" and returns
/// `Ok(0)` (without halting startup). Only I/O failures return `Err`. The return value is the number restored.
pub async fn restore_sessions_on_startup(
    registry: &SessionRegistry,
    dir: &Path,
    launch_claude: bool,
    shell: &str,
    settings: Option<&str>,
) -> Result<usize, PersistError> {
    match restore_sessions(registry, dir, None, launch_claude, shell, settings).await {
        Ok(out) => Ok(out.restored),
        Err(PersistError::RestoreFileNotFound(_)) | Err(PersistError::RestoreEmpty(_)) => Ok(0),
        Err(e) => Err(e),
    }
}

/// Auto-save plus full teardown at graceful shutdown. **Saves first** to keep the sids in `last.tsv`, then
/// killpg + reaps every claude via [`SessionRegistry::shutdown_all`]. Ordering is critical: if kill came first,
/// the sids would vanish from the registry, last.tsv would be empty, and restart could not restore them.
/// Having nothing to save ([`PersistError::SaveEmpty`]) is ignored as a normal case and only the teardown runs.
/// Even on I/O failure the teardown always runs (prioritizing not leaving orphan claude, swallowing save failures).
pub async fn save_then_shutdown(registry: &SessionRegistry, dir: &Path) {
    // Fence the periodic autosave before saving so a mid-drain tick cannot clobber this save's last.tsv (#372).
    registry.begin_shutdown();
    match save_sessions(registry, dir).await {
        Ok(_) | Err(PersistError::SaveEmpty) => {}
        Err(e) => {
            tracing::error!("zashiki-server: shutdown 時のセッション保存に失敗しました: {e:?}");
        }
    }
    registry.shutdown_all().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    const UUID_A: &str = "579fa8cf-4901-45cb-b9ec-17e229231a37";
    const UUID_B: &str = "11111111-2222-3333-4444-555555555555";

    /// Registers one entry into the registry with a plain login shell (a test helper that prepares a save target).
    async fn seed(reg: &SessionRegistry, id: &str, wname: &str, cwd: &str) {
        let plan = plan_new_session(id, cwd, wname, false, None, "/bin/sh", "claude", None);
        reg.create_with_meta(
            id.to_string(),
            new_plan_to_config(&plan),
            SessionMeta {
                cwd: cwd.to_string(),
                wname: wname.to_string(),
            },
        )
        .await
        .unwrap();
    }

    async fn cleanup(reg: &SessionRegistry) {
        for id in reg.list().await {
            reg.remove(&id).await;
        }
    }

    #[test]
    fn save_filename_validation_matches_ts_regex() {
        assert!(is_valid_save_filename("last.tsv"));
        assert!(is_valid_save_filename("20260804-101112.tsv"));
        assert!(is_valid_save_filename("a"));
        // The first character must be alphanumeric; path escape via `/` or `..` is not allowed.
        assert!(!is_valid_save_filename(""));
        assert!(!is_valid_save_filename(".hidden"));
        assert!(!is_valid_save_filename(".."));
        assert!(!is_valid_save_filename("sub/dir.tsv"));
        assert!(!is_valid_save_filename("/abs.tsv"));
        assert!(!is_valid_save_filename("bad name.tsv"));
    }

    #[test]
    fn stamp_of_formats_local_time() {
        // Verify 2026-08-04T10:11:12Z = 1785838272 under TZ=UTC (localtime_r reflects the TZ).
        std::env::set_var("TZ", "UTC");
        assert_eq!(stamp_of(1_785_838_272), "20260804-101112");
    }

    #[tokio::test]
    async fn save_empty_registry_is_save_empty() {
        let reg = SessionRegistry::new();
        let dir = tempfile::tempdir().unwrap();
        let err = save_sessions(&reg, dir.path()).await.unwrap_err();
        assert!(matches!(err, PersistError::SaveEmpty));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn save_writes_last_and_backup_and_reports_skipped() {
        let reg = SessionRegistry::new();
        // 2 with a UUID id (save targets) and 1 with a non-UUID id (claude not launched → skipped).
        seed(&reg, UUID_A, "alpha", "/tmp").await;
        seed(&reg, "shell:0:beta", "beta", "/tmp").await;
        seed(&reg, UUID_B, "gamma", "/tmp").await;
        let dir = tempfile::tempdir().unwrap();

        let out = save_sessions(&reg, dir.path()).await.unwrap();
        assert_eq!(out.saved, 2);
        assert_eq!(out.skipped, vec!["beta".to_string()]);
        assert!(out.path.ends_with("last.tsv"));

        // last.tsv contains only the 2 entries that have a sid.
        let last = std::fs::read_to_string(dir.path().join("last.tsv")).unwrap();
        assert!(last.contains(UUID_A));
        assert!(last.contains(UUID_B));
        assert!(!last.contains("beta"));
        // At least one timestamped backup is also produced (a .tsv other than last.tsv).
        let backups = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name() != "last.tsv")
            .count();
        assert!(backups >= 1);

        cleanup(&reg).await;
    }

    #[tokio::test]
    async fn restore_missing_file_is_not_found() {
        let reg = SessionRegistry::new();
        let dir = tempfile::tempdir().unwrap();
        let err = restore_sessions(&reg, dir.path(), None, true, "/bin/sh", None)
            .await
            .unwrap_err();
        assert!(matches!(err, PersistError::RestoreFileNotFound(_)));
    }

    #[tokio::test]
    async fn restore_empty_file_is_unprocessable() {
        let reg = SessionRegistry::new();
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("last.tsv"), "").unwrap();
        let err = restore_sessions(&reg, dir.path(), None, true, "/bin/sh", None)
            .await
            .unwrap_err();
        assert!(matches!(err, PersistError::RestoreEmpty(_)));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn restore_rebuilds_registry_keyed_by_sid() {
        let reg = SessionRegistry::new();
        let dir = tempfile::tempdir().unwrap();
        let content = format!("1\talpha\t/tmp\t{UUID_A}\n2\tbeta\t/tmp\t{UUID_B}\n");
        std::fs::write(dir.path().join("last.tsv"), content).unwrap();

        let out = restore_sessions(&reg, dir.path(), None, true, "/bin/sh", None)
            .await
            .unwrap();
        assert_eq!(out.restored, 2);
        assert!(out.warnings.is_empty());
        // The registry was empty before restore, so there is no prerestore backup.
        assert!(out.backup_path.is_none());
        // Rebuilt keyed by sid (the id convention matches a new session.new → re-savable).
        assert_eq!(reg.list().await, vec![UUID_B.to_string(), UUID_A.to_string()]);

        cleanup(&reg).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn restore_backs_up_current_state_then_replaces() {
        let reg = SessionRegistry::new();
        seed(&reg, UUID_A, "old", "/tmp").await;
        let dir = tempfile::tempdir().unwrap();
        let content = format!("1\tnew\t/tmp\t{UUID_B}\n");
        std::fs::write(dir.path().join("last.tsv"), content).unwrap();

        let out = restore_sessions(&reg, dir.path(), None, true, "/bin/sh", None)
            .await
            .unwrap();
        assert_eq!(out.restored, 1);
        // UUID_A was present before restore, so a prerestore backup is written.
        let backup = out.backup_path.expect("prerestore backup should exist");
        assert!(backup.contains("prerestore"));
        assert!(std::fs::read_to_string(&backup).unwrap().contains(UUID_A));
        // The old session is gone and only the new session remains.
        assert_eq!(reg.list().await, vec![UUID_B.to_string()]);

        cleanup(&reg).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn restore_non_uuid_entry_keeps_tab_with_warning() {
        let reg = SessionRegistry::new();
        let dir = tempfile::tempdir().unwrap();
        // A legacy cw-compatible entry whose sid is not a UUID. claude is not launched; the tab remains with a plain shell.
        let content = format!("1\tlegacy\t/tmp\tworkspace\n2\tok\t/tmp\t{UUID_A}\n");
        std::fs::write(dir.path().join("last.tsv"), content).unwrap();

        let out = restore_sessions(&reg, dir.path(), None, true, "/bin/sh", None)
            .await
            .unwrap();
        assert_eq!(out.restored, 2);
        assert_eq!(out.warnings.len(), 1);
        assert!(out.warnings[0].contains("legacy"));
        // A UUID entry is keyed by sid; a non-UUID entry gets a synthetic id (skipped on the next save).
        let ids = reg.list().await;
        assert!(ids.contains(&UUID_A.to_string()));
        assert!(ids.iter().any(|id| id.starts_with("shell:")));

        cleanup(&reg).await;
    }

    /// Startup auto-restore. Empty registry + existing last.tsv → the same set of sids appears.
    #[cfg(unix)]
    #[tokio::test]
    async fn startup_restore_rebuilds_from_last_tsv() {
        let dir = tempfile::tempdir().unwrap();
        let reg1 = SessionRegistry::new();
        seed(&reg1, UUID_A, "alpha", "/tmp").await;
        seed(&reg1, UUID_B, "beta", "/tmp").await;
        // save → discard the registry to simulate a restart in a separate process.
        save_sessions(&reg1, dir.path()).await.unwrap();
        cleanup(&reg1).await;

        let reg2 = SessionRegistry::new();
        let restored = restore_sessions_on_startup(&reg2, dir.path(), true, "/bin/sh", None)
            .await
            .unwrap();
        assert_eq!(restored, 2);
        assert_eq!(reg2.list().await, vec![UUID_B.to_string(), UUID_A.to_string()]);

        cleanup(&reg2).await;
    }

    /// A startup with no save file is a normal "nothing to restore" case (Ok(0); does not halt startup).
    #[tokio::test]
    async fn startup_restore_missing_file_is_ok_zero() {
        let reg = SessionRegistry::new();
        let dir = tempfile::tempdir().unwrap();
        let restored = restore_sessions_on_startup(&reg, dir.path(), true, "/bin/sh", None)
            .await
            .unwrap();
        assert_eq!(restored, 0);
        assert!(reg.is_empty().await);
    }

    /// An empty last.tsv (no claude was present beforehand) is also a normal case (Ok(0)).
    #[tokio::test]
    async fn startup_restore_empty_file_is_ok_zero() {
        let reg = SessionRegistry::new();
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path()).unwrap();
        std::fs::write(dir.path().join("last.tsv"), "").unwrap();
        let restored = restore_sessions_on_startup(&reg, dir.path(), true, "/bin/sh", None)
            .await
            .unwrap();
        assert_eq!(restored, 0);
        assert!(reg.is_empty().await);
    }

    /// Ordering contract: because it runs save→kill in order, after shutdown returns,
    /// last.tsv still holds the killed sids (save runs before kill) and the registry is empty.
    #[cfg(unix)]
    #[tokio::test]
    async fn save_then_shutdown_persists_sids_before_killing() {
        let dir = tempfile::tempdir().unwrap();
        let reg = SessionRegistry::new();
        seed(&reg, UUID_A, "alpha", "/tmp").await;
        seed(&reg, UUID_B, "beta", "/tmp").await;

        save_then_shutdown(&reg, dir.path()).await;

        // If kill had run first, the sids would have vanished from the registry and last.tsv would be empty.
        let last = std::fs::read_to_string(dir.path().join("last.tsv")).unwrap();
        assert!(last.contains(UUID_A), "save が kill より先で sid が残ること");
        assert!(last.contains(UUID_B), "save が kill より先で sid が残ること");
        // Teardown completes and the registry is empty.
        assert!(reg.is_empty().await, "shutdown_all で全撤収されること");
    }

    /// A shutdown with nothing to save (no claude launched) skips the save and only tears down (no panic).
    #[cfg(unix)]
    #[tokio::test]
    async fn save_then_shutdown_with_no_claude_only_shuts_down() {
        let dir = tempfile::tempdir().unwrap();
        let reg = SessionRegistry::new();
        seed(&reg, "shell:0:plain", "plain", "/tmp").await;

        save_then_shutdown(&reg, dir.path()).await;

        // Because of SaveEmpty, last.tsv is not written.
        assert!(!dir.path().join("last.tsv").exists());
        assert!(reg.is_empty().await);
    }

    /// Fence contract (#372): the graceful save overwrites a stale last.tsv left by an earlier autosave tick with the
    /// current full registry. Together with `shutdown_signal` aborting+joining the autosave task before this save (so
    /// no autosave write can land afterwards), the graceful save is the deterministic final writer of last.tsv.
    #[cfg(unix)]
    #[tokio::test]
    async fn save_then_shutdown_overwrites_stale_autosaved_last_tsv() {
        let dir = tempfile::tempdir().unwrap();
        let reg = SessionRegistry::new();
        seed(&reg, UUID_A, "alpha", "/tmp").await;
        seed(&reg, UUID_B, "beta", "/tmp").await;
        // A stale last.tsv as an in-flight autosave might have written (only one of the two sessions seen).
        std::fs::create_dir_all(dir.path()).unwrap();
        std::fs::write(dir.path().join("last.tsv"), format!("1\talpha\t/tmp\t{UUID_A}\n")).unwrap();

        save_then_shutdown(&reg, dir.path()).await;

        let last = std::fs::read_to_string(dir.path().join("last.tsv")).unwrap();
        assert!(
            last.contains(UUID_A) && last.contains(UUID_B),
            "graceful save が現在の全集合で stale な last.tsv を上書きすること"
        );
        assert!(reg.is_empty().await);
    }

    /// Counts `.tsv` files other than last.tsv (i.e. timestamped backups) in the saves dir.
    fn backup_count(dir: &Path) -> usize {
        std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name() != "last.tsv" && e.path().extension().is_some_and(|x| x == "tsv"))
            .count()
    }

    /// Periodic autosave refreshes last.tsv but, unlike save_sessions, never emits a {stamp}.tsv (no backup spam).
    #[cfg(unix)]
    #[tokio::test]
    async fn autosave_writes_only_last_tsv_without_backup() {
        let reg = SessionRegistry::new();
        seed(&reg, UUID_A, "alpha", "/tmp").await;
        seed(&reg, "shell:0:beta", "beta", "/tmp").await;
        seed(&reg, UUID_B, "gamma", "/tmp").await;
        let dir = tempfile::tempdir().unwrap();

        autosave_last(&reg, dir.path(), &mut None).await.unwrap();

        let last = std::fs::read_to_string(dir.path().join("last.tsv")).unwrap();
        assert!(last.contains(UUID_A) && last.contains(UUID_B));
        assert!(!last.contains("beta"), "sid の無い登録は skip される");
        assert_eq!(backup_count(dir.path()), 0, "定期 save は {{stamp}}.tsv を作らない");

        cleanup(&reg).await;
    }

    /// The dirty check skips the write when the save body is unchanged (an out-of-band edit to last.tsv survives).
    #[cfg(unix)]
    #[tokio::test]
    async fn autosave_skips_write_when_unchanged() {
        let reg = SessionRegistry::new();
        seed(&reg, UUID_A, "alpha", "/tmp").await;
        let dir = tempfile::tempdir().unwrap();
        let mut prev = None;

        autosave_last(&reg, dir.path(), &mut prev).await.unwrap();
        std::fs::write(dir.path().join("last.tsv"), "SENTINEL").unwrap();
        autosave_last(&reg, dir.path(), &mut prev).await.unwrap();

        assert_eq!(
            std::fs::read_to_string(dir.path().join("last.tsv")).unwrap(),
            "SENTINEL",
            "内容不変なら last.tsv を書き直さない"
        );

        cleanup(&reg).await;
    }

    /// A change to the session set (here: a close) is picked up on the next autosave.
    #[cfg(unix)]
    #[tokio::test]
    async fn autosave_rewrites_when_registry_changes() {
        let reg = SessionRegistry::new();
        seed(&reg, UUID_A, "alpha", "/tmp").await;
        seed(&reg, UUID_B, "beta", "/tmp").await;
        let dir = tempfile::tempdir().unwrap();
        let mut prev = None;

        autosave_last(&reg, dir.path(), &mut prev).await.unwrap();
        reg.remove(UUID_B).await;
        autosave_last(&reg, dir.path(), &mut prev).await.unwrap();

        let last = std::fs::read_to_string(dir.path().join("last.tsv")).unwrap();
        assert!(last.contains(UUID_A));
        assert!(!last.contains(UUID_B), "close されたセッションは last.tsv から消える");

        cleanup(&reg).await;
    }

    /// Once teardown has begun, the autosave writes nothing — it must not clobber the graceful save's last.tsv (#372).
    #[cfg(unix)]
    #[tokio::test]
    async fn autosave_skips_while_shutting_down() {
        let reg = SessionRegistry::new();
        seed(&reg, UUID_A, "alpha", "/tmp").await;
        let dir = tempfile::tempdir().unwrap();
        reg.begin_shutdown();

        autosave_last(&reg, dir.path(), &mut None).await.unwrap();

        assert!(!dir.path().join("last.tsv").exists(), "撤収中は autosave が last.tsv を書かない");

        cleanup(&reg).await;
    }

    /// Crash resilience (#372): with only the periodic autosave (no graceful save at all), a fresh startup restores
    /// the session list. This is the exact regression the issue reports — save no longer depends on a clean shutdown.
    #[cfg(unix)]
    #[tokio::test]
    async fn crash_without_graceful_save_restores_from_autosaved_last_tsv() {
        let dir = tempfile::tempdir().unwrap();
        let reg1 = SessionRegistry::new();
        seed(&reg1, UUID_A, "alpha", "/tmp").await;
        seed(&reg1, UUID_B, "beta", "/tmp").await;
        autosave_last(&reg1, dir.path(), &mut None).await.unwrap();
        // Simulate a crash: no save_then_shutdown, just lose the registry.
        cleanup(&reg1).await;

        let reg2 = SessionRegistry::new();
        let restored = restore_sessions_on_startup(&reg2, dir.path(), true, "/bin/sh", None)
            .await
            .unwrap();
        assert_eq!(restored, 2, "graceful save 無しでも autosave 済みの last.tsv から復元される");
        assert_eq!(reg2.list().await, vec![UUID_B.to_string(), UUID_A.to_string()]);

        cleanup(&reg2).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn save_then_restore_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let reg1 = SessionRegistry::new();
        seed(&reg1, UUID_A, "alpha", "/tmp").await;
        seed(&reg1, UUID_B, "beta", "/tmp").await;
        save_sessions(&reg1, dir.path()).await.unwrap();
        cleanup(&reg1).await;

        let reg2 = SessionRegistry::new();
        let out = restore_sessions(&reg2, dir.path(), None, true, "/bin/sh", None)
            .await
            .unwrap();
        assert_eq!(out.restored, 2);
        assert_eq!(reg2.list().await, vec![UUID_B.to_string(), UUID_A.to_string()]);

        cleanup(&reg2).await;
    }
}
