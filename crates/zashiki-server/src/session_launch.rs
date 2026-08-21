//! Launch plan for a new owned session (tmux removal / Path 2).
//!
//! The tmux version of `session.new` created a tmux `new-window` and typed `claude --session-id <sid>`
//! via send-keys. In owned mode without tmux, it is enough to **make the PTY command itself launch claude**
//! (symmetric with the resume in [`crate::session_restore`]). Here we build a pure-data launch plan and
//! map it onto [`crate::pty_host::PtyConfig`] and [`crate::session_registry::SessionMeta`]. The source of
//! truth for behavior is the `tests` at the end.

use portable_pty::CommandBuilder;

use crate::pty_host::PtyConfig;
use crate::session_registry::SessionMeta;

/// Launch plan for a new owned session (pure data; makes it easy to test before building the CommandBuilder).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewSessionPlan {
    pub sid: String,
    pub wname: String,
    pub cwd: String,
    pub program: String,
    pub args: Vec<String>,
}

/// Builds a launch plan for a new session from a resolved cwd and claude path (pure function). If
/// `launch_claude` is true, it launches `<claude> --session-id <sid>` and **falls back to the login
/// shell after it exits** (symmetric with the tmux version keeping the shell around; a gap-filler before
/// cutover). If false, it launches the login shell directly.
/// The caller passes the cwd and claude path already resolved via [`resolve_cwd`] / [`resolve_claude_program`].
pub fn plan_new_session(
    sid: &str,
    cwd: &str,
    name: &str,
    launch_claude: bool,
    resume_sid: Option<&str>,
    shell: &str,
    claude_program: &str,
) -> NewSessionPlan {
    let args = if launch_claude {
        let payload = match resume_sid {
            Some(source) => claude_fork_payload(claude_program, source, sid),
            None => {
                claude_launch_payload(claude_program, &format!("--session-id {}", sid.to_lowercase()))
            }
        };
        vec!["-lc".to_string(), payload]
    } else {
        vec!["-l".to_string()]
    };
    NewSessionPlan {
        sid: sid.to_lowercase(),
        wname: name.to_string(),
        cwd: cwd.to_string(),
        program: shell.to_string(),
        args,
    }
}

/// Appended to every claude launch payload so the login shell takes over after claude exits (no `exec`
/// replacement of claude itself), keeping the pane alive (symmetric with the tmux version keeping the shell around).
const SHELL_TAKEOVER_TAIL: &str = r#"exec "${SHELL:-/bin/sh}""#;

/// The claude launch payload passed to `sh -lc` (pure function; used for a new session). So that the shell
/// survives after claude exits, it does not replace via `exec` but falls back to the shell at the end.
/// Pass a resolved absolute path as `claude_program` so it launches even with a thin PATH.
pub(crate) fn claude_launch_payload(claude_program: &str, claude_args: &str) -> String {
    format!(r#"{claude_program} {claude_args}; {SHELL_TAKEOVER_TAIL}"#)
}

/// The resume payload passed to `sh -lc` (pure function). Tries `--resume <sid>`, and if that exits non-zero
/// (e.g. the conversation no longer exists, which makes resume fail to start), falls back to a fresh session
/// with the **same sid** so the pane keeps its identity instead of dropping to a bare shell. `sid` must already
/// be validated as a UUID by the caller. Pass a resolved absolute path as `claude_program` for a thin PATH.
pub(crate) fn claude_resume_payload(claude_program: &str, sid: &str) -> String {
    let sid = sid.to_lowercase();
    format!(
        r#"{claude_program} --resume {sid} || {claude_program} --session-id {sid}; {SHELL_TAKEOVER_TAIL}"#
    )
}

/// The fork payload passed to `sh -lc` (pure function; used when duplicating a session). Forks `source_sid`
/// into `own_sid` (`--fork-session` under a pinned `--session-id`), falling back to a fresh session under
/// `own_sid` on resume failure. Both sids must already be validated as UUIDs by the caller.
pub(crate) fn claude_fork_payload(claude_program: &str, source_sid: &str, own_sid: &str) -> String {
    let source = source_sid.to_lowercase();
    let own = own_sid.to_lowercase();
    format!(
        r#"{claude_program} --resume {source} --fork-session --session-id {own} || {claude_program} --session-id {own}; {SHELL_TAKEOVER_TAIL}"#
    )
}

/// A working directory that falls back to `$HOME` (or /tmp if unset) when cwd is not an existing directory.
/// If we spawn with a non-existent cwd, the child dies immediately (on macOS the spawn itself succeeds) and
/// the work is silently lost, so we resolve it before spawning.
pub fn resolve_cwd(cwd: &str) -> String {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    resolve_cwd_with(cwd, &home)
}

/// The pure-function core of [`resolve_cwd`] (inject `home` for testing).
pub(crate) fn resolve_cwd_with(cwd: &str, home: &str) -> String {
    if !cwd.is_empty() && std::path::Path::new(cwd).is_dir() {
        cwd.to_string()
    } else {
        home.to_string()
    }
}

/// PATH plus the typical install locations a thin GUI/launchd PATH tends to omit
/// (`/opt/homebrew/bin`, `~/.local/bin`, …), searched in that order.
fn program_search_dirs() -> Vec<String> {
    let mut dirs: Vec<String> = std::env::var("PATH")
        .unwrap_or_default()
        .split(':')
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect();
    if let Ok(home) = std::env::var("HOME") {
        for d in [
            format!("{home}/.claude/local"),
            format!("{home}/.local/bin"),
            "/opt/homebrew/bin".to_string(),
            "/usr/local/bin".to_string(),
        ] {
            dirs.push(d);
        }
    }
    dirs
}

/// Resolves the absolute path of `name` from PATH and typical install locations, so it launches even when
/// PATH is thin under GUI/launchd startup. If not found, falls back to `name` itself as before.
pub fn resolve_program(name: &str) -> String {
    find_program_in(&program_search_dirs(), name).unwrap_or_else(|| name.to_string())
}

pub fn resolve_claude_program() -> String {
    resolve_program("claude")
}

/// Looks for an executable `name` in `dirs` and returns the first absolute path (pure function).
pub(crate) fn find_program_in(dirs: &[String], name: &str) -> Option<String> {
    dirs.iter()
        .map(|dir| std::path::Path::new(dir).join(name))
        .find(|candidate| is_executable_file(candidate))
        .map(|p| p.to_string_lossy().into_owned())
}

#[cfg(unix)]
fn is_executable_file(path: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable_file(path: &std::path::Path) -> bool {
    path.is_file()
}

/// Builds a [`PtyConfig`] from the launch plan (same shape as [`crate::session_restore::plan_to_config`]).
pub fn plan_to_config(plan: &NewSessionPlan) -> PtyConfig {
    let mut cmd = CommandBuilder::new(&plan.program);
    for arg in &plan.args {
        cmd.arg(arg);
    }
    cmd.cwd(&plan.cwd);
    cmd.env("TERM", "xterm-256color");
    PtyConfig::new(cmd)
}

/// Builds a [`SessionMeta`] for registry registration from the launch plan (cwd recovers the org, wname the display name).
pub fn plan_to_meta(plan: &NewSessionPlan) -> SessionMeta {
    SessionMeta {
        cwd: plan.cwd.clone(),
        wname: plan.wname.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SID: &str = "1B4E28BA-2FA1-11D2-883F-0016D3CCA427";

    #[test]
    fn launch_claude_starts_claude_then_keeps_shell() {
        let plan = plan_new_session(SID, "/repos/charlie", "charlie", true, None, "/bin/zsh", "/abs/claude");
        assert_eq!(plan.program, "/bin/zsh");
        // Launch claude with a resolved absolute path and fall back to the shell after it exits (no exec replacement).
        assert_eq!(
            plan.args,
            vec![
                "-lc".to_string(),
                format!(
                    r#"/abs/claude --session-id {}; exec "${{SHELL:-/bin/sh}}""#,
                    SID.to_lowercase()
                ),
            ]
        );
        assert_eq!(plan.cwd, "/repos/charlie");
        assert_eq!(plan.wname, "charlie");
        // The sid is kept lowercased (to prevent arbitrary strings from creeping in and to unify notation).
        assert_eq!(plan.sid, SID.to_lowercase());
    }

    #[test]
    fn resume_payload_falls_back_to_fresh_session_with_same_sid() {
        assert_eq!(
            claude_resume_payload("/abs/claude", SID),
            format!(
                r#"/abs/claude --resume {sid} || /abs/claude --session-id {sid}; exec "${{SHELL:-/bin/sh}}""#,
                sid = SID.to_lowercase()
            ),
        );
    }

    const OWN_SID: &str = "2C5F39CB-3EB2-42E3-994E-1127E4DDB538";

    #[test]
    fn fork_payload_forks_source_and_falls_back_to_own_sid() {
        assert_eq!(
            claude_fork_payload("/abs/claude", SID, OWN_SID),
            format!(
                r#"/abs/claude --resume {source} --fork-session --session-id {own} || /abs/claude --session-id {own}; exec "${{SHELL:-/bin/sh}}""#,
                source = SID.to_lowercase(),
                own = OWN_SID.to_lowercase(),
            ),
        );
    }

    #[test]
    fn plan_with_resume_sid_forks_into_a_new_terminal() {
        let plan = plan_new_session(
            OWN_SID,
            "/repos/charlie",
            "charlie",
            true,
            Some(SID),
            "/bin/zsh",
            "/abs/claude",
        );
        assert_eq!(
            plan.args,
            vec![
                "-lc".to_string(),
                claude_fork_payload("/abs/claude", SID, OWN_SID),
            ]
        );
        assert_eq!(plan.sid, OWN_SID.to_lowercase());
    }

    #[test]
    fn without_launch_claude_runs_login_shell_only() {
        let plan = plan_new_session(SID, "/repos/x", "x", false, None, "/bin/sh", "/abs/claude");
        assert_eq!(plan.args, vec!["-l".to_string()]);
    }

    #[test]
    fn meta_carries_cwd_and_wname() {
        let plan = plan_new_session(SID, "/repos/charlie", "charlie", true, None, "/bin/sh", "claude");
        assert_eq!(
            plan_to_meta(&plan),
            SessionMeta {
                cwd: "/repos/charlie".to_string(),
                wname: "charlie".to_string(),
            }
        );
    }

    #[test]
    fn payload_keeps_shell_after_claude_exits() {
        // No exec replacement; it falls back to $SHELL at the end (the session survives after claude exits).
        let p = claude_launch_payload("claude", "--resume abc");
        assert_eq!(p, r#"claude --resume abc; exec "${SHELL:-/bin/sh}""#);
        assert!(!p.starts_with("exec claude"));
    }

    #[test]
    fn resolve_cwd_falls_back_to_home_when_missing() {
        // An existing directory is kept as-is; if it does not exist, fall back to home.
        assert_eq!(resolve_cwd_with("/", "/home/x"), "/");
        assert_eq!(
            resolve_cwd_with("/definitely/missing/zzz", "/home/x"),
            "/home/x"
        );
        assert_eq!(resolve_cwd_with("", "/home/x"), "/home/x");
    }

    /// Verify on a real PTY that keeping the shell around actually works: swap the claude stand-in for
    /// `true`, which exits immediately, and check that the shell still responds to input afterward (the PTY survives).
    #[cfg(unix)]
    #[tokio::test]
    async fn keep_shell_survives_claude_exit_on_real_pty() {
        use crate::pty_host::PtySession;
        use std::time::Duration;

        // With claude_program set to `true` (exits 0 immediately), the payload is `true --session-id ...; exec $SHELL`.
        let plan = plan_new_session(SID, "/", "x", true, None, "/bin/sh", "true");
        let session = PtySession::spawn(plan_to_config(&plan)).unwrap();
        // Wait until `true` exits and it falls back to `exec $SHELL`.
        tokio::time::sleep(Duration::from_millis(400)).await;
        // Writing to the surviving shell makes the echo appear on screen (= the session is alive).
        session.write_input(b"echo SHELL-ALIVE\n").unwrap();
        let alive = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if session.screen_contents().contains("SHELL-ALIVE") {
                    return true;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .unwrap_or(false);
        assert!(alive, "shell should survive after claude(true) exits");
    }

    #[test]
    fn find_program_in_returns_first_executable() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("claude");
        std::fs::write(&bin, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let dirs = vec![
            "/definitely/missing/zzz".to_string(),
            dir.path().to_string_lossy().into_owned(),
        ];
        assert_eq!(find_program_in(&dirs, "claude"), Some(bin.to_string_lossy().into_owned()));
        assert_eq!(find_program_in(&dirs, "nope-xyz"), None);
    }
}
