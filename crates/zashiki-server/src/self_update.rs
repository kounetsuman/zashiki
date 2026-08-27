//! Self-update for the desktop app. The header Update button sends `update.perform`; when the running
//! bundle is a writable `.app` we swap it in place with the newest signed release, otherwise we open the
//! releases page.
//!
//! The swap runs in a detached helper (`setsid`) that SIGTERMs the app, waits for it and its port to
//! free, then runs the bundled `install.sh` in self-update mode (download → verify signature → atomic
//! bundle swap) and reopens the app. Detaching keeps the helper out of the sidecar process group that
//! the quit tears down; `install.sh` is copied to a temp path first so swapping the bundle can't pull
//! the running script out from under it. Detection stays on the GitHub Releases API (see
//! `update_checker`); installation is likewise tap-free, so a lagging Homebrew tap never blocks updates.
//! Steps and installer output append to `~/Library/Logs/zashiki/update.log`.
//!
//! The gating decisions are pure and unit-tested below; the process orchestration around them is thin.

use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use crate::control_hub::ControlHub;
use crate::protocol::{ServerMessage, UpdateStatusState};

const RELEASES_URL: &str = "https://github.com/kounetsuman/zashiki/releases/latest";
const DEFAULT_PORT: u16 = 8790;

/// Where an update ends up going, decided from the environment. Pure so the branch matrix is testable.
#[derive(Debug, PartialEq, Eq)]
pub enum UpdateMode {
    Swap { bundle: PathBuf, installer: PathBuf },
    OpenPage,
}

/// Swap in place only when we are the desktop bundle (a real app version), we found our enclosing
/// `.app`, the bundled installer is present, and the install location is writable. Anything else opens
/// the releases page (e.g. a dev/standalone binary, or a read-only bundle needing admin rights).
pub fn decide_update_mode(
    app_version_present: bool,
    bundle: Option<PathBuf>,
    installer: Option<PathBuf>,
    install_writable: bool,
) -> UpdateMode {
    match (app_version_present, bundle, installer, install_writable) {
        (true, Some(bundle), Some(installer), true) => UpdateMode::Swap { bundle, installer },
        _ => UpdateMode::OpenPage,
    }
}

/// Walk up from the running server binary to the enclosing `*.app` bundle directory (the server
/// binary is bundled inside the app, so an ancestor is the `.app`).
pub fn app_bundle_path(current_exe: &Path) -> Option<PathBuf> {
    current_exe
        .ancestors()
        .find(|p| p.extension().is_some_and(|e| e == "app"))
        .map(Path::to_path_buf)
}

/// The bundled `install.sh` lives next to the executable at `../Resources/install.sh` (mirroring the
/// hooks / client-dist resources). `exists` is injected for testing.
pub fn resolve_installer_with(exe_dir: &Path, exists: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    let candidate = exe_dir.join("../Resources/install.sh");
    exists(&candidate).then_some(candidate)
}

fn resolve_installer(exe_dir: &Path) -> Option<PathBuf> {
    resolve_installer_with(exe_dir, |p| p.is_file())
}

/// Best-effort probe of whether we can replace the bundle: try to create and remove a marker file in
/// its parent. `/Applications` is admin-writable for most users but not all, so this decides between an
/// in-place swap and falling back to the releases page.
fn dir_writable(dir: &Path) -> bool {
    let marker = dir.join(format!(".zashiki-update-check-{}", std::process::id()));
    match std::fs::File::create(&marker) {
        Ok(_) => {
            let _ = std::fs::remove_file(&marker);
            true
        }
        Err(_) => false,
    }
}

/// Copy the bundled installer to a unique temp path so the bundle swap (which replaces the bundled copy)
/// can't pull the running script out from under the helper, and two presses never stage to the same file.
fn stage_installer(installer: &Path) -> io::Result<PathBuf> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let staged = std::env::temp_dir().join(format!("zashiki-update-{}-{seq}.sh", std::process::id()));
    std::fs::copy(installer, &staged)?;
    Ok(staged)
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

/// The detached helper script: SIGTERM the app, wait for it and its port to free, run `install.sh` in
/// self-update mode (download → verify → atomic swap), then reopen the bundle. Logging is best-effort
/// (falls back to `/dev/null`); the relaunch runs even after a failed install so a window returns, with
/// a notification on failure. A missing bundle (should not happen given the atomic swap) opens the
/// releases page instead.
pub fn update_script(
    installer: &Path,
    log_path: &Path,
    shell_pid: i32,
    port: u16,
    bundle: &Path,
    install_dir: &Path,
    version: &str,
) -> String {
    let installer = sh_quote(&installer.to_string_lossy());
    let log = sh_quote(&log_path.to_string_lossy());
    let bundle = sh_quote(&bundle.to_string_lossy());
    let install_dir = sh_quote(&install_dir.to_string_lossy());
    let version = sh_quote(version);
    let releases = sh_quote(RELEASES_URL);
    format!(
        "export PATH=/usr/bin:/bin:/usr/sbin:/sbin:$PATH; \
         log={log}; \
         mkdir -p \"$(dirname \"$log\")\" 2>/dev/null; \
         ( : >> \"$log\" ) 2>/dev/null || log=/dev/null; \
         exec >> \"$log\" 2>&1; \
         echo \"--- self-update $(/bin/date '+%Y-%m-%dT%H:%M:%S%z') ---\"; \
         echo \"terminating pid {shell_pid}\"; \
         kill {shell_pid} 2>/dev/null; \
         for _ in $(seq 1 150); do kill -0 {shell_pid} 2>/dev/null || break; sleep 0.2; done; \
         for _ in $(seq 1 150); do /usr/sbin/lsof -iTCP:{port} -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.2; done; \
         echo \"installing {version} via {installer}\"; \
         ZASHIKI_SELF_UPDATE=1 ZASHIKI_VERSION={version} ZASHIKI_INSTALL_DIR={install_dir} /bin/bash {installer}; \
         status=$?; \
         echo \"installer exit status: $status\"; \
         rm -f {installer}; \
         if [ ! -d {bundle} ]; then \
             echo 'bundle missing after install; opening releases page'; \
             /usr/bin/osascript -e 'display notification \"Update failed and Zashiki could not reopen. Opening the releases page.\" with title \"Zashiki\"' 2>/dev/null; \
             /usr/bin/open {releases}; \
             exit 1; \
         fi; \
         if [ \"$status\" -ne 0 ]; then \
             echo 'install failed; relaunching the existing version'; \
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

fn spawn_update(installer: &Path, bundle: &Path, install_dir: &Path, version: &str, shell_pid: i32, port: u16) -> io::Result<()> {
    let script = update_script(installer, &update_log_path(), shell_pid, port, bundle, install_dir, version);
    spawn_detached("/bin/sh", &["-c", &script])
}

/// Orchestrate an update triggered from the Update button, broadcasting status to all clients.
pub async fn perform_update(hub: Arc<ControlHub>, app_version_present: bool) {
    // Capture before the awaits below, while the parent shell is still our parent (not yet launchd).
    let shell_pid = unsafe { libc::getppid() };
    let exe = std::env::current_exe().ok();
    let bundle = exe.as_deref().and_then(app_bundle_path);
    let installer = exe.as_deref().and_then(Path::parent).and_then(resolve_installer);
    let install_dir = bundle.as_deref().and_then(Path::parent).map(Path::to_path_buf);
    let writable = install_dir.as_deref().map(dir_writable).unwrap_or(false);

    match decide_update_mode(app_version_present, bundle.clone(), installer, writable) {
        UpdateMode::OpenPage => {
            open_releases_page();
            hub.broadcast(status(UpdateStatusState::Opened, None));
        }
        UpdateMode::Swap { bundle, installer } => {
            // Unwrap is safe: Swap implies bundle is Some, so its parent produced install_dir.
            let install_dir = install_dir.expect("swap mode has a bundle parent");
            hub.broadcast(status(UpdateStatusState::Running, None));
            // Resolve the release while the app is still alive so an offline / rate-limited GitHub is
            // reported in-app, not discovered only after the app has been torn down. The installer is
            // then pinned to this exact tag so it installs what detection resolved.
            let Some(version) = crate::update_checker::resolve_latest_tag().await else {
                hub.broadcast(status(
                    UpdateStatusState::Failed,
                    Some("could not reach GitHub to resolve the latest release".to_string()),
                ));
                return;
            };
            match stage_installer(&installer) {
                Ok(staged) => match spawn_update(&staged, &bundle, &install_dir, &version, shell_pid, server_port()) {
                    Ok(()) => hub.broadcast(status(UpdateStatusState::Relaunching, None)),
                    Err(e) => hub.broadcast(status(
                        UpdateStatusState::Failed,
                        Some(format!("failed to start updater: {e}")),
                    )),
                },
                Err(e) => hub.broadcast(status(
                    UpdateStatusState::Failed,
                    Some(format!("failed to stage updater: {e}")),
                )),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_bundle_path_finds_enclosing_dot_app() {
        assert_eq!(
            app_bundle_path(Path::new("/Applications/Zashiki.app/Contents/MacOS/zashiki-server")),
            Some(PathBuf::from("/Applications/Zashiki.app")),
        );
        assert_eq!(app_bundle_path(Path::new("/usr/local/bin/zashiki-server")), None);
    }

    #[test]
    fn resolve_installer_finds_bundled_script_next_to_exe() {
        let exe_dir = Path::new("/Applications/Zashiki.app/Contents/MacOS");
        assert_eq!(
            resolve_installer_with(exe_dir, |_| true),
            Some(PathBuf::from("/Applications/Zashiki.app/Contents/MacOS/../Resources/install.sh")),
        );
        assert_eq!(resolve_installer_with(exe_dir, |_| false), None);
    }

    #[test]
    fn decide_swap_only_when_everything_lines_up() {
        let bundle = || Some(PathBuf::from("/Applications/Zashiki.app"));
        let installer = || Some(PathBuf::from("/Applications/Zashiki.app/Contents/Resources/install.sh"));
        assert_eq!(
            decide_update_mode(true, bundle(), installer(), true),
            UpdateMode::Swap {
                bundle: PathBuf::from("/Applications/Zashiki.app"),
                installer: PathBuf::from("/Applications/Zashiki.app/Contents/Resources/install.sh"),
            },
        );
        assert_eq!(decide_update_mode(false, bundle(), installer(), true), UpdateMode::OpenPage);
        assert_eq!(decide_update_mode(true, None, installer(), true), UpdateMode::OpenPage);
        assert_eq!(decide_update_mode(true, bundle(), None, true), UpdateMode::OpenPage);
        assert_eq!(decide_update_mode(true, bundle(), installer(), false), UpdateMode::OpenPage);
    }

    #[test]
    fn update_script_terminates_app_before_install_and_relaunches_after() {
        let s = update_script(
            Path::new("/tmp/zashiki-update-1.sh"),
            Path::new("/Users/x/Library/Logs/zashiki/update.log"),
            4321,
            8790,
            Path::new("/Applications/Zashiki.app"),
            Path::new("/Applications"),
            "v0.14.0",
        );
        let kill_at = s.find("kill 4321").expect("app is SIGTERM'd");
        let install_at = s.find("/bin/bash '/tmp/zashiki-update-1.sh'").expect("installer runs");
        let open_at = s.find("/usr/bin/open -n '/Applications/Zashiki.app'").expect("bundle reopened");
        assert!(kill_at < install_at, "the app must be terminated before the installer runs");
        assert!(install_at < open_at, "the installer must run before the relaunch");
        assert!(s.contains("kill -0 4321"), "waits for the app to actually exit before installing");
        assert!(s.contains("lsof -iTCP:8790"));
        assert!(s.contains("ZASHIKI_SELF_UPDATE=1"), "installer runs in self-update mode");
        assert!(s.contains("ZASHIKI_VERSION='v0.14.0'"), "the resolved tag is pinned for the installer");
        assert!(s.contains("ZASHIKI_INSTALL_DIR='/Applications'"), "install location is passed through");
    }

    #[test]
    fn update_script_logging_is_best_effort() {
        let s = update_script(
            Path::new("/tmp/u.sh"),
            Path::new("/Users/x/Library/Logs/zashiki/update.log"),
            1,
            1,
            Path::new("/Applications/Zashiki.app"),
            Path::new("/Applications"),
            "v0.14.0",
        );
        assert!(s.contains("log='/Users/x/Library/Logs/zashiki/update.log'"));
        assert!(s.contains("|| log=/dev/null"), "unwritable log must not abort the helper");
        assert!(s.contains("exec >> \"$log\" 2>&1"));
    }

    #[test]
    fn update_script_reports_failure_and_keeps_a_window() {
        let s = update_script(
            Path::new("/tmp/u.sh"),
            Path::new("/tmp/update.log"),
            1,
            1,
            Path::new("/Applications/Zashiki.app"),
            Path::new("/Applications"),
            "v0.14.0",
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
            Path::new("/tmp/Za shiki/u.sh"),
            Path::new("/L/Za shiki/update.log"),
            1,
            1,
            Path::new("/Apps/Za shiki.app"),
            Path::new("/Apps"),
            "v0.14.0",
        );
        assert!(s.contains("log='/L/Za shiki/update.log'"));
        assert!(s.contains("/bin/bash '/tmp/Za shiki/u.sh'"));
        assert!(s.contains("open -n '/Apps/Za shiki.app'"));
    }
}
