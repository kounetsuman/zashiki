//! Adapter for reading `~/.claude/projects` jsonl (port of TS `infra/claude-projects.ts`).
//! Transcripts can grow large, so rather than reading the whole file we read only the
//! head/tail slices (the title lives at the head, the most recent event at the tail).
//! Parsing is the responsibility of the pure functions in `jsonl` / `status_poller`;
//! this module only handles I/O (`spawn_blocking` + std::fs) and computing freshness in seconds.

use std::collections::HashSet;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::jsonl::{background_task_ids, claude_project_dir_name, session_usage, SessionUsageData};
use crate::status_poller::Slices;

const DEFAULT_MAX_SLICE_BYTES: u64 = 64 * 1024;

type NowMs = Box<dyn Fn() -> u64 + Send + Sync>;

/// Adapter for reading jsonl slices plus subagents mtime.
pub struct ClaudeProjectsAdapter {
    root_dir: PathBuf,
    max_slice_bytes: u64,
    now_ms: NowMs,
}

fn real_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Elapsed seconds since mtime (floored, clamped to 0). TS `Math.max(0, Math.floor((now-mtimeMs)/1000))`.
fn age_sec(now_ms_val: u64, mtime_ms_val: u64) -> f64 {
    (now_ms_val.saturating_sub(mtime_ms_val) / 1000) as f64
}

impl ClaudeProjectsAdapter {
    pub fn new(root_dir: PathBuf) -> Self {
        Self {
            root_dir,
            max_slice_bytes: DEFAULT_MAX_SLICE_BYTES,
            now_ms: Box::new(real_now_ms),
        }
    }

    /// cwd + sid → transcript slices (None when the file is missing or unreadable).
    pub async fn read_slices(&self, cwd: &str, sid: &str) -> Option<Slices> {
        let path = self
            .root_dir
            .join(claude_project_dir_name(cwd))
            .join(format!("{sid}.jsonl"));
        let max = self.max_slice_bytes;
        let now = (self.now_ms)();
        tokio::task::spawn_blocking(move || read_slices_sync(&path, max, now))
            .await
            .ok()
            .flatten()
    }

    /// Elapsed seconds since mtime for each `<sid>/subagents/agent-*.jsonl` file (empty if the directory is missing).
    pub async fn subagent_ages(&self, cwd: &str, sid: &str) -> Vec<f64> {
        let dir = self
            .root_dir
            .join(claude_project_dir_name(cwd))
            .join(sid)
            .join("subagents");
        let now = (self.now_ms)();
        tokio::task::spawn_blocking(move || subagent_ages_sync(&dir, now))
            .await
            .unwrap_or_default()
    }

    /// Token/timing rollup for the session status footer (None when the file is missing/unreadable or
    /// has no timestamped event). Like `background_task_ids`, it reads the whole file: session totals
    /// need every assistant `usage`, not just the tail slice.
    pub async fn session_usage(&self, cwd: &str, sid: &str) -> Option<SessionUsageData> {
        let path = self
            .root_dir
            .join(claude_project_dir_name(cwd))
            .join(format!("{sid}.jsonl"));
        tokio::task::spawn_blocking(move || session_usage(&fs::read_to_string(&path).ok()?))
            .await
            .ok()
            .flatten()
    }

    /// The set of `toolUseResult.backgroundTaskId` in the transcript (empty when the file is missing
    /// or has none). Unlike `read_slices`, this reads the whole file: a still-live background shell
    /// may have been launched far from the tail, so its launch line must not be sliced away.
    pub async fn background_task_ids(&self, cwd: &str, sid: &str) -> HashSet<String> {
        let path = self
            .root_dir
            .join(claude_project_dir_name(cwd))
            .join(format!("{sid}.jsonl"));
        tokio::task::spawn_blocking(move || match fs::read_to_string(&path) {
            Ok(content) => background_task_ids(&content),
            Err(_) => HashSet::new(),
        })
        .await
        .unwrap_or_default()
    }
}

/// Core of slice reading (std::fs, synchronous). When size <= max*2, read the whole
/// file with head=tail; when larger, read the first `max` and last `max` bytes, dropping
/// the one partial line at the start of the tail.
fn read_slices_sync(path: &Path, max_bytes: u64, now_ms_val: u64) -> Option<Slices> {
    let meta = fs::metadata(path).ok()?;
    let size = meta.len();
    let mtime_age_sec = age_sec(now_ms_val, mtime_ms(&meta));

    if size <= max_bytes.saturating_mul(2) {
        let content = String::from_utf8_lossy(&fs::read(path).ok()?).into_owned();
        return Some(Slices {
            head: content.clone(),
            tail: content,
            mtime_age_sec,
        });
    }

    let mut file = fs::File::open(path).ok()?;
    let mut head_buf = vec![0u8; max_bytes as usize];
    file.read_exact(&mut head_buf).ok()?;
    let mut tail_buf = vec![0u8; max_bytes as usize];
    file.seek(SeekFrom::Start(size - max_bytes)).ok()?;
    file.read_exact(&mut tail_buf).ok()?;

    let raw_tail = String::from_utf8_lossy(&tail_buf);
    let tail = match raw_tail.find('\n') {
        Some(i) => raw_tail[i + 1..].to_string(),
        None => String::new(),
    };
    Some(Slices {
        head: String::from_utf8_lossy(&head_buf).into_owned(),
        tail,
        mtime_age_sec,
    })
}

/// Elapsed seconds since mtime for each `agent-*.jsonl` file in the subagents directory (unordered).
fn subagent_ages_sync(dir: &Path, now_ms_val: u64) -> Vec<f64> {
    let Ok(read_dir) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut ages = Vec::new();
    for entry in read_dir.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !(name.starts_with("agent-") && name.ends_with(".jsonl")) {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if meta.is_file() {
            ages.push(age_sec(now_ms_val, mtime_ms(&meta)));
        }
    }
    ages
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jsonl::{first_user_title, last_user_or_assistant_event};
    use filetime::{set_file_mtime, FileTime};
    use zashiki_core::session_state::TranscriptKind;

    const CWD: &str = "/Users/test/workspace/org/repo";
    const PROJ_DIR: &str = "-Users-test-workspace-org-repo";
    const SID: &str = "0b6cbc45-83a9-4f2e-9c3d-1a2b3c4d5e6f";
    const BASE_SEC: u64 = 1_700_000_000;

    fn write_jsonl(root: &Path, sid: &str, content: &str, mtime_sec: u64) -> PathBuf {
        let dir = root.join(PROJ_DIR);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{sid}.jsonl"));
        fs::write(&path, content).unwrap();
        set_file_mtime(&path, FileTime::from_unix_time(mtime_sec as i64, 0)).unwrap();
        path
    }

    fn write_subagent(root: &Path, sid: &str, name: &str, mtime_sec: u64) {
        let dir = root.join(PROJ_DIR).join(sid).join("subagents");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        fs::write(&path, "{}\n").unwrap();
        set_file_mtime(&path, FileTime::from_unix_time(mtime_sec as i64, 0)).unwrap();
    }

    fn slices_path(root: &Path, sid: &str) -> PathBuf {
        root.join(PROJ_DIR).join(format!("{sid}.jsonl"))
    }

    #[tokio::test]
    async fn background_task_ids_reads_full_transcript() {
        let tmp = tempfile::tempdir().unwrap();
        let content = "{\"type\":\"user\",\"toolUseResult\":{\"backgroundTaskId\":\"bush20ok3\"}}\n{\"type\":\"user\",\"message\":{\"content\":\"x\"}}\n{\"type\":\"user\",\"toolUseResult\":{\"backgroundTaskId\":\"b48tqxha9\"}}\n";
        write_jsonl(tmp.path(), SID, content, BASE_SEC);
        let adapter = ClaudeProjectsAdapter::new(tmp.path().to_path_buf());
        let ids = adapter.background_task_ids(CWD, SID).await;
        assert_eq!(
            ids,
            HashSet::from(["bush20ok3".to_string(), "b48tqxha9".to_string()])
        );
    }

    #[tokio::test]
    async fn session_usage_reads_full_transcript_totals() {
        let tmp = tempfile::tempdir().unwrap();
        let content = "{\"type\":\"user\",\"timestamp\":\"2000-01-01T00:00:00Z\",\"message\":{\"content\":\"go\"}}\n{\"type\":\"assistant\",\"timestamp\":\"2000-01-01T00:00:05Z\",\"message\":{\"content\":[],\"usage\":{\"input_tokens\":10,\"output_tokens\":5}}}\n";
        write_jsonl(tmp.path(), SID, content, BASE_SEC);
        let adapter = ClaudeProjectsAdapter::new(tmp.path().to_path_buf());
        let u = adapter.session_usage(CWD, SID).await.unwrap();
        assert_eq!(u.session_tokens, 15);
        assert_eq!(u.session_started_at_ms, 946_684_800_000);
    }

    #[tokio::test]
    async fn session_usage_missing_transcript_is_none() {
        let tmp = tempfile::tempdir().unwrap();
        let adapter = ClaudeProjectsAdapter::new(tmp.path().to_path_buf());
        assert!(adapter.session_usage(CWD, SID).await.is_none());
    }

    #[tokio::test]
    async fn background_task_ids_missing_transcript_is_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let adapter = ClaudeProjectsAdapter::new(tmp.path().to_path_buf());
        assert!(adapter.background_task_ids(CWD, SID).await.is_empty());
    }

    #[test]
    fn small_file_is_returned_whole_with_age() {
        let tmp = tempfile::tempdir().unwrap();
        write_jsonl(
            tmp.path(),
            SID,
            "{\"type\":\"user\",\"message\":{\"content\":\"最初の依頼\"}}\n",
            BASE_SEC,
        );
        let slices = read_slices_sync(
            &slices_path(tmp.path(), SID),
            64 * 1024,
            (BASE_SEC + 5) * 1000,
        )
        .unwrap();
        assert!(slices.head.contains("最初の依頼"));
        assert!(slices.tail.contains("最初の依頼"));
        assert_eq!(slices.mtime_age_sec, 5.0);
    }

    #[test]
    fn age_reflects_old_mtime() {
        let tmp = tempfile::tempdir().unwrap();
        write_jsonl(tmp.path(), SID, "{}\n", BASE_SEC);
        let slices = read_slices_sync(
            &slices_path(tmp.path(), SID),
            64 * 1024,
            (BASE_SEC + 120) * 1000,
        )
        .unwrap();
        assert_eq!(slices.mtime_age_sec, 120.0);
    }

    #[test]
    fn large_file_is_sliced_and_parses_with_shared_fns() {
        let tmp = tempfile::tempdir().unwrap();
        let first = "{\"type\":\"user\",\"message\":{\"content\":\"最初の依頼タイトル\"}}";
        let filler = format!(
            "{{\"type\":\"assistant\",\"message\":{{\"content\":[{{\"type\":\"text\",\"text\":\"{}\"}}]}}}}",
            "x".repeat(200)
        );
        let last = "{\"type\":\"user\",\"message\":{\"content\":\"最後の依頼\"}}";
        let mut lines = vec![first.to_string()];
        for _ in 0..100 {
            lines.push(filler.clone());
        }
        lines.push(last.to_string());
        write_jsonl(
            tmp.path(),
            SID,
            &format!("{}\n", lines.join("\n")),
            BASE_SEC,
        );

        let slices =
            read_slices_sync(&slices_path(tmp.path(), SID), 4096, BASE_SEC * 1000).unwrap();
        assert_eq!(
            first_user_title(&slices.head, 30).as_deref(),
            Some("最初の依頼タイトル")
        );
        let ev = last_user_or_assistant_event(&slices.tail).expect("tail event");
        assert_eq!(ev.kind, TranscriptKind::User);
        assert!(!ev.interrupted);
    }

    #[test]
    fn missing_file_is_none() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(read_slices_sync(
            &slices_path(tmp.path(), "ffffffff-0000-0000-0000-000000000000"),
            64 * 1024,
            BASE_SEC * 1000,
        )
        .is_none());
    }

    #[test]
    fn subagent_ages_returns_mtime_ages_for_agent_jsonl() {
        let tmp = tempfile::tempdir().unwrap();
        let sub_sid = "11111111-2222-3333-4444-555555555555";
        write_subagent(tmp.path(), sub_sid, "agent-aaa.jsonl", BASE_SEC);
        write_subagent(tmp.path(), sub_sid, "agent-bbb.jsonl", BASE_SEC - 120);
        let dir = tmp.path().join(PROJ_DIR).join(sub_sid).join("subagents");
        let mut ages = subagent_ages_sync(&dir, BASE_SEC * 1000);
        ages.sort_by(|a, b| a.partial_cmp(b).unwrap());
        assert_eq!(ages, vec![0.0, 120.0]);
    }

    #[test]
    fn subagent_ages_ignores_non_agent_jsonl_files() {
        let tmp = tempfile::tempdir().unwrap();
        let sid = "22222222-2222-3333-4444-555555555555";
        write_subagent(tmp.path(), sid, "agent-aaa.jsonl", BASE_SEC);
        write_subagent(tmp.path(), sid, "agent-aaa.meta.json", BASE_SEC);
        write_subagent(tmp.path(), sid, "note.txt", BASE_SEC);
        let dir = tmp.path().join(PROJ_DIR).join(sid).join("subagents");
        assert_eq!(subagent_ages_sync(&dir, BASE_SEC * 1000).len(), 1);
    }

    #[test]
    fn subagent_ages_missing_dir_is_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp
            .path()
            .join(PROJ_DIR)
            .join("99999999-0000-0000-0000-000000000000")
            .join("subagents");
        assert!(subagent_ages_sync(&dir, BASE_SEC * 1000).is_empty());
    }

    #[tokio::test]
    async fn adapter_reads_slices_through_async_wrapper() {
        let tmp = tempfile::tempdir().unwrap();
        write_jsonl(tmp.path(), SID, "{\"type\":\"user\"}\n", BASE_SEC);
        let adapter = ClaudeProjectsAdapter {
            root_dir: tmp.path().to_path_buf(),
            max_slice_bytes: 64 * 1024,
            now_ms: Box::new(|| (BASE_SEC + 3) * 1000),
        };
        let slices = adapter.read_slices(CWD, SID).await.unwrap();
        assert_eq!(slices.mtime_age_sec, 3.0);
        assert!(adapter.subagent_ages(CWD, SID).await.is_empty());
    }
}
