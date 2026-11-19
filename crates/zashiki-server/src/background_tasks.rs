//! Background Bash tasks (`run_in_background`) read from a Claude Session's transcript: what was
//! launched, and how each one ended. Whether a task looks stalled is the client's call
//! (`packages/shared/src/background-tasks.ts`); this side only reports observable facts.
//! The reading contract lives in the tests below.

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::LazyLock;
use std::time::UNIX_EPOCH;

use regex::Regex;
use serde_json::Value;

use crate::jsonl::parse_iso8601_ms;
use crate::protocol::BackgroundTaskPhase;

/// One background launch, joined from the Bash `tool_use` (description, command) and its result line
/// (task id, output file, launch time).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskLaunch {
    pub task_id: String,
    pub description: String,
    pub command: String,
    pub started_at_ms: Option<u64>,
    pub output_path: Option<String>,
}

/// How a task ended, from its `<task-notification>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskEnd {
    /// `completed` / `failed` / `killed` / `stopped`; a TaskStop by Claude reads as `killed`.
    pub status: String,
    /// Only present when the notice's summary states it.
    pub exit_code: Option<i32>,
    pub ended_at_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskRecord {
    pub launch: TaskLaunch,
    pub end: Option<TaskEnd>,
}

const END_STATUSES: [&str; 4] = ["completed", "failed", "killed", "stopped"];

static OUTPUT_PATH_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"Output is being written to: (\S+\.output)").expect("static regex is valid")
});
static NOTICE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?s)<task-id>([A-Za-z0-9]+)</task-id>.*?<status>([a-z_]+)</status>")
        .expect("static regex is valid")
});
static EXIT_CODE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"exit code (-?\d+)").expect("static regex is valid"));

/// How many recent Bash calls keep their input for a launch result to join. A command moved to the
/// background mid-run (Ctrl+B) carries no `run_in_background`, so every Bash call is kept, newest last.
const PENDING_INPUTS_KEPT: usize = 64;

/// Accumulates background launches and their ends line by line, so a growing transcript can be fed
/// from where the last read stopped.
#[derive(Debug, Default)]
pub struct BackgroundTaskScan {
    pending_inputs: VecDeque<(String, (String, String))>,
    launches: Vec<TaskLaunch>,
    ends: HashMap<String, TaskEnd>,
}

impl BackgroundTaskScan {
    pub fn feed(&mut self, line: &str) {
        let looks_relevant = line.contains("\"Bash\"")
            || line.contains("\"backgroundTaskId\"")
            || line.contains("<task-notification>")
            || line.contains("Successfully stopped task");
        if !looks_relevant {
            return;
        }
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            return;
        };
        self.remember_bash_inputs(&event);
        self.record_launch(&event);
        self.record_end(&event);
        self.record_task_stop(&event);
    }

    /// Launch order, each with its end when the notice has been seen.
    pub fn records(&self) -> Vec<TaskRecord> {
        self.launches
            .iter()
            .map(|launch| TaskRecord {
                launch: launch.clone(),
                end: self.ends.get(&launch.task_id).cloned(),
            })
            .collect()
    }

    fn remember_bash_inputs(&mut self, event: &Value) {
        let Some(items) = event.pointer("/message/content").and_then(Value::as_array) else {
            return;
        };
        for item in items {
            let is_bash = item.get("type").and_then(Value::as_str) == Some("tool_use")
                && item.get("name").and_then(Value::as_str) == Some("Bash");
            let Some(id) = item.get("id").and_then(Value::as_str) else {
                continue;
            };
            if is_bash {
                let text = |key: &str| {
                    item.pointer(&format!("/input/{key}"))
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string()
                };
                if self.pending_inputs.len() == PENDING_INPUTS_KEPT {
                    self.pending_inputs.pop_front();
                }
                self.pending_inputs
                    .push_back((id.to_string(), (text("description"), text("command"))));
            }
        }
    }

    fn record_launch(&mut self, event: &Value) {
        let Some(task_id) = event
            .pointer("/toolUseResult/backgroundTaskId")
            .and_then(Value::as_str)
        else {
            return;
        };
        if self.launches.iter().any(|l| l.task_id == task_id) {
            return;
        }
        let result = event
            .pointer("/message/content")
            .and_then(Value::as_array)
            .and_then(|items| items.iter().find(|i| i.get("type").and_then(Value::as_str) == Some("tool_result")));
        let (description, command) = result
            .and_then(|r| r.get("tool_use_id").and_then(Value::as_str))
            .and_then(|id| {
                let at = self.pending_inputs.iter().position(|(pending, _)| pending == id)?;
                self.pending_inputs.remove(at).map(|(_, input)| input)
            })
            .unwrap_or_default();
        let output_path = result
            .map(tool_result_text)
            .and_then(|text| OUTPUT_PATH_RE.captures(&text).map(|c| c[1].to_string()));
        self.launches.push(TaskLaunch {
            task_id: task_id.to_string(),
            description,
            command,
            started_at_ms: timestamp_ms(event),
            output_path,
        });
    }

    fn record_end(&mut self, event: &Value) {
        let Some(notice) = task_notification_text(event) else {
            return;
        };
        for block in notice.split("<task-notification>") {
            self.record_notice_block(block, timestamp_ms(event));
        }
    }

    fn record_notice_block(&mut self, block: &str, ended_at_ms: Option<u64>) {
        let Some(caps) = NOTICE_RE.captures(block) else {
            return;
        };
        let status = &caps[2];
        if !END_STATUSES.contains(&status) {
            return;
        }
        let exit_code = EXIT_CODE_RE
            .captures(block)
            .and_then(|c| c[1].parse().ok());
        self.ends.insert(
            caps[1].to_string(),
            TaskEnd {
                status: status.to_string(),
                exit_code,
                ended_at_ms,
            },
        );
    }
}

impl BackgroundTaskScan {
    /// Claude stopping a task with TaskStop writes no notice, only the tool's result.
    fn record_task_stop(&mut self, event: &Value) {
        let Some(result) = event.get("toolUseResult") else {
            return;
        };
        let stopped = result
            .get("message")
            .and_then(Value::as_str)
            .is_some_and(|m| m.starts_with("Successfully stopped task"));
        let Some(task_id) = result.get("task_id").and_then(Value::as_str) else {
            return;
        };
        if stopped && !self.ends.contains_key(task_id) {
            self.ends.insert(
                task_id.to_string(),
                TaskEnd {
                    status: "killed".to_string(),
                    exit_code: None,
                    ended_at_ms: timestamp_ms(event),
                },
            );
        }
    }
}

fn timestamp_ms(event: &Value) -> Option<u64> {
    event
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(parse_iso8601_ms)
}

fn tool_result_text(result: &Value) -> String {
    match result.get("content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// The notice delivered back to Claude: a queued `task-notification` attachment, or (older Claude
/// Code) a user message whose text is the notice itself. A notice merely quoted in conversation is
/// neither, so it is not read as an end.
fn task_notification_text(event: &Value) -> Option<&str> {
    let attachment = event.get("attachment");
    if attachment.and_then(|a| a.get("commandMode")).and_then(Value::as_str) == Some("task-notification") {
        return attachment.and_then(|a| a.get("prompt")).and_then(Value::as_str);
    }
    let text = event.pointer("/message/content").and_then(Value::as_str)?;
    (event.get("type").and_then(Value::as_str) == Some("user")
        && text.trim_start().starts_with("<task-notification>"))
    .then_some(text)
}

/// The last non-blank line of an output tail and how many lines in a row at the end repeat it.
pub fn trailing_repeat(tail: &str) -> Option<(String, u32)> {
    let mut lines = tail.lines().map(str::trim_end).filter(|l| !l.trim().is_empty()).rev();
    let last = lines.next()?;
    let repeats = 1 + lines.take_while(|l| *l == last).count() as u32;
    Some((last.to_string(), repeats))
}

/// A notice decides the end; without one, a live process means running. A task whose process is gone
/// while its Claude Session still runs has finished and its notice is not written yet; with the
/// Claude Session gone too, no notice will ever come.
pub fn task_phase(has_end: bool, process_alive: bool, claude_alive: bool) -> BackgroundTaskPhase {
    if has_end {
        BackgroundTaskPhase::Ended
    } else if process_alive {
        BackgroundTaskPhase::Running
    } else if claude_alive {
        BackgroundTaskPhase::Ended
    } else {
        BackgroundTaskPhase::Disconnected
    }
}

const OUTPUT_TAIL_BYTES: u64 = 8 * 1024;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct OutputFacts {
    pub modified_at_ms: Option<u64>,
    pub last_line: Option<(String, u32)>,
}

/// The output file's mtime, and (when `with_tail`) its trailing repeated line. Empty when missing.
pub fn read_output_facts(path: &Path, with_tail: bool) -> OutputFacts {
    let Ok(mut file) = fs::File::open(path) else {
        return OutputFacts::default();
    };
    let Ok(meta) = file.metadata() else {
        return OutputFacts::default();
    };
    let modified_at_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    let last_line = with_tail
        .then(|| {
            file.seek(SeekFrom::Start(meta.len().saturating_sub(OUTPUT_TAIL_BYTES)))
                .ok()?;
            let mut buf = Vec::new();
            file.read_to_end(&mut buf).ok()?;
            trailing_repeat(&String::from_utf8_lossy(&buf))
        })
        .flatten();
    OutputFacts { modified_at_ms, last_line }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn launch_lines(tool_use_id: &str, task_id: &str, description: &str, command: &str) -> [String; 2] {
        [
            json!({"type": "assistant", "message": {"content": [{
                "type": "tool_use", "id": tool_use_id, "name": "Bash",
                "input": {"command": command, "description": description, "run_in_background": true}
            }]}})
            .to_string(),
            json!({"type": "user", "timestamp": "2026-11-19T07:51:33.778Z",
                "message": {"content": [{"type": "tool_result", "tool_use_id": tool_use_id,
                    "content": format!("Command running in background with ID: {task_id}. Output is being written to: /private/tmp/claude-501/-p/s/tasks/{task_id}.output. You will be notified when it completes")}]},
                "toolUseResult": {"stdout": "", "backgroundTaskId": task_id}})
            .to_string(),
        ]
    }

    fn notice_line(task_id: &str, status: &str, summary: &str) -> String {
        json!({"type": "attachment", "timestamp": "2026-11-19T07:52:00.000Z", "attachment": {
            "type": "queued_command", "commandMode": "task-notification",
            "prompt": format!("<task-notification>\n<task-id>{task_id}</task-id>\n<status>{status}</status>\n<summary>{summary}</summary>\n</task-notification>")
        }})
        .to_string()
    }

    fn scan(lines: &[String]) -> Vec<TaskRecord> {
        let mut scan = BackgroundTaskScan::default();
        for line in lines {
            scan.feed(line);
        }
        scan.records()
    }

    #[test]
    fn launch_joins_description_command_output_file_and_time() {
        let records = scan(&launch_lines("tu1", "bovk8tlrw", "Stalled sleep", "sleep 3600"));
        assert_eq!(
            records,
            vec![TaskRecord {
                launch: TaskLaunch {
                    task_id: "bovk8tlrw".into(),
                    description: "Stalled sleep".into(),
                    command: "sleep 3600".into(),
                    started_at_ms: Some(1_795_074_693_778),
                    output_path: Some("/private/tmp/claude-501/-p/s/tasks/bovk8tlrw.output".into()),
                },
                end: None,
            }]
        );
    }

    #[test]
    fn failed_notice_carries_status_exit_code_and_time() {
        let mut lines = launch_lines("tu1", "bsmj3yp39", "d", "exit 3").to_vec();
        lines.push(notice_line("bsmj3yp39", "failed", "Background command \"d\" failed with exit code 3"));
        assert_eq!(
            scan(&lines)[0].end,
            Some(TaskEnd { status: "failed".into(), exit_code: Some(3), ended_at_ms: Some(1_795_074_720_000) })
        );
    }

    #[test]
    fn stopped_notice_has_no_exit_code() {
        let mut lines = launch_lines("tu1", "b1", "d", "c").to_vec();
        lines.push(notice_line("b1", "stopped", "Background command \"d\" was stopped"));
        let end = scan(&lines)[0].end.clone().unwrap();
        assert_eq!((end.status.as_str(), end.exit_code), ("stopped", None));
    }

    #[test]
    fn task_stop_by_claude_is_a_killed_end() {
        let mut lines = launch_lines("tu1", "b6chyl2o3", "d", "sleep 3600").to_vec();
        lines.push(
            json!({"type": "user", "timestamp": "2026-11-19T08:21:03.267Z",
                "toolUseResult": {"message": "Successfully stopped task: b6chyl2o3 (sleep 3600)",
                    "task_id": "b6chyl2o3", "task_type": "local_bash"}})
            .to_string(),
        );
        assert_eq!(
            scan(&lines)[0].end,
            Some(TaskEnd { status: "killed".into(), exit_code: None, ended_at_ms: Some(1_795_076_463_267) })
        );
    }

    #[test]
    fn failed_task_stop_is_not_an_end() {
        let mut lines = launch_lines("tu1", "b1", "d", "c").to_vec();
        lines.push(
            json!({"type": "user", "toolUseResult": {"message": "No task found with ID: b1", "task_id": "b1"}})
                .to_string(),
        );
        assert_eq!(scan(&lines)[0].end, None);
    }

    #[test]
    fn running_notice_is_not_an_end() {
        let mut lines = launch_lines("tu1", "b1", "d", "c").to_vec();
        lines.push(notice_line("b1", "running", "still going"));
        assert_eq!(scan(&lines)[0].end, None);
    }

    #[test]
    fn older_notice_as_user_text_is_an_end() {
        let mut lines = launch_lines("tu1", "b1", "d", "c").to_vec();
        lines.push(
            json!({"type": "user", "message": {"content": "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command \"d\" completed (exit code 0)</summary>\n</task-notification>"}})
                .to_string(),
        );
        assert_eq!(scan(&lines)[0].end.clone().unwrap().exit_code, Some(0));
    }

    #[test]
    fn notice_quoted_in_conversation_is_not_an_end() {
        let mut lines = launch_lines("tu1", "b1", "d", "c").to_vec();
        lines.push(
            json!({"type": "user", "message": {"content": "why did <task-notification><task-id>b1</task-id><status>failed</status> show up?"}})
                .to_string(),
        );
        assert_eq!(scan(&lines)[0].end, None);
    }

    #[test]
    fn command_moved_to_the_background_keeps_its_description_and_command() {
        let use_line = json!({"type": "assistant", "message": {"content": [{
            "type": "tool_use", "id": "tu1", "name": "Bash",
            "input": {"command": "make ci", "description": "Run CI"}
        }]}})
        .to_string();
        let [_, result_line] = launch_lines("tu1", "b1", "", "");
        let launch = scan(&[use_line, result_line])[0].launch.clone();
        assert_eq!((launch.description.as_str(), launch.command.as_str()), ("Run CI", "make ci"));
    }

    #[test]
    fn only_recent_bash_inputs_are_kept() {
        let mut lines: Vec<String> = (0..=PENDING_INPUTS_KEPT)
            .map(|i| {
                json!({"type": "assistant", "message": {"content": [{
                    "type": "tool_use", "id": format!("tu{i}"), "name": "Bash", "input": {"command": format!("c{i}")}
                }]}})
                .to_string()
            })
            .collect();
        let [_, oldest] = launch_lines("tu0", "b0", "", "");
        let [_, newest] = launch_lines(&format!("tu{PENDING_INPUTS_KEPT}"), "b1", "", "");
        lines.extend([oldest, newest]);
        let records = scan(&lines);
        assert_eq!(records[0].launch.command, "");
        assert_eq!(records[1].launch.command, format!("c{PENDING_INPUTS_KEPT}"));
    }

    #[test]
    fn notices_batched_in_one_payload_each_keep_their_own_exit_code() {
        let block = |id: &str, status: &str, summary: &str| {
            format!("<task-notification>\n<task-id>{id}</task-id>\n<status>{status}</status>\n<summary>{summary}</summary>\n</task-notification>")
        };
        let batched = json!({"type": "attachment", "attachment": {
            "commandMode": "task-notification",
            "prompt": format!("{}\n{}", block("b1", "completed", "done"), block("b2", "failed", "failed with exit code 3"))
        }})
        .to_string();
        let mut lines = Vec::new();
        for (tu, id) in [("tu1", "b1"), ("tu2", "b2")] {
            lines.extend(launch_lines(tu, id, "", ""));
        }
        lines.push(batched);
        let ends: Vec<_> = scan(&lines)
            .into_iter()
            .map(|r| r.end.map(|e| (e.status, e.exit_code)))
            .collect();
        assert_eq!(
            ends,
            [Some(("completed".to_string(), None)), Some(("failed".to_string(), Some(3)))]
        );
    }

    #[test]
    fn foreground_bash_is_not_a_launch() {
        let lines = [json!({"type": "assistant", "message": {"content": [{
            "type": "tool_use", "id": "tu1", "name": "Bash", "input": {"command": "ls"}
        }]}})
        .to_string()];
        assert!(scan(&lines).is_empty());
    }

    #[test]
    fn a_task_id_seen_twice_is_one_launch() {
        let [use_line, result_line] = launch_lines("tu1", "b1", "d", "c");
        assert_eq!(scan(&[use_line, result_line.clone(), result_line]).len(), 1);
    }

    #[test]
    fn notice_for_an_unknown_task_adds_nothing() {
        assert!(scan(&[notice_line("agent1", "completed", "done")]).is_empty());
    }

    #[test]
    fn feeding_in_two_parts_matches_one_pass() {
        let [use_line, result_line] = launch_lines("tu1", "b1", "d", "c");
        let mut split = BackgroundTaskScan::default();
        split.feed(&use_line);
        split.feed("{broken");
        split.feed(&result_line);
        assert_eq!(split.records(), scan(&launch_lines("tu1", "b1", "d", "c")));
    }

    #[test]
    fn phase_prefers_the_notice_then_the_live_process() {
        use BackgroundTaskPhase::*;
        assert_eq!(task_phase(true, true, true), Ended);
        assert_eq!(task_phase(false, true, false), Running);
        assert_eq!(task_phase(false, false, true), Ended);
        assert_eq!(task_phase(false, false, false), Disconnected);
    }

    #[test]
    fn output_facts_read_mtime_and_tail_only_when_asked() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("b1.output");
        std::fs::write(&path, "start\nwaiting\nwaiting\n").unwrap();
        filetime::set_file_mtime(&path, filetime::FileTime::from_unix_time(1_800_000_000, 0)).unwrap();
        assert_eq!(
            read_output_facts(&path, true),
            OutputFacts { modified_at_ms: Some(1_800_000_000_000), last_line: Some(("waiting".into(), 2)) }
        );
        assert_eq!(read_output_facts(&path, false).last_line, None);
        assert_eq!(read_output_facts(&dir.path().join("missing"), true), OutputFacts::default());
    }

    #[test]
    fn trailing_repeat_counts_the_same_last_line() {
        let tail = "start\nwaiting for lock\nwaiting for lock\n\nwaiting for lock\n";
        assert_eq!(trailing_repeat(tail), Some(("waiting for lock".into(), 3)));
    }

    #[test]
    fn trailing_repeat_of_varied_or_blank_output() {
        assert_eq!(trailing_repeat("a\nb\n"), Some(("b".into(), 1)));
        assert_eq!(trailing_repeat("\n  \n"), None);
    }
}
