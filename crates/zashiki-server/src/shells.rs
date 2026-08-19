//! Background-shell detection adapter (issue #69). Runs lsof over the Bash-wrapper pids to read each
//! live wrapper's fd1 (`tasks/<ID>.output`), then reconciles against each sid's transcript
//! `backgroundTaskId`s so only resident bg shells (not foreground) are counted. Every I/O failure
//! collapses to "0 shells" so the poll is never broken. The pure reconciliation lives in
//! `zashiki_core::shells`; this module is only the I/O orchestration (port of TS `infra/shells.ts`).

use std::collections::{HashMap, HashSet};

use tokio::process::Command;
use zashiki_core::shells::{count_running_shells_by_sid, parse_lsof_fd_outputs};

use crate::claude_projects::ClaudeProjectsAdapter;
use crate::jsonl::background_task_ids;

/// Raw `lsof -p <pids> -a -d 1 -F pfn` output (empty on failure). We keep stdout regardless of exit
/// status: lsof exits non-zero when any queried pid lacks the fd (e.g. it vanished between ps and
/// lsof), yet still prints valid entries for the others, so filtering on success would under-count.
async fn lsof_fd1(pids: &[i64]) -> String {
    if pids.is_empty() {
        return String::new();
    }
    let pid_arg = pids
        .iter()
        .map(i64::to_string)
        .collect::<Vec<_>>()
        .join(",");
    Command::new("lsof")
        .args(["-p", &pid_arg, "-a", "-d", "1", "-F", "pfn"])
        .output()
        .await
        .ok()
        .map(|out| String::from_utf8_lossy(&out.stdout).into_owned())
        .unwrap_or_default()
}

/// Counts resident background shells per sid. `cwd_by_sid` locates each candidate sid's transcript.
/// A sid with zero resident shells gets no key (so the served `shells_running` is absent, = 0).
pub async fn count_bg_shells(
    projects: &ClaudeProjectsAdapter,
    wrapper_pids: &[i64],
    cwd_by_sid: &HashMap<String, String>,
) -> HashMap<String, u32> {
    let outputs = parse_lsof_fd_outputs(&lsof_fd1(wrapper_pids).await);
    if outputs.is_empty() {
        return HashMap::new();
    }
    let sids: HashSet<&str> = outputs.iter().map(|o| o.sid.as_str()).collect();
    let mut bg_task_ids_by_sid: HashMap<String, HashSet<String>> = HashMap::new();
    for sid in sids {
        let Some(cwd) = cwd_by_sid.get(sid) else {
            continue;
        };
        if let Some(content) = projects.read_transcript(cwd, sid).await {
            bg_task_ids_by_sid.insert(sid.to_string(), background_task_ids(&content));
        }
    }
    count_running_shells_by_sid(&outputs, &bg_task_ids_by_sid)
}
