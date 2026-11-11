//! Infra adapter for `~/.claude/settings.json`: path resolution, atomic read/write with a backup,
//! and the register/unregister/status orchestration over the pure `claude_settings` merge. Sibling
//! to `statusline_hook.rs`, which reads the same file. Behavior is pinned by the `tests` below.

use std::io::{self, ErrorKind, Write as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::Value;

use crate::claude_settings::{
    merge_register, merge_unregister, registration_status, RegistrationStatus, ScriptPaths,
};

/// The resolved locations this adapter operates on. Injected into the control handlers (like
/// `config_path`) so tests can point them at a temp dir.
#[derive(Debug, Clone)]
pub struct ClaudeSettingsPaths {
    pub settings_path: PathBuf,
    pub hooks_dir: PathBuf,
}

impl ClaudeSettingsPaths {
    pub fn resolve() -> Self {
        Self {
            settings_path: default_settings_path(),
            hooks_dir: resolve_hooks_dir(),
        }
    }
}

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default()
}

fn default_settings_path() -> PathBuf {
    home().join(".claude/settings.json")
}

/// Resolves the directory holding the bundled `notify-event.sh` / `statusline.sh`. `ZK_HOOKS_DIR`
/// (passed by the desktop sidecar, mirroring `ZK_CLIENT_DIST`) wins; otherwise the `.app`'s
/// `../Resources/hooks` next to the executable; otherwise the repo's `hooks/` for dev/standalone.
fn resolve_hooks_dir() -> PathBuf {
    let exe = std::env::current_exe().ok();
    let exe_dir = exe.as_deref().and_then(Path::parent);
    let repo_hooks = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../hooks");
    let resolved = resolve_hooks_dir_from(std::env::var_os("ZK_HOOKS_DIR").map(PathBuf::from), exe_dir, &repo_hooks);
    std::fs::canonicalize(&resolved).unwrap_or(resolved)
}

/// Pure resolution logic (env / exe dir / repo fallback injected).
fn resolve_hooks_dir_from(env_override: Option<PathBuf>, exe_dir: Option<&Path>, repo_hooks: &Path) -> PathBuf {
    if let Some(dir) = env_override {
        return dir;
    }
    if let Some(bundled) = exe_dir.map(|d| d.join("../Resources/hooks")) {
        if bundled.is_dir() {
            return bundled;
        }
    }
    repo_hooks.to_path_buf()
}

fn script_paths(hooks_dir: &Path) -> ScriptPaths {
    ScriptPaths::from_hooks_dir(&hooks_dir.to_string_lossy())
}

/// Loads settings for merging. Missing or empty → an empty object (a fresh install). A present but
/// unparseable / non-object file is an error so we never clobber it.
fn load_for_merge(path: &Path) -> io::Result<Value> {
    match std::fs::read_to_string(path) {
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(Value::Object(Default::default())),
        Err(e) => Err(e),
        Ok(text) if text.trim().is_empty() => Ok(Value::Object(Default::default())),
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(v) if v.is_object() => Ok(v),
            _ => Err(io::Error::new(
                ErrorKind::InvalidData,
                "~/.claude/settings.json is not a valid JSON object",
            )),
        },
    }
}

/// Atomic write (temp → rename) after backing up the current file to `settings.json.bak`. The
/// serialized text is re-parsed as a guard before it replaces the original. A symlinked
/// settings.json is written through to its target so the link survives.
fn write_atomic(path: &Path, value: &Value) -> io::Result<()> {
    write_atomic_using(path, value, &TEMP_COUNTER)
}

fn write_atomic_using(path: &Path, value: &Value, temp_counter: &AtomicU64) -> io::Result<()> {
    let text = serde_json::to_string_pretty(value)? + "\n";
    serde_json::from_str::<Value>(&text).map_err(|e| io::Error::new(ErrorKind::InvalidData, e))?;
    remove_legacy_temp(path);
    let path = &resolve_symlink(path)?;
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir)?;
    let existing = match std::fs::metadata(path) {
        Ok(m) => Some(m),
        Err(e) if e.kind() == ErrorKind::NotFound => None,
        Err(e) => return Err(e),
    };
    if existing.is_some() {
        let backup = path.with_file_name(format!(
            "{}.bak",
            path.file_name().and_then(|n| n.to_str()).unwrap_or("settings.json")
        ));
        // A read-only previous backup would make the copy fail with EACCES.
        match std::fs::remove_file(&backup) {
            Err(e) if e.kind() != ErrorKind::NotFound => return Err(e),
            _ => {}
        }
        std::fs::copy(path, backup)?;
    }
    let mode = temp_mode(existing.as_ref());
    let (tmp, file) = create_unique_temp(dir, mode, temp_counter)?;
    let result = fill_and_rename(file, mode, &text, &tmp, path);
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

fn resolve_symlink(path: &Path) -> io::Result<PathBuf> {
    match std::fs::symlink_metadata(path) {
        Ok(m) if m.file_type().is_symlink() => std::fs::canonicalize(path),
        _ => Ok(path.to_path_buf()),
    }
}

fn fill_and_rename(mut file: std::fs::File, mode: u32, text: &str, tmp: &Path, path: &Path) -> io::Result<()> {
    restore_mode(&file, mode)?;
    file.write_all(text.as_bytes())?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(tmp, path)
}

/// Older builds wrote through this fixed name next to settings.json, and a leftover can hold a
/// world-readable copy of the settings.
fn remove_legacy_temp(path: &Path) {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let _ = std::fs::remove_file(dir.join(".settings.json.tmp"));
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
const TEMP_CREATE_ATTEMPTS: u32 = 16;

/// Creates the temp file under a name no other write is using, so overlapping writes never rename
/// each other's half-written file over settings.json. A name left behind by an earlier process
/// with the same pid is skipped.
fn create_unique_temp(dir: &Path, mode: u32, counter: &AtomicU64) -> io::Result<(PathBuf, std::fs::File)> {
    for _ in 0..TEMP_CREATE_ATTEMPTS {
        let n = counter.fetch_add(1, Ordering::Relaxed);
        let tmp = dir.join(format!(".settings.json.{}.{n}.tmp", std::process::id()));
        match open_new_with_mode(&tmp, mode) {
            Ok(file) => return Ok((tmp, file)),
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::new(ErrorKind::AlreadyExists, "no free temp file name next to settings.json"))
}

/// The permission bits of the file being replaced (0600 when there is none yet), so the
/// replacement is never more readable than the original.
#[cfg(unix)]
fn temp_mode(existing: Option<&std::fs::Metadata>) -> u32 {
    use std::os::unix::fs::PermissionsExt as _;
    existing.map_or(0o600, |m| m.permissions().mode() & 0o777)
}

#[cfg(unix)]
fn open_new_with_mode(tmp: &Path, mode: u32) -> io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt as _;
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .open(tmp)
}

/// The umask can only narrow the open mode; this restores the exact original bits.
#[cfg(unix)]
fn restore_mode(file: &std::fs::File, mode: u32) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    file.set_permissions(std::fs::Permissions::from_mode(mode))
}

#[cfg(not(unix))]
fn temp_mode(_existing: Option<&std::fs::Metadata>) -> u32 {
    0
}

#[cfg(not(unix))]
fn open_new_with_mode(tmp: &Path, _mode: u32) -> io::Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(tmp)
}

#[cfg(not(unix))]
fn restore_mode(_file: &std::fs::File, _mode: u32) -> io::Result<()> {
    Ok(())
}

pub fn current_status(paths: &ClaudeSettingsPaths) -> RegistrationStatus {
    current_status_with_readability(paths).0
}

/// Like [`current_status`], but the bool reports whether settings.json exists yet could not be read
/// (invalid JSON or a permission error) — distinct from a missing file, which is a legitimate "not registered".
pub fn current_status_with_readability(paths: &ClaudeSettingsPaths) -> (RegistrationStatus, bool) {
    match load_for_merge(&paths.settings_path) {
        // Missing / empty files also resolve to Ok(empty object) here, so this arm is never "unreadable".
        Ok(v) => (
            registration_status(&v, &script_paths(&paths.hooks_dir)),
            false,
        ),
        Err(_) => (RegistrationStatus::default(), true),
    }
}

pub fn apply_register(paths: &ClaudeSettingsPaths) -> io::Result<RegistrationStatus> {
    let scripts = script_paths(&paths.hooks_dir);
    let current = load_for_merge(&paths.settings_path)?;
    let (next, changed) = merge_register(&current, &scripts);
    if changed {
        write_atomic(&paths.settings_path, &next)?;
    }
    Ok(registration_status(&next, &scripts))
}

pub fn apply_unregister(paths: &ClaudeSettingsPaths) -> io::Result<RegistrationStatus> {
    let scripts = script_paths(&paths.hooks_dir);
    let current = load_for_merge(&paths.settings_path)?;
    let (next, changed) = merge_unregister(&current, &scripts);
    if changed {
        write_atomic(&paths.settings_path, &next)?;
    }
    Ok(registration_status(&next, &scripts))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths_in(dir: &Path) -> ClaudeSettingsPaths {
        ClaudeSettingsPaths {
            settings_path: dir.join("settings.json"),
            hooks_dir: PathBuf::from("/opt/zashiki/hooks"),
        }
    }

    #[test]
    fn resolve_prefers_env_then_bundled_then_repo() {
        let repo = Path::new("/repo/hooks");
        assert_eq!(
            resolve_hooks_dir_from(Some(PathBuf::from("/env/hooks")), Some(Path::new("/app/MacOS")), repo),
            PathBuf::from("/env/hooks")
        );
        // no env, no bundled dir on disk → repo fallback
        assert_eq!(resolve_hooks_dir_from(None, Some(Path::new("/does/not/exist")), repo), repo.to_path_buf());
        assert_eq!(resolve_hooks_dir_from(None, None, repo), repo.to_path_buf());
    }

    #[test]
    fn register_creates_file_and_status_reports_registered() {
        let dir = tempfile::tempdir().unwrap();
        let p = paths_in(dir.path());
        let st = apply_register(&p).unwrap();
        assert!(st.hooks_registered && st.status_line_registered);
        assert!(p.settings_path.exists());
        let written: Value = serde_json::from_str(&std::fs::read_to_string(&p.settings_path).unwrap()).unwrap();
        assert!(written["statusLine"]["command"].as_str().unwrap().contains("statusline.sh"));
    }

    #[test]
    fn register_is_idempotent_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let p = paths_in(dir.path());
        apply_register(&p).unwrap();
        let first = std::fs::read_to_string(&p.settings_path).unwrap();
        apply_register(&p).unwrap();
        let second = std::fs::read_to_string(&p.settings_path).unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn register_preserves_existing_file_and_backs_up() {
        let dir = tempfile::tempdir().unwrap();
        let p = paths_in(dir.path());
        std::fs::write(&p.settings_path, r#"{"model":"opus"}"#).unwrap();
        apply_register(&p).unwrap();
        let written: Value = serde_json::from_str(&std::fs::read_to_string(&p.settings_path).unwrap()).unwrap();
        assert_eq!(written["model"], serde_json::json!("opus"));
        assert!(dir.path().join("settings.json.bak").exists(), "a backup is kept before overwrite");
    }

    #[test]
    fn register_then_unregister_restores_original_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let p = paths_in(dir.path());
        let original = "{\n  \"model\": \"opus\"\n}\n";
        std::fs::write(&p.settings_path, original).unwrap();
        apply_register(&p).unwrap();
        apply_unregister(&p).unwrap();
        let back: Value = serde_json::from_str(&std::fs::read_to_string(&p.settings_path).unwrap()).unwrap();
        assert_eq!(back, serde_json::json!({"model": "opus"}));
    }

    #[test]
    fn corrupt_settings_is_an_error_not_a_clobber() {
        let dir = tempfile::tempdir().unwrap();
        let p = paths_in(dir.path());
        std::fs::write(&p.settings_path, "{not json").unwrap();
        assert!(apply_register(&p).is_err());
        assert_eq!(std::fs::read_to_string(&p.settings_path).unwrap(), "{not json", "must not overwrite corrupt file");
    }

    #[test]
    fn status_on_missing_file_is_all_false() {
        let dir = tempfile::tempdir().unwrap();
        let st = current_status(&paths_in(dir.path()));
        assert!(!st.hooks_registered && !st.status_line_registered && !st.status_line_conflict);
    }

    #[test]
    fn readability_flags_corrupt_file_but_not_a_missing_one() {
        let dir = tempfile::tempdir().unwrap();
        let p = paths_in(dir.path());

        // Missing file: legitimately "not registered", not flagged as unreadable.
        let (st, unreadable) = current_status_with_readability(&p);
        assert!(!unreadable);
        assert_eq!(st, RegistrationStatus::default());

        // Present but invalid JSON: default status AND flagged unreadable.
        std::fs::write(&p.settings_path, "{not json").unwrap();
        let (st, unreadable) = current_status_with_readability(&p);
        assert!(unreadable);
        assert_eq!(st, RegistrationStatus::default());
    }

    #[cfg(unix)]
    fn set_mode(path: &Path, mode: u32) {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    #[cfg(unix)]
    fn mode_of(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[cfg(unix)]
    #[test]
    fn write_keeps_an_existing_0600_file_at_0600() {
        let dir = tempfile::tempdir().unwrap();
        let p = paths_in(dir.path());
        std::fs::write(&p.settings_path, r#"{"env":{"TOKEN":"secret"}}"#).unwrap();
        set_mode(&p.settings_path, 0o600);
        apply_register(&p).unwrap();
        assert_eq!(mode_of(&p.settings_path), 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn write_keeps_an_existing_0644_file_at_0644() {
        let dir = tempfile::tempdir().unwrap();
        let p = paths_in(dir.path());
        std::fs::write(&p.settings_path, r#"{"model":"opus"}"#).unwrap();
        set_mode(&p.settings_path, 0o644);
        apply_register(&p).unwrap();
        assert_eq!(mode_of(&p.settings_path), 0o644);
    }

    #[cfg(unix)]
    #[test]
    fn write_keeps_a_group_writable_0660_file_at_0660_despite_the_umask() {
        let dir = tempfile::tempdir().unwrap();
        let p = paths_in(dir.path());
        std::fs::write(&p.settings_path, r#"{"model":"opus"}"#).unwrap();
        set_mode(&p.settings_path, 0o660);
        apply_register(&p).unwrap();
        assert_eq!(mode_of(&p.settings_path), 0o660);
    }

    #[cfg(unix)]
    #[test]
    fn write_creates_a_new_file_at_0600() {
        let dir = tempfile::tempdir().unwrap();
        let p = paths_in(dir.path());
        apply_register(&p).unwrap();
        assert_eq!(mode_of(&p.settings_path), 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn backup_keeps_the_original_mode_over_a_looser_stale_backup() {
        let dir = tempfile::tempdir().unwrap();
        let p = paths_in(dir.path());
        let backup = dir.path().join("settings.json.bak");
        std::fs::write(&backup, "{}").unwrap();
        set_mode(&backup, 0o644);
        std::fs::write(&p.settings_path, r#"{"model":"opus"}"#).unwrap();
        set_mode(&p.settings_path, 0o600);
        apply_register(&p).unwrap();
        assert_eq!(mode_of(&backup), 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn two_writes_on_a_read_only_0400_file_both_succeed_and_keep_0400() {
        let dir = tempfile::tempdir().unwrap();
        let p = paths_in(dir.path());
        std::fs::write(&p.settings_path, r#"{"model":"opus"}"#).unwrap();
        set_mode(&p.settings_path, 0o400);
        apply_register(&p).unwrap();
        apply_unregister(&p).unwrap();
        assert_eq!(mode_of(&p.settings_path), 0o400);
        let back: Value = serde_json::from_str(&std::fs::read_to_string(&p.settings_path).unwrap()).unwrap();
        assert_eq!(back, serde_json::json!({"model": "opus"}));
    }

    #[cfg(unix)]
    #[test]
    fn write_through_a_symlinked_settings_file_updates_the_real_file_and_keeps_the_link() {
        let dir = tempfile::tempdir().unwrap();
        let p = paths_in(dir.path());
        let dotfiles = dir.path().join("dotfiles");
        std::fs::create_dir(&dotfiles).unwrap();
        let real = dotfiles.join("settings.json");
        std::fs::write(&real, r#"{"model":"opus"}"#).unwrap();
        set_mode(&real, 0o640);
        std::os::unix::fs::symlink(&real, &p.settings_path).unwrap();
        apply_register(&p).unwrap();
        assert!(std::fs::symlink_metadata(&p.settings_path).unwrap().file_type().is_symlink());
        let written: Value = serde_json::from_str(&std::fs::read_to_string(&real).unwrap()).unwrap();
        assert_eq!(written["model"], serde_json::json!("opus"));
        assert!(written["statusLine"]["command"].as_str().unwrap().contains("statusline.sh"));
        assert_eq!(mode_of(&real), 0o640);
    }

    #[cfg(unix)]
    #[test]
    fn write_removes_a_legacy_fixed_name_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = paths_in(dir.path());
        let leftover = dir.path().join(".settings.json.tmp");
        std::fs::write(&leftover, "stale").unwrap();
        set_mode(&leftover, 0o644);
        apply_register(&p).unwrap();
        assert_eq!(mode_of(&p.settings_path), 0o600);
        assert!(std::fs::read_to_string(&p.settings_path).unwrap().contains("statusline.sh"));
        assert!(!leftover.exists());
    }

    fn temp_files_in(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect()
    }

    #[test]
    fn write_skips_a_temp_name_left_by_an_earlier_process_with_the_same_pid() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let taken = dir.path().join(format!(".settings.json.{}.0.tmp", std::process::id()));
        std::fs::write(&taken, "left by a crashed process").unwrap();
        write_atomic_using(&path, &serde_json::json!({"model": "opus"}), &AtomicU64::new(0)).unwrap();
        let written: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(written, serde_json::json!({"model": "opus"}));
        std::fs::remove_file(&taken).unwrap();
        assert_eq!(temp_files_in(dir.path()), Vec::<String>::new());
    }

    #[test]
    fn sequential_writes_leave_no_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let p = paths_in(dir.path());
        apply_register(&p).unwrap();
        apply_unregister(&p).unwrap();
        apply_register(&p).unwrap();
        assert!(std::fs::read_to_string(&p.settings_path).unwrap().contains("statusline.sh"));
        assert_eq!(temp_files_in(dir.path()), Vec::<String>::new());
    }
}
