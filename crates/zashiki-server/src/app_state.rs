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
    pub(crate) expected_token: Arc<Option<String>>,
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

/// Default editor launch (splits `ZK_EDITOR` into argv, appends `<file>` at the end, and spawns; does not wait for exit).
pub(crate) fn spawn_editor(editor: &str, repo_path: &str, file: &str) {
    let argv = parse_editor_command(editor);
    let Some((cmd, args)) = argv.split_first() else {
        return;
    };
    let abs = std::path::Path::new(repo_path).join(file);
    let _ = std::process::Command::new(cmd)
        .args(args)
        .arg(abs)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
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

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
