//! Resident background-shell detection.
//! Involves regex, so it lives in the server crate rather than core (which has zero dependencies).
//! Running lsof / reading transcripts is infra's responsibility; here we only reconcile lsof output
//! strings against the set of backgroundTaskIds. Detection contract lives in the tests below.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;

/// sid and bg task ID extracted from the output file that the live wrapper's fd1 points to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellOutput {
    pub sid: String,
    pub task_id: String,
}

static OUTPUT_PATH_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/tasks/([A-Za-z0-9]+)\.output$")
        .expect("static regex is valid")
});

/// From the machine-readable output of `lsof -F pfn -a -d 1`, extracts the `{sid, task_id}` of
/// entries whose fd1 points to `<sid>/tasks/<ID>.output`. Entries other than fd1, and non-output
/// files, are ignored.
pub fn parse_lsof_fd_outputs(lsof_output: &str) -> Vec<ShellOutput> {
    let mut outputs = Vec::new();
    let mut fd: Option<&str> = None;
    for line in lsof_output.split('\n') {
        let mut chars = line.chars();
        let Some(tag) = chars.next() else {
            continue;
        };
        let rest = chars.as_str();
        match tag {
            'p' => fd = None,
            'f' => fd = Some(rest),
            'n' => {
                if fd != Some("1") {
                    continue;
                }
                if let Some(caps) = OUTPUT_PATH_RE.captures(rest) {
                    outputs.push(ShellOutput {
                        sid: caps[1].to_string(),
                        task_id: caps[2].to_string(),
                    });
                }
            }
            _ => {}
        }
    }
    outputs
}

/// Counts, for one sid, the live tasks whose task_id is in that sid's backgroundTaskId set (fg =
/// task_ids absent from the set are excluded). Deduplicates by task_id: the wrapper and any
/// children inheriting its fd1 are one shell.
pub fn count_running_shells_for_sid(
    outputs: &[ShellOutput],
    sid: &str,
    bg_task_ids: &HashSet<String>,
) -> u32 {
    outputs
        .iter()
        .filter(|o| o.sid == sid && bg_task_ids.contains(&o.task_id))
        .map(|o| &o.task_id)
        .collect::<HashSet<_>>()
        .len() as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    const SID_A: &str = "a2814219-c53d-4def-b542-5e71aeddab2b";
    const SID_B: &str = "631587f4-bed5-4eec-8b43-8e162bf1e5c6";

    fn set(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parse_extracts_sid_and_task_id_from_fd1_output() {
        let lsof = format!(
            "p44413\nf1\nn/private/tmp/claude-501/-Users-kilo-workspace-whiskey/{SID_A}/tasks/bush20ok3.output\np73096\nf1\nn/private/tmp/claude-501/-Users-kilo-workspace-whiskey/{SID_B}/tasks/bh8hl40cs.output\n"
        );
        assert_eq!(
            parse_lsof_fd_outputs(&lsof),
            vec![
                ShellOutput { sid: SID_A.into(), task_id: "bush20ok3".into() },
                ShellOutput { sid: SID_B.into(), task_id: "bh8hl40cs".into() },
            ]
        );
    }

    #[test]
    fn parse_ignores_non_output_files() {
        let out = format!("p100\nf1\nn/dev/ttys003\np200\nf1\nn/private/tmp/claude-501/-Users-x/{SID_A}/tasks/abc12345x.output\n");
        assert_eq!(
            parse_lsof_fd_outputs(&out),
            vec![ShellOutput { sid: SID_A.into(), task_id: "abc12345x".into() }]
        );
    }

    #[test]
    fn parse_excludes_fds_other_than_fd1() {
        let out = format!(
            "p300\nf2\nn/private/tmp/claude-501/-Users-x/{SID_A}/tasks/zzz99999z.output\n"
        );
        assert_eq!(parse_lsof_fd_outputs(&out), vec![]);
    }

    #[test]
    fn parse_empty_and_malformed_is_empty() {
        assert_eq!(parse_lsof_fd_outputs(""), vec![]);
        assert_eq!(parse_lsof_fd_outputs("garbage\n\n"), vec![]);
    }

    #[test]
    fn count_only_counts_live_wrappers_whose_task_id_is_background() {
        let outputs = vec![
            ShellOutput { sid: SID_A.into(), task_id: "bush20ok3".into() },
            ShellOutput { sid: SID_A.into(), task_id: "fgonly123".into() },
            ShellOutput { sid: SID_B.into(), task_id: "bh8hl40cs".into() },
        ];
        assert_eq!(
            count_running_shells_for_sid(&outputs, SID_A, &set(&["bush20ok3", "b48tqxha9"])),
            1
        );
        assert_eq!(
            count_running_shells_for_sid(&outputs, SID_B, &set(&["bh8hl40cs"])),
            1
        );
    }

    #[test]
    fn count_adds_up_multiple_bg_shells_under_the_same_sid() {
        let outputs = vec![
            ShellOutput { sid: SID_A.into(), task_id: "bush20ok3".into() },
            ShellOutput { sid: SID_A.into(), task_id: "b48tqxha9".into() },
        ];
        assert_eq!(
            count_running_shells_for_sid(&outputs, SID_A, &set(&["bush20ok3", "b48tqxha9"])),
            2
        );
    }

    #[test]
    fn count_treats_multiple_processes_on_the_same_task_as_one_shell() {
        // A wrapper shell and its child (e.g. `sleep` in a polling loop) both hold the
        // inherited fd1 to the same output file, so lsof yields one entry per process.
        let outputs = vec![
            ShellOutput { sid: SID_A.into(), task_id: "bush20ok3".into() },
            ShellOutput { sid: SID_A.into(), task_id: "bush20ok3".into() },
        ];
        assert_eq!(
            count_running_shells_for_sid(&outputs, SID_A, &set(&["bush20ok3"])),
            1
        );
    }

    #[test]
    fn count_is_zero_when_no_background_ids_match() {
        let outputs = vec![ShellOutput { sid: SID_A.into(), task_id: "fgonly123".into() }];
        assert_eq!(count_running_shells_for_sid(&outputs, SID_A, &set(&[])), 0);
    }
}
