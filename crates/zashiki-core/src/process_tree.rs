//! Parsing of ps output and tree traversal for the claude sid.
//! Running ps is the responsibility of server/infra. This module handles only the ps output string and the tree traversal.

use std::collections::{HashMap, HashSet, VecDeque};

/// Whether this has UUID shape (`8-4-4-4-12` hex with dashes at fixed positions).
fn is_uuid_shape(b: &[u8]) -> bool {
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
                if !c.is_ascii_hexdigit() {
                    return false;
                }
            }
        }
    }
    true
}

/// If the start is a UUID, return the 36 characters (trailing characters don't matter).
fn take_uuid_prefix(s: &str) -> Option<&str> {
    let b = s.as_bytes();
    // If the first 36 bytes have UUID shape they're all ASCII, so `s[..36]` is on a char boundary.
    if b.len() >= 36 && is_uuid_shape(&b[..36]) {
        Some(&s[..36])
    } else {
        None
    }
}

/// Read the session id from claude's launch arguments (the UUID following `--session-id` / `--resume` / `-r`,
/// lowercased; None if absent). Follows `(?:--session-id|--resume|-r) +<UUID>`
/// with leftmost semantics, taking only the first match.
pub fn sid_from_args(args: &str) -> Option<String> {
    // At a position following `--resume`, `-r` isn't followed by whitespace+UUID and so fails to match; hence, regardless of order,
    // multiple tokens don't conflict at the same start position (distinguishable by the first 2 characters).
    let tokens = ["--session-id", "--resume", "-r"];
    for (i, _) in args.char_indices() {
        let rest = &args[i..];
        for tok in tokens {
            if let Some(after) = rest.strip_prefix(tok) {
                let trimmed = after.trim_start_matches(' ');
                // ` +` (one or more spaces): at least one must have been consumed.
                if trimmed.len() < after.len() {
                    if let Some(uuid) = take_uuid_prefix(trimmed) {
                        return Some(uuid.to_ascii_lowercase());
                    }
                }
            }
        }
    }
    None
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessEntry {
    pub pid: i64,
    pub ppid: i64,
    pub args: String,
}

/// Read the leading run of ASCII digits as an i64 and return the remainder (None if absent).
fn take_digits(s: &str) -> Option<(i64, &str)> {
    let end = s
        .char_indices()
        .take_while(|(_, c)| c.is_ascii_digit())
        .map(|(i, c)| i + c.len_utf8())
        .last();
    let end = end?;
    let (digits, rest) = s.split_at(end);
    digits.parse::<i64>().ok().map(|n| (n, rest))
}

/// Parse the output of `ps -Aww -o pid=,ppid=,args=` (skipping malformed lines).
/// Each valid line matches `^\s*(\d+)\s+(\d+)\s+(.*)$`.
pub fn parse_ps_snapshot(ps_output: &str) -> Vec<ProcessEntry> {
    let mut entries = Vec::new();
    for line in ps_output.split('\n') {
        // ^\s*
        let s = line.trim_start();
        // (\d+)
        let Some((pid, rest)) = take_digits(s) else {
            continue;
        };
        // \s+
        let rest_t = rest.trim_start();
        if rest_t.len() == rest.len() {
            continue;
        }
        // (\d+)
        let Some((ppid, rest2)) = take_digits(rest_t) else {
            continue;
        };
        // \s+
        let rest2_t = rest2.trim_start();
        if rest2_t.len() == rest2.len() {
            continue;
        }
        // (.*)$ — preserve internal whitespace
        entries.push(ProcessEntry {
            pid,
            ppid,
            args: rest2_t.to_string(),
        });
    }
    entries
}

pub struct ProcessMaps {
    /// pid -> sid for claude processes (only those whose arguments contain a UUID).
    pub pid_to_sid: HashMap<i64, String>,
    /// ppid -> list of child pids (in order of appearance).
    pub children_of: HashMap<i64, Vec<i64>>,
}

/// Build the sid map and the parent-child map from a ps snapshot (non-claude processes are not added to the sid map).
pub fn build_process_maps(entries: &[ProcessEntry]) -> ProcessMaps {
    let mut pid_to_sid = HashMap::new();
    let mut children_of: HashMap<i64, Vec<i64>> = HashMap::new();
    for e in entries {
        // case-insensitive match of `claude` in args
        if e.args.to_lowercase().contains("claude") {
            if let Some(sid) = sid_from_args(&e.args) {
                pid_to_sid.insert(e.pid, sid);
            }
        }
        children_of.entry(e.ppid).or_default().push(e.pid);
    }
    ProcessMaps {
        pid_to_sid,
        children_of,
    }
}

/// BFS the process tree and return the sid of the first claude found (None if absent).
/// `visited` guards against anomalous ps data (cycles).
pub fn find_sid_in_tree(start_pid: i64, maps: &ProcessMaps) -> Option<String> {
    let mut queue: VecDeque<i64> = VecDeque::new();
    queue.push_back(start_pid);
    let mut visited: HashSet<i64> = HashSet::new();
    while let Some(pid) = queue.pop_front() {
        if visited.contains(&pid) {
            continue;
        }
        visited.insert(pid);
        if let Some(sid) = maps.pid_to_sid.get(&pid) {
            return Some(sid.clone());
        }
        if let Some(kids) = maps.children_of.get(&pid) {
            for &child in kids {
                queue.push_back(child);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const SID: &str = "0b6cbc45-83a9-4f2e-9c3d-1a2b3c4d5e6f";

    #[test]
    fn sid_from_session_id() {
        assert_eq!(
            sid_from_args(&format!("claude --session-id {SID}")),
            Some(SID.to_string())
        );
    }

    #[test]
    fn sid_from_resume() {
        assert_eq!(
            sid_from_args(&format!("claude --resume {SID} --continue")),
            Some(SID.to_string())
        );
    }

    #[test]
    fn sid_from_short_r() {
        assert_eq!(
            sid_from_args(&format!("claude -r {SID}")),
            Some(SID.to_string())
        );
    }

    #[test]
    fn sid_uppercase_is_lowercased() {
        assert_eq!(
            sid_from_args(&format!("claude --session-id {}", SID.to_uppercase())),
            Some(SID.to_string())
        );
    }

    #[test]
    fn sid_none_when_absent() {
        assert_eq!(sid_from_args("claude --continue"), None);
        assert_eq!(sid_from_args(""), None);
    }

    #[test]
    fn sid_takes_first_match() {
        let other = "ffffffff-ffff-ffff-ffff-ffffffffffff";
        assert_eq!(
            sid_from_args(&format!("claude --session-id {SID} --resume {other}")),
            Some(SID.to_string())
        );
    }

    #[test]
    fn parse_ps_reads_fields_preserving_arg_spaces() {
        let out = format!(
            "    1     0 /sbin/launchd\n  200     1 tmux -L zashiki\n  300   200 claude --session-id {SID}\n"
        );
        assert_eq!(
            parse_ps_snapshot(&out),
            vec![
                ProcessEntry {
                    pid: 1,
                    ppid: 0,
                    args: "/sbin/launchd".to_string()
                },
                ProcessEntry {
                    pid: 200,
                    ppid: 1,
                    args: "tmux -L zashiki".to_string()
                },
                ProcessEntry {
                    pid: 300,
                    ppid: 200,
                    args: format!("claude --session-id {SID}"),
                },
            ]
        );
    }

    #[test]
    fn parse_ps_skips_blank_and_garbage() {
        assert_eq!(
            parse_ps_snapshot("\ngarbage line\n"),
            Vec::<ProcessEntry>::new()
        );
    }

    fn tree_maps() -> ProcessMaps {
        let entries = parse_ps_snapshot(&format!(
            "  100    1 -zsh\n  110  100 claude --session-id {SID}\n  120  100 vim\n  200    1 -zsh\n  210  200 node server.js\n  211  210 claude --resume aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeffff"
        ));
        build_process_maps(&entries)
    }

    #[test]
    fn find_direct_child() {
        assert_eq!(find_sid_in_tree(100, &tree_maps()), Some(SID.to_string()));
    }

    #[test]
    fn find_grandchild_via_node() {
        assert_eq!(
            find_sid_in_tree(200, &tree_maps()),
            Some("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeffff".to_string())
        );
    }

    #[test]
    fn find_start_itself_is_claude() {
        assert_eq!(find_sid_in_tree(110, &tree_maps()), Some(SID.to_string()));
    }

    #[test]
    fn find_none_when_no_claude() {
        assert_eq!(find_sid_in_tree(120, &tree_maps()), None);
    }

    #[test]
    fn find_none_for_missing_pid() {
        assert_eq!(find_sid_in_tree(9999, &tree_maps()), None);
    }

    #[test]
    fn build_skips_non_claude_process() {
        let entries = parse_ps_snapshot(&format!("  100    1 some-tool --session-id {SID}\n"));
        let maps = build_process_maps(&entries);
        assert_eq!(find_sid_in_tree(100, &maps), None);
    }

    #[test]
    fn build_halts_on_cyclic_tree() {
        let entries = parse_ps_snapshot("  100  200 -zsh\n  200  100 -zsh\n");
        let maps = build_process_maps(&entries);
        assert_eq!(find_sid_in_tree(100, &maps), None);
    }
}
