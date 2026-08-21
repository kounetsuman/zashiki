//! Self-update for the desktop app via Homebrew. The header Update button sends `update.perform`;
//! when the running bundle is a Homebrew-cask install we run `brew upgrade --cask zashiki` and then
//! relaunch, otherwise we just open the releases page. There is no in-app installer to run: brew
//! performs the dmg download + `/Applications` swap, and a detached helper handles the
//! quit-and-relaunch once brew finishes (the swap of a still-running bundle is allowed on macOS).
//!
//! The version-comparison / gating decisions are pure and unit-tested below; the process
//! orchestration around them is thin.

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

/// Single-quote a value for safe embedding in a `/bin/sh -c` script.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// The detached relauncher: SIGTERM the shell (its handler tears down the sidecar and exits), wait
/// for it to exit and for the listening port to free, then relaunch the freshly-installed bundle.
pub fn relaunch_script(shell_pid: i32, port: u16, bundle: &Path) -> String {
    let bundle = sh_quote(&bundle.to_string_lossy());
    format!(
        "kill {shell_pid} 2>/dev/null; \
         for _ in $(seq 1 150); do kill -0 {shell_pid} 2>/dev/null || break; sleep 0.2; done; \
         for _ in $(seq 1 150); do /usr/sbin/lsof -iTCP:{port} -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.2; done; \
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

async fn run_brew_upgrade(brew: &Path) -> Result<(), String> {
    let out = tokio::process::Command::new(brew)
        .args(["upgrade", "--cask", CASK_NAME])
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

fn spawn_detached(program: &str, args: &[&str]) {
    let mut cmd = std::process::Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    unsafe {
        use std::os::unix::process::CommandExt;
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let _ = cmd.spawn();
}

fn open_releases_page() {
    spawn_detached("/usr/bin/open", &[RELEASES_URL]);
}

fn spawn_relaunch(shell_pid: i32, port: u16, bundle: &Path) {
    spawn_detached("/bin/sh", &["-c", &relaunch_script(shell_pid, port, bundle)]);
}

/// Orchestrate an update triggered from the Update button, broadcasting status to all clients.
pub async fn perform_update(hub: Arc<ControlHub>, app_version_present: bool) {
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
            match run_brew_upgrade(&brew).await {
                Ok(()) => {
                    let shell_pid = unsafe { libc::getppid() };
                    spawn_relaunch(shell_pid, server_port(), &bundle);
                    hub.broadcast(status(UpdateStatusState::Relaunching, None));
                }
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
    fn relaunch_script_kills_shell_waits_and_reopens_bundle() {
        let s = relaunch_script(4321, 8790, Path::new("/Applications/Zashiki.app"));
        assert!(s.contains("kill 4321"));
        assert!(s.contains("kill -0 4321"));
        assert!(s.contains("lsof -iTCP:8790"));
        assert!(s.contains("/usr/bin/open -n '/Applications/Zashiki.app'"));
    }

    #[test]
    fn relaunch_script_quotes_paths_with_spaces() {
        let s = relaunch_script(1, 1, Path::new("/Apps/Za shiki.app"));
        assert!(s.contains("open -n '/Apps/Za shiki.app'"));
    }
}
