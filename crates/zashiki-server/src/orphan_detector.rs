//! Detection of orphan/zombie processes and NOTIFICATION notifications.
//! We don't surface raw CPU/memory values; we only push abnormal processes by name into the existing NOTIFICATION list.
//!
//! Monitoring is limited to "genuine Claude Code sessions whose args contain claude" (confirmed to have a
//! session-id via `sid_from_args`). This avoids pulling in node/Electron utility processes (unrelated
//! processes whose args merely contain "node") or launchd-managed daemons. A healthy claude session has a
//! parent shell/PTY, so its `ppid` is not 1; `ppid == 1` (reparented to init after the parent dies) is a
//! reliable signal of an orphan only for this candidate set (confirmed on real macOS hardware).
//!
//! The decisions are concentrated in pure functions (`parse_ps_orphan` / `parse_etime` / `detect_abnormal`), with tests as the canonical source.
//! The resident task samples ps at a low frequency (`ORPHAN_POLL`), deduplicates findings by pid, and notifies exactly once.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use zashiki_core::process_tree::sid_from_args;

use crate::control::ControlHub;
use crate::ps::PsAdapter;

/// Detection interval. A low-frequency check, on the premise that an orphan lingering for a week causes little real harm.
pub const ORPHAN_POLL: Duration = Duration::from_secs(3600);
/// Minimum elapsed time (7 days) required to report an orphan. Rejects short-lived, transient reparenting. etime is the
/// process's lifetime, used as an approximation of "how long it has been orphaned" (a stateless approach that avoids storing the first-detection time on the server).
pub const ORPHAN_MIN_AGE_SECS: u64 = 7 * 24 * 60 * 60;

/// A single ps line (`pid ppid stat etime args`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proc {
    pub pid: i64,
    pub ppid: i64,
    pub stat: String,
    pub elapsed_secs: u64,
    pub args: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AbnormalKind {
    Orphan,
    Zombie,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    pub pid: i64,
    pub kind: AbnormalKind,
    pub args: String,
}

impl Finding {
    /// Deduplication key for NOTIFICATION. Guarantees "notify exactly once" per pid.
    pub fn notification_id(&self) -> String {
        let prefix = match self.kind {
            AbnormalKind::Orphan => "orphan",
            AbnormalKind::Zombie => "zombie",
        };
        format!("{prefix}:{}", self.pid)
    }

    pub fn title(&self) -> String {
        let label = match self.kind {
            AbnormalKind::Orphan => "👻 孤児プロセス",
            AbnormalKind::Zombie => "🧟 ゾンビプロセス",
        };
        let excerpt = short(&self.args, 60);
        if excerpt.is_empty() {
            format!("{label} pid {}", self.pid)
        } else {
            format!("{label} pid {} {excerpt}", self.pid)
        }
    }

    pub fn body(&self) -> Option<String> {
        let full = short(&self.args, 200);
        (!full.is_empty()).then_some(full)
    }
}

fn short(args: &str, max: usize) -> String {
    let trimmed = args.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    let head: String = trimmed.chars().take(max).collect();
    format!("{head}…")
}

/// Whether this is a Claude Code process (args contain claude). The primary filter that rejects node/Electron/daemons.
fn is_claude(args: &str) -> bool {
    args.to_lowercase().contains("claude")
}

fn is_zombie(stat: &str) -> bool {
    stat.contains('Z')
}

/// Convert the elapsed time from `ps -o etime=` (`[[dd-]hh:]mm:ss`) into seconds. Malformed input returns None.
pub fn parse_etime(s: &str) -> Option<u64> {
    let (days, rest) = match s.split_once('-') {
        Some((d, r)) => (d.parse::<u64>().ok()?, r),
        None => (0, s),
    };
    let parts: Vec<&str> = rest.split(':').collect();
    let (hours, mins, secs) = match parts.as_slice() {
        [m, s] => (0, m.parse::<u64>().ok()?, s.parse::<u64>().ok()?),
        [h, m, s] => (h.parse::<u64>().ok()?, m.parse::<u64>().ok()?, s.parse::<u64>().ok()?),
        _ => return None,
    };
    Some(((days * 24 + hours) * 60 + mins) * 60 + secs)
}

fn next_field(s: &str) -> Option<(&str, &str)> {
    let s = s.trim_start();
    if s.is_empty() {
        return None;
    }
    match s.find(char::is_whitespace) {
        Some(i) => Some((&s[..i], &s[i..])),
        None => Some((s, "")),
    }
}

/// Parse the output of `ps -Aww -o pid=,ppid=,stat=,etime=,args=` (skipping malformed lines).
pub fn parse_ps_orphan(output: &str) -> Vec<Proc> {
    let mut out = Vec::new();
    for line in output.split('\n') {
        let Some((pid_s, r)) = next_field(line) else {
            continue;
        };
        let Ok(pid) = pid_s.parse::<i64>() else {
            continue;
        };
        let Some((ppid_s, r)) = next_field(r) else {
            continue;
        };
        let Ok(ppid) = ppid_s.parse::<i64>() else {
            continue;
        };
        let Some((stat, r)) = next_field(r) else {
            continue;
        };
        let Some((etime, r)) = next_field(r) else {
            continue;
        };
        out.push(Proc {
            pid,
            ppid,
            stat: stat.to_string(),
            elapsed_secs: parse_etime(etime).unwrap_or(0),
            args: r.trim_start().to_string(),
        });
    }
    out
}

/// Detect abnormal processes among the Claude Code processes.
/// - Zombie = 'Z' in stat (we don't require a session-id, so we can still catch defunct processes with thinned args. The Z in stat is
///   a reliable status code, and the claude primary filter keeps unrelated system zombies out).
/// - Orphan = a genuine session with a session-id that has `ppid == 1` (reparented to init after the parent dies) and is
///   sufficiently long-lived (at least `min_age_secs`).
pub fn detect_abnormal(procs: &[Proc], min_age_secs: u64) -> Vec<Finding> {
    let mut out: Vec<Finding> = procs
        .iter()
        .filter(|p| is_claude(&p.args))
        .filter_map(|p| {
            let kind = if is_zombie(&p.stat) {
                AbnormalKind::Zombie
            } else if p.ppid == 1
                && p.elapsed_secs >= min_age_secs
                && sid_from_args(&p.args).is_some()
            {
                AbnormalKind::Orphan
            } else {
                return None;
            };
            Some(Finding {
                pid: p.pid,
                kind,
                args: p.args.clone(),
            })
        })
        .collect();
    out.sort_by_key(|f| f.pid);
    out
}

/// A resident task that samples ps at a low frequency and pushes only newly-found orphans/zombies into NOTIFICATION exactly once.
/// The first tick fires after `ORPHAN_POLL` has elapsed (it does not run immediately at startup).
pub fn spawn_orphan_zombie_detector(hub: Arc<ControlHub>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval_at(
            tokio::time::Instant::now() + ORPHAN_POLL,
            ORPHAN_POLL,
        );
        let mut seen: HashSet<String> = HashSet::new();
        loop {
            interval.tick().await;
            let snapshot = PsAdapter.snapshot_extended().await;
            let findings = detect_abnormal(&parse_ps_orphan(&snapshot), ORPHAN_MIN_AGE_SECS);
            for f in &findings {
                let id = f.notification_id();
                if !seen.contains(&id) {
                    hub.record_warning(id, f.title(), f.body(), crate::now_ms());
                }
            }
            // Drop vanished pids from seen (so a reused pid can be notified again).
            seen = findings.iter().map(Finding::notification_id).collect();
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: u64 = 24 * 60 * 60;
    const WEEK: u64 = 7 * DAY;
    const SID: &str = "2335a03f-ee6f-4a6b-b050-cf7fa989753f";

    fn proc(pid: i64, ppid: i64, stat: &str, elapsed_secs: u64, args: &str) -> Proc {
        Proc {
            pid,
            ppid,
            stat: stat.to_string(),
            elapsed_secs,
            args: args.to_string(),
        }
    }

    #[test]
    fn parse_etime_mm_ss() {
        assert_eq!(parse_etime("05:23"), Some(5 * 60 + 23));
    }

    #[test]
    fn parse_etime_hh_mm_ss() {
        assert_eq!(parse_etime("01:02:03"), Some(3600 + 120 + 3));
    }

    #[test]
    fn parse_etime_dd_hh_mm_ss() {
        assert_eq!(parse_etime("14-19:25:01"), Some((14 * 24 + 19) * 3600 + 25 * 60 + 1));
    }

    #[test]
    fn parse_etime_rejects_garbage() {
        assert_eq!(parse_etime(""), None);
        assert_eq!(parse_etime("abc"), None);
        assert_eq!(parse_etime("1:2:3:4"), None);
    }

    #[test]
    fn parse_ps_reads_five_fields_preserving_arg_spaces() {
        let out = format!("  300     1 S    7-00:00:00 claude --resume {SID} --continue\n");
        assert_eq!(
            parse_ps_orphan(&out),
            vec![proc(300, 1, "S", WEEK, &format!("claude --resume {SID} --continue"))]
        );
    }

    #[test]
    fn parse_ps_skips_garbage_lines() {
        assert_eq!(parse_ps_orphan("\ngarbage\n  1\n"), Vec::<Proc>::new());
    }

    #[test]
    fn detects_claude_session_reparented_to_init() {
        let procs = vec![proc(300, 1, "S", WEEK, &format!("claude --session-id {SID}"))];
        let f = detect_abnormal(&procs, WEEK);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].kind, AbnormalKind::Orphan);
        assert_eq!(f[0].pid, 300);
    }

    #[test]
    fn detects_orphaned_launcher_shell_holding_the_session() {
        // When zashiki-server dies in owned mode, the zsh -lc wrapper that launched claude is left directly under init.
        let args = format!(r#"/bin/zsh -lc claude --session-id {SID}; exec "${{SHELL:-/bin/sh}}""#);
        let f = detect_abnormal(&[proc(29394, 1, "S", WEEK, &args)], WEEK);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].kind, AbnormalKind::Orphan);
    }

    #[test]
    fn ignores_orphan_younger_than_threshold() {
        let procs = vec![proc(300, 1, "S", WEEK - 1, &format!("claude --session-id {SID}"))];
        assert!(detect_abnormal(&procs, WEEK).is_empty());
    }

    #[test]
    fn ignores_claude_with_live_parent() {
        let procs = vec![proc(300, 200, "S", WEEK, &format!("claude --session-id {SID}"))];
        assert!(detect_abnormal(&procs, WEEK).is_empty());
    }

    #[test]
    fn ignores_claude_without_session_id_even_if_reparented() {
        // No session-id = not a genuine session (e.g. a bare `claude`). Not treated as an orphan.
        let procs = vec![proc(300, 1, "S", WEEK, "claude doctor")];
        assert!(detect_abnormal(&procs, WEEK).is_empty());
    }

    #[test]
    fn detects_zombie_claude_even_with_live_parent() {
        let procs = vec![proc(300, 200, "Z", DAY, "(claude)")];
        let f = detect_abnormal(&procs, WEEK);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].kind, AbnormalKind::Zombie);
    }

    // --- Regressions for cases where false positives were demonstrated on real hardware (CRITICAL-1 / CRITICAL-2) ---

    #[test]
    fn ignores_launchd_node_daemon_reparented_to_init() {
        // A healthy long-running node process with ppid==1 alive for over 14 days (measured on real hardware). Out of scope because it doesn't contain claude.
        let procs = vec![proc(
            46680,
            1,
            "S",
            14 * DAY,
            "node -e const {createServer}=require('http'); token-probe",
        )];
        assert!(detect_abnormal(&procs, WEEK).is_empty());
    }

    #[test]
    fn ignores_electron_node_utility_helpers() {
        let procs = vec![
            proc(600, 500, "S", WEEK, "Notion Helper --type=utility --utility-sub-type=node.mojom.NodeService"),
            proc(601, 500, "S", WEEK, "Code Helper --type=utility --utility-sub-type=node.mojom.NodeService"),
            proc(602, 1, "S", WEEK, "Figma Helper --utility-sub-type=node.mojom.NodeService"),
        ];
        assert!(detect_abnormal(&procs, WEEK).is_empty());
    }

    #[test]
    fn ignores_non_claude_processes() {
        let procs = vec![proc(300, 1, "S", WEEK, "vim notes.txt")];
        assert!(detect_abnormal(&procs, WEEK).is_empty());
    }

    #[test]
    fn results_are_sorted_by_pid() {
        let procs = vec![
            proc(500, 1, "S", WEEK, &format!("claude --session-id {SID}")),
            proc(100, 200, "Z", DAY, "(claude)"),
        ];
        let f = detect_abnormal(&procs, WEEK);
        assert_eq!(f.iter().map(|x| x.pid).collect::<Vec<_>>(), vec![100, 500]);
    }

    #[test]
    fn notification_id_is_kind_and_pid() {
        let orphan = Finding { pid: 42, kind: AbnormalKind::Orphan, args: "claude".to_string() };
        let zombie = Finding { pid: 42, kind: AbnormalKind::Zombie, args: "claude".to_string() };
        assert_eq!(orphan.notification_id(), "orphan:42");
        assert_eq!(zombie.notification_id(), "zombie:42");
    }

    #[test]
    fn title_names_the_process() {
        let f = Finding {
            pid: 42,
            kind: AbnormalKind::Orphan,
            args: "claude --resume abc".to_string(),
        };
        assert_eq!(f.title(), "👻 孤児プロセス pid 42 claude --resume abc");
    }

    #[test]
    fn title_omits_excerpt_when_args_empty() {
        let f = Finding { pid: 42, kind: AbnormalKind::Zombie, args: String::new() };
        assert_eq!(f.title(), "🧟 ゾンビプロセス pid 42");
    }
}
