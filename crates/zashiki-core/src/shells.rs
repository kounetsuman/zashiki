//! Pure functions for detecting resident background shells.
//! Side effects (running lsof, reading transcripts) are the responsibility of server/infra.
//! Here we only reconcile lsof output strings against the set of backgroundTaskIds.
//!
//! Corresponds 1:1 with the TS `packages/shared/src/shells.ts` (ported together with its tests).
//!
//! Detection essentials: Claude Code's Bash wrapper (fg or bg) points fd1 at
//! `<sid>/tasks/<ID>.output`. fg vs bg cannot be distinguished via ps/lsof; the only separator is
//! whether `<ID>` appears in the transcript's `toolUseResult.backgroundTaskId` (absent for fg).
//! Liveness is simply "a live wrapper holding that fd being visible in lsof".

use std::collections::{HashMap, HashSet};

/// sid and bg task id extracted from the output file the live wrapper's fd1 points to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellOutput {
    pub sid: String,
    pub task_id: String,
}

/// Identifies Claude Code's Bash execution wrapper (fg or bg) from its args. It has a distinctive
/// shape that sources the shell-snapshot while running the actual command via eval. Requiring both
/// snapshot and eval narrows out false positives from ordinary zsh/vim etc.
pub fn is_bash_wrapper_args(args: &str) -> bool {
    args.starts_with("/bin/zsh -c")
        && args.contains("shell-snapshots/snapshot-")
        && contains_word_eval(args)
}

/// TS `\beval\b`: `eval` bounded by non-word characters on both sides (word = [A-Za-z0-9_]).
fn contains_word_eval(s: &str) -> bool {
    let bytes = s.as_bytes();
    let is_word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    let mut from = 0;
    while let Some(rel) = s[from..].find("eval") {
        let start = from + rel;
        let end = start + 4;
        let before_ok = start == 0 || !is_word(bytes[start - 1]);
        let after_ok = end >= bytes.len() || !is_word(bytes[end]);
        if before_ok && after_ok {
            return true;
        }
        from = start + 1;
    }
    false
}

/// Whether the 36 bytes have lowercase-uuid shape (`8-4-4-4-12`), matching the TS path regex's
/// `[0-9a-f]` (lowercase only; sids on disk are lowercased).
fn is_lower_uuid(b: &[u8]) -> bool {
    if b.len() != 36 {
        return false;
    }
    for (i, &c) in b.iter().enumerate() {
        match i {
            8 | 13 | 18 | 23 => {
                if c != b'-' {
                    return false;
                }
            }
            _ => {
                if !(c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) {
                    return false;
                }
            }
        }
    }
    true
}

/// Matches the tail `/<sid>/tasks/<ID>.output` (TS `OUTPUT_PATH_RE`). `<ID>` is `[A-Za-z0-9]+`.
fn parse_output_path(path: &str) -> Option<ShellOutput> {
    let rest = path.strip_suffix(".output")?;
    let tasks_idx = rest.rfind("/tasks/")?;
    let task_id = &rest[tasks_idx + "/tasks/".len()..];
    if task_id.is_empty() || !task_id.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return None;
    }
    let before = &rest[..tasks_idx];
    if before.len() < 37 {
        return None;
    }
    let sid_start = before.len() - 36;
    if before.as_bytes()[sid_start - 1] != b'/' || !is_lower_uuid(&before.as_bytes()[sid_start..]) {
        return None;
    }
    Some(ShellOutput {
        sid: before[sid_start..].to_string(),
        task_id: task_id.to_string(),
    })
}

/// From the machine-readable output of `lsof -F pfn -a -d 1`, extracts the `{sid, task_id}` of
/// entries whose fd1 points to `<sid>/tasks/<ID>.output`. Entries other than fd1, and non-output
/// files, are ignored.
pub fn parse_lsof_fd_outputs(lsof_output: &str) -> Vec<ShellOutput> {
    let mut outputs = Vec::new();
    let mut fd: Option<&str> = None;
    for line in lsof_output.split('\n') {
        let Some(tag) = line.chars().next() else {
            continue;
        };
        let rest = &line[tag.len_utf8()..];
        match tag {
            'p' => fd = None,
            'f' => fd = Some(rest),
            'n' if fd == Some("1") => {
                if let Some(out) = parse_output_path(rest) {
                    outputs.push(out);
                }
            }
            _ => {}
        }
    }
    outputs
}

/// Reconciles the live wrappers' `{sid, task_id}` entries against the per-sid set of
/// backgroundTaskIds, counting per sid the shells confirmed as resident bg (fg = ids not in the set
/// are excluded). A sid with a count of 0 gets no key at all (so it resolves to "absent" when served).
pub fn count_running_shells_by_sid(
    outputs: &[ShellOutput],
    bg_task_ids_by_sid: &HashMap<String, HashSet<String>>,
) -> HashMap<String, u32> {
    let mut counts = HashMap::new();
    for out in outputs {
        if bg_task_ids_by_sid
            .get(&out.sid)
            .is_some_and(|ids| ids.contains(&out.task_id))
        {
            *counts.entry(out.sid.clone()).or_insert(0) += 1;
        }
    }
    counts
}

#[cfg(test)]
mod tests {
    use super::*;

    const SID_A: &str = "0b6cbc45-83a9-4f2e-9c3d-1a2b3c4d5e6f";
    const SID_B: &str = "11111111-2222-3333-4444-555555555555";

    fn wrapper_args(cmd: &str) -> String {
        format!("/bin/zsh -c -c source /Users/x/.claude/shell-snapshots/snapshot-zsh-1.sh && eval {cmd}")
    }

    #[test]
    fn is_bash_wrapper_args_requires_snapshot_and_eval_and_zsh_prefix() {
        assert!(is_bash_wrapper_args(&wrapper_args("ls")));
        // missing snapshot
        assert!(!is_bash_wrapper_args("/bin/zsh -c eval ls"));
        // missing eval
        assert!(!is_bash_wrapper_args(
            "/bin/zsh -c source shell-snapshots/snapshot-zsh-1.sh && ls"
        ));
        // not the zsh wrapper prefix
        assert!(!is_bash_wrapper_args(
            "vim shell-snapshots/snapshot-zsh-1.sh eval"
        ));
        // `eval` as a substring of a larger word must not match (\beval\b)
        assert!(!is_bash_wrapper_args(
            "/bin/zsh -c source shell-snapshots/snapshot-zsh-1.sh && evaluate x"
        ));
    }

    fn lsof(entries: &[(&str, &str)]) -> String {
        // Each entry: (fd, name). Emit a `p` line per entry then f/n. lsof groups by process but the
        // parser only tracks the most recent f before an n, so per-entry p/f/n is a faithful shape.
        let mut s = String::new();
        for (i, (fd, name)) in entries.iter().enumerate() {
            s.push_str(&format!("p{}\nf{fd}\nn{name}\n", 1000 + i));
        }
        s
    }

    #[test]
    fn parse_lsof_picks_only_fd1_output_paths() {
        let out = lsof(&[
            ("1", &format!("/Users/x/.claude/projects/-p/{SID_A}/tasks/abc123.output")),
            // fd other than 1 ignored
            ("2", &format!("/Users/x/.claude/projects/-p/{SID_A}/tasks/zzz.output")),
            // non-output ignored
            ("1", &format!("/Users/x/.claude/projects/-p/{SID_A}/tasks/abc123.txt")),
            // different sid/task
            ("1", &format!("/Users/x/.claude/projects/-p/{SID_B}/tasks/DEF456.output")),
        ]);
        let parsed = parse_lsof_fd_outputs(&out);
        assert_eq!(
            parsed,
            vec![
                ShellOutput { sid: SID_A.into(), task_id: "abc123".into() },
                ShellOutput { sid: SID_B.into(), task_id: "DEF456".into() },
            ]
        );
    }

    #[test]
    fn parse_lsof_rejects_uppercase_uuid_and_bad_shapes() {
        let bad_uuid = "0B6CBC45-83A9-4F2E-9C3D-1A2B3C4D5E6F";
        let out = lsof(&[
            ("1", &format!("/x/{bad_uuid}/tasks/abc.output")),
            ("1", "/x/not-a-uuid/tasks/abc.output"),
            ("1", "/tasks/abc.output"),
        ]);
        assert!(parse_lsof_fd_outputs(&out).is_empty());
    }

    #[test]
    fn count_only_counts_ids_present_in_the_transcript_set() {
        let outputs = vec![
            ShellOutput { sid: SID_A.into(), task_id: "bg1".into() },
            ShellOutput { sid: SID_A.into(), task_id: "bg2".into() },
            ShellOutput { sid: SID_A.into(), task_id: "fg-only".into() },
            ShellOutput { sid: SID_B.into(), task_id: "bg1".into() },
        ];
        let mut by_sid: HashMap<String, HashSet<String>> = HashMap::new();
        by_sid.insert(SID_A.into(), HashSet::from(["bg1".into(), "bg2".into()]));
        // SID_B has no transcript entry -> its shell is excluded.
        let counts = count_running_shells_by_sid(&outputs, &by_sid);
        assert_eq!(counts.get(SID_A), Some(&2));
        assert_eq!(counts.get(SID_B), None);
    }

    #[test]
    fn count_with_no_matches_yields_no_keys() {
        let outputs = vec![ShellOutput { sid: SID_A.into(), task_id: "x".into() }];
        let counts = count_running_shells_by_sid(&outputs, &HashMap::new());
        assert!(counts.is_empty());
    }
}
