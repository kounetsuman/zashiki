//! Persistence of the session list and resume at daemon startup (tmux removal / Decision 1).
//!
//! Decision 1: do not keep live processes. Persist the session list to disk and, at daemon startup,
//! relaunch from it via `claude --resume <sid>` (no re-run needed). The tmux version **typed**
//! `claude --resume` into each window on restore, but without tmux it is enough to **make the PTY command
//! itself `claude --resume <sid>`**. The save format (`saves/last.tsv` = `widx\twname\tcwd\tsid` TSV) reuses
//! [`zashiki_core::save_file`]. Not yet wired into the runtime (daemon startup flow) (non-destructive). The
//! source of truth is the `tests` at the end.

use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use portable_pty::CommandBuilder;
use zashiki_core::save_file::{is_uuid_sid, parse_save_file, serialize_save_file, SaveEntry};

use crate::pty_host::PtyConfig;

/// A launch plan for resuming one entry (pure data; makes it easy to test before building the CommandBuilder).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResumePlan {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
}

/// Builds a resume launch plan from a save entry (pure function). Returns `None` if the sid is not a UUID
/// (claude is not launched). It launches `<claude> --resume <sid>` via the shell and **falls back to the shell
/// after it exits** (the same [`crate::session_launch::claude_launch_payload`] as new). Pass a resolved absolute
/// path as `claude_program` to guard against a thin PATH. UUID validation of the sid also defends against mixing
/// arbitrary strings into a shell command ([`is_uuid_sid`]). cwd resolution is done by the caller (the rebuild in [`crate::session_persist`]).
pub fn plan_resume(entry: &SaveEntry, shell: &str, claude_program: &str) -> Option<ResumePlan> {
    if !is_uuid_sid(&entry.sid) {
        return None;
    }
    Some(ResumePlan {
        program: shell.to_string(),
        args: vec![
            "-lc".to_string(),
            crate::session_launch::claude_launch_payload(
                claude_program,
                &format!("--resume {}", entry.sid.to_lowercase()),
            ),
        ],
        cwd: entry.cwd.clone(),
    })
}

/// Builds a [`PtyConfig`] from the launch plan.
pub fn plan_to_config(plan: &ResumePlan) -> PtyConfig {
    let mut cmd = CommandBuilder::new(&plan.program);
    for arg in &plan.args {
        cmd.arg(arg);
    }
    cmd.cwd(&plan.cwd);
    cmd.env("TERM", "xterm-256color");
    PtyConfig::new(cmd)
}

/// The login shell (`$SHELL`, or `/bin/sh` if unset).
pub fn login_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
}

/// Reads and parses the save file (returns empty if it does not exist).
pub fn read_save_file(path: &Path) -> io::Result<Vec<SaveEntry>> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(parse_save_file(&text)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e),
    }
}

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Writes the save file atomically (writes to a unique temp in the same directory, then atomically replaces via rename).
///
/// The temp name is made unique with pid + an in-process counter to avoid temp collisions under concurrent writes.
/// On write failure it does not corrupt the existing file (rename is not reached) and cleans up the temp. It does not
/// fsync, so power-loss durability is not guaranteed (this data is a hint; losing it only reduces the resume count, and live processes are not kept in the first place).
pub fn write_save_file(path: &Path, entries: &[SaveEntry]) -> io::Result<()> {
    let text = serialize_save_file(entries);
    let mut tmp: OsString = path.as_os_str().to_owned();
    let n = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    tmp.push(format!(".{}.{}.tmp", std::process::id(), n));
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, text)?;
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(wname: &str, cwd: &str, sid: &str) -> SaveEntry {
        SaveEntry {
            widx: "0".to_string(),
            wname: wname.to_string(),
            cwd: cwd.to_string(),
            sid: sid.to_string(),
        }
    }

    const UUID_A: &str = "579fa8cf-4901-45cb-b9ec-17e229231a37";
    const UUID_B: &str = "11111111-2222-3333-4444-555555555555";

    #[test]
    fn plan_resume_builds_claude_resume_for_uuid_sid() {
        let plan = plan_resume(&entry("w1", "/tmp/x", &UUID_A.to_uppercase()), "/bin/zsh", "/abs/claude")
            .expect("uuid sid should plan a resume");
        assert_eq!(plan.program, "/bin/zsh");
        // Resume with a resolved absolute path and fall back to the shell after it exits (payload shared with new).
        assert_eq!(
            plan.args,
            vec![
                "-lc".to_string(),
                format!(r#"/abs/claude --resume {UUID_A}; exec "${{SHELL:-/bin/sh}}""#),
            ]
        );
        assert_eq!(plan.cwd, "/tmp/x");
    }

    #[test]
    fn plan_resume_skips_non_uuid_sid() {
        assert!(plan_resume(&entry("w1", "/tmp/x", "workspace"), "/bin/sh", "claude").is_none());
        assert!(plan_resume(&entry("w1", "/tmp/x", ""), "/bin/sh", "claude").is_none());
    }

    /// Injection-defense regression: a sid containing shell metacharacters fails the UUID shape and yields `None` (it never reaches the command string).
    #[test]
    fn plan_resume_rejects_shell_metachar_sids() {
        for evil in [
            "579fa8cf-4901-45cb-b9ec-17e229231a37; rm -rf /",
            "579fa8cf 4901 45cb b9ec 17e229231a37",
            "$(whoami)-4901-45cb-b9ec-17e229231a37",
            "579fa8cf-4901-45cb-b9ec-17e2`id`231a37",
            "../../etc/passwd",
        ] {
            assert!(
                plan_resume(&entry("w", "/tmp", evil), "/bin/sh", "claude").is_none(),
                "metachar sid must not plan a resume: {evil:?}"
            );
        }
    }

    #[test]
    fn save_file_round_trips_through_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("last.tsv");
        let entries = vec![
            entry("w1", "/home/a", UUID_A),
            entry("w2", "/home/b", UUID_B),
        ];
        write_save_file(&path, &entries).unwrap();
        assert_eq!(read_save_file(&path).unwrap(), entries);
    }

    #[test]
    fn read_missing_save_file_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope.tsv");
        assert!(read_save_file(&missing).unwrap().is_empty());
    }
}
