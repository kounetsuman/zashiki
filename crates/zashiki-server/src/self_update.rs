//! Self-update for the desktop app via Homebrew. The header Update button sends `update.perform`;
//! when the running bundle is a Homebrew-cask install we upgrade the cask and relaunch, otherwise we
//! open the releases page.
//!
//! The upgrade runs in a detached helper (`setsid`) that SIGTERMs the app, runs `brew upgrade`, then
//! reopens the bundle. It must terminate the app itself rather than let brew's `uninstall quit:` do
//! it: a SIGTERM bypasses the guarded-quit dialog and makes the cask quit a no-op, and detaching
//! keeps the helper out of the sidecar process group that the quit tears down. Steps and brew output
//! append to `~/Library/Logs/zashiki/update.log`; `brew fetch` runs in-process first so a download
//! failure is reportable while the app is alive.
//!
//! The version-comparison / gating decisions are pure and unit-tested below; the process
//! orchestration around them is thin.

use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use crate::control_hub::ControlHub;
use crate::protocol::{ServerMessage, UpdateStatusState};

const CASK_NAME: &str = "zashiki";
const RELEASES_URL: &str = "https://github.com/kounetsuman/zashiki/releases/latest";
const DEFAULT_PORT: u16 = 8790;

/// Standard Homebrew locations (Apple Silicon, then Intel). A GUI-launched app does not inherit a
/// shell PATH, so `brew` must be probed by absolute path rather than found on PATH.
const BREW_CANDIDATES: [&str; 2] = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"];

/// Where an update ends up going, decided from the environment. Pure so the branch matrix is testable.
#[derive(Debug, PartialEq, Eq)]
pub enum UpdateMode {
    Brew { brew: PathBuf, bundle: PathBuf },
    OpenPage,
}

/// Brew-upgrade only when we are the desktop bundle (a real app version), brew is present, we found
/// our enclosing `.app`, and that app is actually the installed cask. Anything else opens the page.
pub fn decide_update_mode(
    app_version_present: bool,
    brew: Option<PathBuf>,
    bundle: Option<PathBuf>,
    cask_installed: bool,
) -> UpdateMode {
    match (app_version_present, brew, bundle, cask_installed) {
        (true, Some(brew), Some(bundle), true) => UpdateMode::Brew { brew, bundle },
        _ => UpdateMode::OpenPage,
    }
}

/// Resolve the Homebrew binary by probing the standard locations. `exists` is injected for testing.
pub fn resolve_brew_with(exists: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    BREW_CANDIDATES
        .iter()
        .map(PathBuf::from)
        .find(|p| exists(p))
}

fn resolve_brew() -> Option<PathBuf> {
    resolve_brew_with(|p| p.exists())
}

/// Walk up from the running server binary to the enclosing `*.app` bundle directory (the server
/// binary is bundled inside the app, so an ancestor is the `.app`).
pub fn app_bundle_path(current_exe: &Path) -> Option<PathBuf> {
    current_exe
        .ancestors()
        .find(|p| p.extension().is_some_and(|e| e == "app"))
        .map(Path::to_path_buf)
}

/// The helper's log path under `~/Library/Logs/zashiki` (temp dir if HOME is unset).
fn update_log_path() -> PathBuf {
    let base = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join("Library/Logs/zashiki/update.log")
}

/// Single-quote a value for safe embedding in a `/bin/sh -c` script.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// The detached helper script: SIGTERM the app, wait for it and its port to free, `brew upgrade`,
/// then reopen the bundle. Logging is best-effort (falls back to `/dev/null`); the relaunch runs even
/// after a failed upgrade so a window returns, with a notification on failure.
pub fn update_script(
    brew: &Path,
    cask: &str,
    log_path: &Path,
    shell_pid: i32,
    port: u16,
    bundle: &Path,
) -> String {
    let brew = sh_quote(&brew.to_string_lossy());
    let cask = sh_quote(cask);
    let log = sh_quote(&log_path.to_string_lossy());
    let bundle = sh_quote(&bundle.to_string_lossy());
    let releases = sh_quote(RELEASES_URL);
    format!(
        "log={log}; \
         mkdir -p \"$(dirname \"$log\")\" 2>/dev/null; \
         ( : >> \"$log\" ) 2>/dev/null || log=/dev/null; \
         exec >> \"$log\" 2>&1; \
         echo \"--- self-update $(/bin/date '+%Y-%m-%dT%H:%M:%S%z') ---\"; \
         echo \"terminating pid {shell_pid}\"; \
         kill {shell_pid} 2>/dev/null; \
         for _ in $(seq 1 150); do kill -0 {shell_pid} 2>/dev/null || break; sleep 0.2; done; \
         for _ in $(seq 1 150); do /usr/sbin/lsof -iTCP:{port} -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.2; done; \
         echo \"upgrade: brew upgrade --cask {cask}\"; \
         HOMEBREW_NO_AUTO_UPDATE=1 {brew} upgrade --cask {cask}; \
         status=$?; \
         echo \"brew exit status: $status\"; \
         if [ ! -d {bundle} ]; then \
             echo 'bundle missing after upgrade; opening releases page'; \
             /usr/bin/osascript -e 'display notification \"Update failed and Zashiki could not reopen. Opening the releases page.\" with title \"Zashiki\"' 2>/dev/null; \
             /usr/bin/open {releases}; \
             exit 1; \
         fi; \
         if [ \"$status\" -ne 0 ]; then \
             echo 'upgrade failed; relaunching the existing version'; \
             /usr/bin/osascript -e 'display notification \"Update failed; reopened the current version. See ~/Library/Logs/zashiki/update.log.\" with title \"Zashiki\"' 2>/dev/null; \
         fi; \
         echo 'relaunching'; \
         /usr/bin/open -n {bundle}",
    )
}

fn status(state: UpdateStatusState, detail: Option<String>) -> ServerMessage {
    ServerMessage::UpdateStatus { state, detail }
}

fn server_port() -> u16 {
    std::env::var("ZK_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_PORT)
}

async fn is_cask_installed(brew: &Path, cask: &str) -> bool {
    tokio::process::Command::new(brew)
        .args(["list", "--cask", cask])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Pre-download and verify the cask; the detached upgrade reuses this cache.
async fn run_brew_fetch(brew: &Path) -> Result<(), String> {
    let out = tokio::process::Command::new(brew)
        .args(["fetch", "--cask", CASK_NAME])
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| format!("failed to run brew: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let tail: String = stderr.chars().rev().take(500).collect::<String>().chars().rev().collect();
        Err(tail.trim().to_string())
    }
}

/// Spawn `program` in its own session so it survives the process-group teardown that follows an app
/// quit. Fails closed: an un-detached helper would be killed with us.
fn spawn_detached(program: &str, args: &[&str]) -> io::Result<()> {
    let mut cmd = std::process::Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    unsafe {
        use std::os::unix::process::CommandExt;
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    cmd.spawn().map(|_| ())
}

fn open_releases_page() {
    let _ = spawn_detached("/usr/bin/open", &[RELEASES_URL]);
}

fn spawn_update(brew: &Path, bundle: &Path, shell_pid: i32, port: u16) -> io::Result<()> {
    let script = update_script(brew, CASK_NAME, &update_log_path(), shell_pid, port, bundle);
    spawn_detached("/bin/sh", &["-c", &script])
}

/// Orchestrate an update triggered from the Update button, broadcasting status to all clients.
pub async fn perform_update(hub: Arc<ControlHub>, app_version_present: bool) {
    // Capture before the awaits below, while the parent shell is still our parent (not yet launchd).
    let shell_pid = unsafe { libc::getppid() };
    let brew = resolve_brew();
    let bundle = std::env::current_exe().ok().and_then(|e| app_bundle_path(&e));
    let cask_installed = match &brew {
        Some(b) => is_cask_installed(b, CASK_NAME).await,
        None => false,
    };
    match decide_update_mode(app_version_present, brew, bundle, cask_installed) {
        UpdateMode::OpenPage => {
            open_releases_page();
            hub.broadcast(status(UpdateStatusState::Opened, None));
        }
        UpdateMode::Brew { brew, bundle } => {
            hub.broadcast(status(UpdateStatusState::Running, None));
            match run_brew_fetch(&brew).await {
                Ok(()) => match spawn_update(&brew, &bundle, shell_pid, server_port()) {
                    Ok(()) => hub.broadcast(status(UpdateStatusState::Relaunching, None)),
                    Err(e) => hub.broadcast(status(
                        UpdateStatusState::Failed,
                        Some(format!("failed to start updater: {e}")),
                    )),
                },
                Err(detail) => hub.broadcast(status(UpdateStatusState::Failed, Some(detail))),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_brew_prefers_apple_silicon_then_intel() {
        assert_eq!(resolve_brew_with(|_| true), Some(PathBuf::from("/opt/homebrew/bin/brew")));
        assert_eq!(
            resolve_brew_with(|p| p == Path::new("/usr/local/bin/brew")),
            Some(PathBuf::from("/usr/local/bin/brew")),
        );
        assert_eq!(resolve_brew_with(|_| false), None);
    }

    #[test]
    fn app_bundle_path_finds_enclosing_dot_app() {
        assert_eq!(
            app_bundle_path(Path::new("/Applications/Zashiki.app/Contents/MacOS/zashiki-server")),
            Some(PathBuf::from("/Applications/Zashiki.app")),
        );
        assert_eq!(app_bundle_path(Path::new("/usr/local/bin/zashiki-server")), None);
    }

    #[test]
    fn decide_brew_only_when_everything_lines_up() {
        let brew = || Some(PathBuf::from("/opt/homebrew/bin/brew"));
        let bundle = || Some(PathBuf::from("/Applications/Zashiki.app"));
        assert_eq!(
            decide_update_mode(true, brew(), bundle(), true),
            UpdateMode::Brew {
                brew: PathBuf::from("/opt/homebrew/bin/brew"),
                bundle: PathBuf::from("/Applications/Zashiki.app"),
            },
        );
        assert_eq!(decide_update_mode(false, brew(), bundle(), true), UpdateMode::OpenPage);
        assert_eq!(decide_update_mode(true, None, bundle(), true), UpdateMode::OpenPage);
        assert_eq!(decide_update_mode(true, brew(), None, true), UpdateMode::OpenPage);
        assert_eq!(decide_update_mode(true, brew(), bundle(), false), UpdateMode::OpenPage);
    }

    #[test]
    fn update_script_terminates_app_before_brew_and_relaunches_after() {
        let s = update_script(
            Path::new("/opt/homebrew/bin/brew"),
            "zashiki",
            Path::new("/Users/x/Library/Logs/zashiki/update.log"),
            4321,
            8790,
            Path::new("/Applications/Zashiki.app"),
        );
        let kill_at = s.find("kill 4321").expect("app is SIGTERM'd");
        let brew_at = s.find("upgrade --cask 'zashiki'").expect("brew upgrade runs");
        let open_at = s.find("/usr/bin/open -n '/Applications/Zashiki.app'").expect("bundle reopened");
        assert!(kill_at < brew_at, "the app must be terminated before brew runs");
        assert!(brew_at < open_at, "brew must run before the relaunch");
        assert!(s.contains("kill -0 4321"), "waits for the app to actually exit before brew");
        assert!(s.contains("lsof -iTCP:8790"));
        assert!(s.contains("HOMEBREW_NO_AUTO_UPDATE=1"));
    }

    #[test]
    fn update_script_logging_is_best_effort() {
        let s = update_script(
            Path::new("/opt/homebrew/bin/brew"),
            "zashiki",
            Path::new("/Users/x/Library/Logs/zashiki/update.log"),
            1,
            1,
            Path::new("/Applications/Zashiki.app"),
        );
        assert!(s.contains("log='/Users/x/Library/Logs/zashiki/update.log'"));
        assert!(s.contains("|| log=/dev/null"), "unwritable log must not abort the helper");
        assert!(s.contains("exec >> \"$log\" 2>&1"));
    }

    #[test]
    fn update_script_reports_failure_and_keeps_a_window() {
        let s = update_script(
            Path::new("/opt/homebrew/bin/brew"),
            "zashiki",
            Path::new("/tmp/update.log"),
            1,
            1,
            Path::new("/Applications/Zashiki.app"),
        );
        let guard_at = s.find("if [ ! -d '/Applications/Zashiki.app' ]").expect("bundle-exists guard");
        let open_at = s.find("/usr/bin/open -n").expect("relaunch present");
        assert!(guard_at < open_at, "a missing bundle must short-circuit before the relaunch");
        assert!(s.contains("/usr/bin/open 'https://github.com/kounetsuman/zashiki/releases/latest'"));
        assert!(s.contains("display notification"), "failures are surfaced to the user");
    }

    #[test]
    fn update_script_quotes_paths_with_spaces() {
        let s = update_script(
            Path::new("/opt/homebrew/bin/brew"),
            "zashiki",
            Path::new("/L/Za shiki/update.log"),
            1,
            1,
            Path::new("/Apps/Za shiki.app"),
        );
        assert!(s.contains("log='/L/Za shiki/update.log'"));
        assert!(s.contains("open -n '/Apps/Za shiki.app'"));
    }
}
