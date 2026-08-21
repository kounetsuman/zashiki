//! Infra adapter for `~/.claude/settings.json`: path resolution, atomic read/write with a backup,
//! and the register/unregister/status orchestration over the pure `claude_settings` merge. Sibling
//! to `statusline_hook.rs`, which reads the same file. Behavior is pinned by the `tests` below.

use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};

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
/// serialized text is re-parsed as a guard before it replaces the original.
fn write_atomic(path: &Path, value: &Value) -> io::Result<()> {
    let text = serde_json::to_string_pretty(value)? + "\n";
    serde_json::from_str::<Value>(&text).map_err(|e| io::Error::new(ErrorKind::InvalidData, e))?;
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir)?;
    if path.exists() {
        let backup = path.with_file_name(format!(
            "{}.bak",
            path.file_name().and_then(|n| n.to_str()).unwrap_or("settings.json")
        ));
        std::fs::copy(path, backup)?;
    }
    let tmp = dir.join(".settings.json.tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)
}

pub fn current_status(paths: &ClaudeSettingsPaths) -> RegistrationStatus {
    match load_for_merge(&paths.settings_path) {
        Ok(v) => registration_status(&v, &script_paths(&paths.hooks_dir)),
        Err(_) => RegistrationStatus::default(),
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
}
