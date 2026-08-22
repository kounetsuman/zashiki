use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::control::ControlServices;
use crate::repos;

/// Editor launch for `POST /api/git/open` (injected so tests can replace it).
/// Arguments are (repoPath, file). Side-effect only; success/failure is ignored (only spawn success is checked, and it doesn't block).
pub type OpenFile = Arc<dyn Fn(String, String) + Send + Sync>;

/// TTL cache for repos.conf scan results. Reuses, for a short window, the FS walk that scan performs on
/// every file read/poll, explorer, git, and search request, killing the main cause of "Loading..." lingering for seconds.
/// Since the repo list rarely changes, this level of staleness causes no real harm to how the explorer etc. appear.
pub(crate) const SCAN_CACHE_TTL: Duration = Duration::from_secs(5);

/// The TTL cache body for scan (fetch time + scan results). `None` means not yet fetched.
pub(crate) type ScanCache = Arc<tokio::sync::Mutex<Option<(Instant, Vec<repos::ScannedRepo>)>>>;

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) expected_token: Arc<Option<secrecy::SecretString>>,
    pub(crate) repos_conf: Arc<Option<PathBuf>>,
    pub(crate) control: Option<ControlServices>,
    pub(crate) editor: Arc<String>,
    pub(crate) open_file: Option<OpenFile>,
    pub(crate) file_max_bytes: u64,
    pub(crate) saves_dir: Arc<PathBuf>,
    /// Serializes save/restore (a series of destructive operations) within the server.
    pub(crate) persist_lock: Arc<tokio::sync::Mutex<()>>,
    /// TTL cache for scan (the repos.conf walk).
    pub(crate) scan_cache: ScanCache,
    /// The previous run's crash log tail, cleared by `POST /api/last-crash/ack` once the client has shown it.
    pub(crate) last_crash: Arc<std::sync::Mutex<Option<String>>>,
}

/// Default destination for session save/restore (`~/.zashiki/saves`).
/// The startup restore and shutdown save in main.rs use the same resolution.
pub fn default_saves_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(home).join(".zashiki").join("saves")
}

/// Splits `ZK_EDITOR` into argv (whitespace-separated; quotes are not interpreted).
fn parse_editor_command(editor: &str) -> Vec<String> {
    editor
        .split_whitespace()
        .map(|s| s.to_string())
        .collect()
}

/// Pick the effective editor command: a non-blank configured value (SETTINGS' live config.json
/// `editor`) takes precedence over the `fallback` (ZK_EDITOR or `cursor -g`, captured at startup).
pub(crate) fn resolve_editor<'a>(configured: Option<&'a str>, fallback: &'a str) -> &'a str {
    configured
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback)
}

/// Default editor launch (splits `ZK_EDITOR` into argv, appends `<file>` at the end, and spawns; does not
/// wait for exit). `Err` reports that the editor binary could not be launched — an empty command, or a
/// `spawn()` failure of argv[0] (not found / not executable); it cannot see a launcher that spawns then
/// mishandles the file. The caller decides whether to surface it.
pub(crate) fn spawn_editor(editor: &str, repo_path: &str, file: &str) -> std::io::Result<()> {
    let argv = parse_editor_command(editor);
    let Some((cmd, args)) = argv.split_first() else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "ZK_EDITOR is empty",
        ));
    };
    let abs = std::path::Path::new(repo_path).join(file);
    std::process::Command::new(cmd)
        .args(args)
        .arg(abs)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
}

/// Scans repos.conf (run under spawn_blocking since it is blocking I/O). The result is reused only for the
/// duration of SCAN_CACHE_TTL (shared by file read/poll, explorer, git, and search to avoid an FS walk each time).
pub(crate) async fn scan(state: &AppState) -> Vec<repos::ScannedRepo> {
    let mut cache = state.scan_cache.lock().await;
    if let Some((at, repos)) = cache.as_ref() {
        if at.elapsed() < SCAN_CACHE_TTL {
            return repos.clone();
        }
    }
    let conf = state.repos_conf.as_ref().clone();
    let repos = tokio::task::spawn_blocking(move || match conf.as_deref() {
        Some(path) => repos::scan_repos(path),
        None => Vec::new(),
    })
    .await
    .unwrap_or_default();
    *cache = Some((Instant::now(), repos.clone()));
    repos
}

/// Drop the cached scan so the next `scan` re-walks the filesystem (after the repo set changes,
/// e.g. a worktree removal).
pub(crate) async fn invalidate_scan_cache(state: &AppState) {
    *state.scan_cache.lock().await = None;
}

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{resolve_editor, spawn_editor};

    #[test]
    fn spawn_editor_errors_on_missing_binary() {
        let err = spawn_editor("zashiki-no-such-editor-xyz", "/tmp", "file.txt");
        assert!(err.is_err(), "a non-existent editor binary must surface as Err");
    }

    #[test]
    fn spawn_editor_errors_on_empty_command() {
        assert!(spawn_editor("   ", "/tmp", "file.txt").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn spawn_editor_ok_for_launchable_command() {
        // `true` exists and ignores its args, standing in for an editor that launches cleanly.
        assert!(spawn_editor("true", "/tmp", "file.txt").is_ok());
    }

    #[test]
    fn resolve_editor_prefers_configured_over_fallback() {
        assert_eq!(resolve_editor(Some("code -w"), "cursor -g"), "code -w");
    }

    #[test]
    fn resolve_editor_trims_configured_value() {
        assert_eq!(resolve_editor(Some("  vim  "), "cursor -g"), "vim");
    }

    #[test]
    fn resolve_editor_falls_back_when_unset_or_blank() {
        assert_eq!(resolve_editor(None, "cursor -g"), "cursor -g");
        assert_eq!(resolve_editor(Some(""), "cursor -g"), "cursor -g");
        assert_eq!(resolve_editor(Some("   "), "cursor -g"), "cursor -g");
    }
}
