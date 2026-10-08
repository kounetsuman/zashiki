//! Adapter for reading `~/.claude/projects` jsonl.
//! Transcripts can grow large, so rather than reading the whole file we read only the
//! head/tail slices (the title lives at the head, the most recent event at the tail).
//! Parsing is the responsibility of the pure functions in `jsonl` / `status_poller`;
//! this module only handles I/O (`spawn_blocking` + std::fs) and computing freshness in seconds.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::jsonl::{
    background_task_ids, claude_project_dir_name, session_usage, subagent_tokens, SessionUsageData,
    TitleScan, TranscriptTitle,
};
use crate::status_poller::Slices;
use zashiki_core::session_state::SubagentTranscript;

const DEFAULT_MAX_SLICE_BYTES: u64 = 64 * 1024;

type NowMs = Box<dyn Fn() -> u64 + Send + Sync>;

/// What a subagent transcript was worth when it was last read, with the size and mtime it was read
/// at. Transcripts are only ever appended to, so a file matching both is worth the same again.
#[derive(Clone, Copy, Default)]
struct CachedTotal {
    len: u64,
    mtime_ms: u64,
    tokens: u64,
}

/// Per-subagents-directory file totals, so a poll re-reads only the transcripts that grew.
type SubagentTotals = Arc<Mutex<HashMap<PathBuf, HashMap<PathBuf, CachedTotal>>>>;

/// How far a transcript has been scanned for its title. Transcripts only grow, so the next pass
/// resumes at `offset` instead of re-reading the file until Claude Code writes its title.
struct TitleProgress {
    offset: u64,
    scan: TitleScan,
}

type TitleScans = Arc<Mutex<HashMap<PathBuf, TitleProgress>>>;

/// Adapter for reading jsonl slices plus subagents mtime.
pub struct ClaudeProjectsAdapter {
    root_dir: PathBuf,
    max_slice_bytes: u64,
    now_ms: NowMs,
    subagent_totals: SubagentTotals,
    title_scans: TitleScans,
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

/// Elapsed seconds since mtime (floored, clamped to 0): `max(0, floor((now-mtimeMs)/1000))`.
fn age_sec(now_ms_val: u64, mtime_ms_val: u64) -> f64 {
    (now_ms_val.saturating_sub(mtime_ms_val) / 1000) as f64
}

impl ClaudeProjectsAdapter {
    pub fn new(root_dir: PathBuf) -> Self {
        Self {
            root_dir,
            subagent_totals: SubagentTotals::default(),
            title_scans: TitleScans::default(),
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

    /// The session title (None when the file is missing/unreadable or holds no title yet).
    pub async fn read_title(
        &self,
        cwd: &str,
        sid: &str,
        max_chars: usize,
    ) -> Option<TranscriptTitle> {
        let path = self
            .root_dir
            .join(claude_project_dir_name(cwd))
            .join(format!("{sid}.jsonl"));
        let scans = Arc::clone(&self.title_scans);
        tokio::task::spawn_blocking(move || read_title_sync(&path, max_chars, &scans))
            .await
            .ok()
            .flatten()
    }

    /// Each `<sid>/subagents/agent-*.jsonl` file as the agent it is named for plus how long ago it
    /// last changed (empty if the directory is missing).
    pub async fn subagent_transcripts(&self, cwd: &str, sid: &str) -> Vec<SubagentTranscript> {
        let dir = self
            .root_dir
            .join(claude_project_dir_name(cwd))
            .join(sid)
            .join("subagents");
        let now = (self.now_ms)();
        tokio::task::spawn_blocking(move || subagent_transcripts_sync(&dir, now))
            .await
            .unwrap_or_default()
    }

    /// Token/timing rollup for the session status footer (None when the file is missing/unreadable or
    /// has no timestamped event). Like `background_task_ids`, it reads the whole file: session totals
    /// need every assistant `usage`, not just the tail slice. Bytes are decoded leniently, as they are
    /// everywhere else here: a poll can land mid-append, in the middle of a multi-byte character, and
    /// a whole footer of dashes is a poor answer to one split character.
    pub async fn session_usage(&self, cwd: &str, sid: &str) -> Option<SessionUsageData> {
        let project_dir = self.root_dir.join(claude_project_dir_name(cwd));
        let path = project_dir.join(format!("{sid}.jsonl"));
        let subagents_dir = project_dir.join(sid).join("subagents");
        let totals = Arc::clone(&self.subagent_totals);
        tokio::task::spawn_blocking(move || {
            let mut data = session_usage(&String::from_utf8_lossy(&fs::read(&path).ok()?))?;
            data.subagent_tokens = subagent_tokens_sync(&subagents_dir, &totals);
            Some(data)
        })
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
        tokio::task::spawn_blocking(move || match fs::read(&path) {
            Ok(bytes) => background_task_ids(&String::from_utf8_lossy(&bytes)),
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

/// Scans the lines appended since the last pass. Whole lines are read rather than the byte-capped head
/// slice so a prompt inflated by inline base64 (pasted images) still parses, and a trailing line still
/// being written is left for the next pass. A file shorter than the saved offset was replaced, so it is
/// scanned again from the start. A failed read keeps what was found so far for the next pass.
fn read_title_sync(
    path: &Path,
    max_chars: usize,
    scans: &Mutex<HashMap<PathBuf, TitleProgress>>,
) -> Option<TranscriptTitle> {
    let file = fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let mut progress = scans
        .lock()
        .ok()
        .and_then(|mut scans| scans.remove(path))
        .filter(|p| p.offset <= len)
        .unwrap_or_else(|| TitleProgress {
            offset: 0,
            scan: TitleScan::new(max_chars),
        });
    let mut reader = BufReader::new(file);
    let mut buf = Vec::new();
    let seeked = reader.seek(SeekFrom::Start(progress.offset)).is_ok();
    while seeked && !progress.scan.is_settled() {
        buf.clear();
        let Ok(read) = reader.read_until(b'\n', &mut buf) else {
            break;
        };
        if buf.last() != Some(&b'\n') {
            break;
        }
        progress.offset += read as u64;
        progress
            .scan
            .feed(String::from_utf8_lossy(&buf).trim_end_matches(['\r', '\n']));
    }
    let title = progress.scan.title();
    if !progress.scan.is_settled() {
        if let Ok(mut scans) = scans.lock() {
            scans.insert(path.to_path_buf(), progress);
        }
    }
    title
}

/// The agent id a subagent transcript is named for (`agent-<id>.jsonl`), which is the same id its
/// `SubagentStop` hook reports. `.meta.json` and anything else in the directory is skipped.
fn transcript_agent_id(name: &str) -> Option<&str> {
    name.strip_prefix("agent-")?.strip_suffix(".jsonl")
}

/// Every subagent transcript at or below the subagents directory, with the size and mtime it was
/// found at. A workflow keeps its agents in a `workflows/<run>/` directory of their own, so the walk
/// descends rather than reading the top level alone. Symlinked directories are left alone (the file
/// type is read without following them), so the walk cannot be sent in a circle.
fn subagent_transcript_files(dir: &Path) -> Vec<(PathBuf, u64, u64)> {
    let mut files = Vec::new();
    let mut pending = vec![dir.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let Ok(read_dir) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in read_dir.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                pending.push(entry.path());
                continue;
            }
            if !file_type.is_file()
                || transcript_agent_id(&entry.file_name().to_string_lossy()).is_none()
            {
                continue;
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            files.push((entry.path(), meta.len(), mtime_ms(&meta)));
        }
    }
    files
}

/// Tokens spent across every subagent transcript below the directory (0 when it is missing).
///
/// Like the session transcript, a file is read whole: a total needs every assistant `usage`, not a
/// slice. A transcript is only appended to, so one whose size and mtime are unchanged since the last
/// poll is taken from `cache` instead, which is what keeps a session whose agents have finished from
/// re-reading tens of megabytes every poll; a transcript still being written is read again until it
/// settles. A directory's entry is rebuilt from this walk, so files that are gone drop out of it, and
/// a directory left with nothing drops out itself.
/// Bytes are decoded leniently: a poll can land mid-append, in the middle of a multi-byte character.
fn subagent_tokens_sync(
    dir: &Path,
    cache: &Mutex<HashMap<PathBuf, HashMap<PathBuf, CachedTotal>>>,
) -> u64 {
    let files = subagent_transcript_files(dir);
    let known = cache
        .lock()
        .ok()
        .and_then(|totals| totals.get(dir).cloned())
        .unwrap_or_default();
    let mut fresh = HashMap::with_capacity(files.len());
    for (path, len, mtime) in files {
        let cached = known
            .get(&path)
            .filter(|c| c.len == len && c.mtime_ms == mtime)
            .copied();
        let total = match cached {
            Some(total) => total,
            None => match fs::read(&path) {
                Ok(bytes) => CachedTotal {
                    len,
                    mtime_ms: mtime,
                    tokens: subagent_tokens(&String::from_utf8_lossy(&bytes)),
                },
                // Hold the last good reading at the size it was read at, so a file that could not be
                // opened this once keeps its tokens in the total and is read again next poll.
                Err(_) => known.get(&path).copied().unwrap_or_default(),
            },
        };
        fresh.insert(path, total);
    }
    let tokens = fresh.values().map(|c| c.tokens).sum();
    if let Ok(mut totals) = cache.lock() {
        // Most sessions run no subagents at all, so without this every terminal polled would leave
        // an empty entry behind for as long as the server is up.
        if fresh.is_empty() {
            totals.remove(dir);
        } else {
            totals.insert(dir.to_path_buf(), fresh);
        }
    }
    tokens
}

/// Every `agent-*.jsonl` file in the subagents directory itself, unordered. A workflow's agents sit
/// one directory deeper and are not reported here.
fn subagent_transcripts_sync(dir: &Path, now_ms_val: u64) -> Vec<SubagentTranscript> {
    let Ok(read_dir) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut transcripts = Vec::new();
    for entry in read_dir.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some(agent_id) = transcript_agent_id(&name) else {
            continue;
        };
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if meta.is_file() {
            transcripts.push(SubagentTranscript {
                agent_id: agent_id.to_string(),
                age_sec: age_sec(now_ms_val, mtime_ms(&meta)),
            });
        }
    }
    transcripts
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jsonl::{last_user_or_assistant_event, transcript_title};
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

    fn write_subagent_content(root: &Path, sid: &str, name: &str, content: &str) {
        write_subagent_at(root, sid, Path::new(name), content);
    }

    fn write_subagent_at(root: &Path, sid: &str, rel: &Path, content: &str) {
        let path = root.join(PROJ_DIR).join(sid).join("subagents").join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    /// One assistant reply spending `tokens`, as a subagent transcript line.
    fn agent_reply(tokens: u64) -> String {
        format!(
            "{{\"type\":\"assistant\",\"message\":{{\"usage\":{{\"input_tokens\":{tokens}}}}}}}\n"
        )
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
        assert_eq!(u.subagent_tokens, 0);
        assert_eq!(u.session_started_at_ms, 946_684_800_000);
    }

    /// A subagent's replies live in its own transcript, so its tokens reach the footer only through
    /// the `<sid>/subagents` directory — never through the session transcript's own totals.
    #[tokio::test]
    async fn session_usage_counts_every_subagent_transcript_apart_from_the_session() {
        let tmp = tempfile::tempdir().unwrap();
        let content = "{\"type\":\"user\",\"timestamp\":\"2000-01-01T00:00:00Z\",\"message\":{\"content\":\"go\"}}\n{\"type\":\"assistant\",\"timestamp\":\"2000-01-01T00:00:05Z\",\"message\":{\"content\":[],\"usage\":{\"input_tokens\":10,\"output_tokens\":5}}}\n";
        write_jsonl(tmp.path(), SID, content, BASE_SEC);
        write_subagent_content(tmp.path(), SID, "agent-a1.jsonl", &agent_reply(700));
        write_subagent_content(tmp.path(), SID, "agent-a2.jsonl", &agent_reply(40));
        write_subagent_content(tmp.path(), SID, "agent-a1.meta.json", &agent_reply(999));
        let adapter = ClaudeProjectsAdapter::new(tmp.path().to_path_buf());
        let u = adapter.session_usage(CWD, SID).await.unwrap();
        assert_eq!(u.subagent_tokens, 740);
        assert_eq!(u.session_tokens, 15);
    }

    /// A workflow parks its agents one directory deeper, under `workflows/<run>/`.
    #[tokio::test]
    async fn session_usage_counts_subagents_a_workflow_ran() {
        let tmp = tempfile::tempdir().unwrap();
        let content = "{\"type\":\"assistant\",\"timestamp\":\"2000-01-01T00:00:05Z\",\"message\":{\"usage\":{\"input_tokens\":10}}}\n";
        write_jsonl(tmp.path(), SID, content, BASE_SEC);
        write_subagent_content(tmp.path(), SID, "agent-a1.jsonl", &agent_reply(700));
        write_subagent_at(
            tmp.path(),
            SID,
            Path::new("workflows/wf_1/agent-a2.jsonl"),
            &agent_reply(40),
        );
        let adapter = ClaudeProjectsAdapter::new(tmp.path().to_path_buf());
        assert_eq!(
            adapter
                .session_usage(CWD, SID)
                .await
                .unwrap()
                .subagent_tokens,
            740
        );
    }

    /// The poll can land mid-append, splitting a multi-byte character; the transcript still counts.
    #[tokio::test]
    async fn session_usage_counts_a_subagent_transcript_cut_mid_character() {
        let tmp = tempfile::tempdir().unwrap();
        let content = "{\"type\":\"assistant\",\"timestamp\":\"2000-01-01T00:00:05Z\",\"message\":{\"usage\":{\"input_tokens\":10}}}\n";
        write_jsonl(tmp.path(), SID, content, BASE_SEC);
        let dir = tmp.path().join(PROJ_DIR).join(SID).join("subagents");
        fs::create_dir_all(&dir).unwrap();
        let mut bytes = agent_reply(700).into_bytes();
        bytes.extend_from_slice(&"日本語".as_bytes()[..4]);
        fs::write(dir.join("agent-a1.jsonl"), bytes).unwrap();
        let adapter = ClaudeProjectsAdapter::new(tmp.path().to_path_buf());
        assert_eq!(
            adapter
                .session_usage(CWD, SID)
                .await
                .unwrap()
                .subagent_tokens,
            700
        );
    }

    /// An unchanged transcript is not read again: the second poll answers from the first one's
    /// reading, which a file rewritten behind the adapter's back (same size, same mtime) exposes.
    #[tokio::test]
    async fn session_usage_rereads_only_subagent_transcripts_that_changed() {
        let tmp = tempfile::tempdir().unwrap();
        let content = "{\"type\":\"assistant\",\"timestamp\":\"2000-01-01T00:00:05Z\",\"message\":{\"usage\":{\"input_tokens\":10}}}\n";
        write_jsonl(tmp.path(), SID, content, BASE_SEC);
        write_subagent_content(tmp.path(), SID, "agent-a1.jsonl", &agent_reply(700));
        let path = tmp
            .path()
            .join(PROJ_DIR)
            .join(SID)
            .join("subagents")
            .join("agent-a1.jsonl");
        let adapter = ClaudeProjectsAdapter::new(tmp.path().to_path_buf());
        assert_eq!(
            adapter
                .session_usage(CWD, SID)
                .await
                .unwrap()
                .subagent_tokens,
            700
        );

        let mtime = fs::metadata(&path).unwrap().modified().unwrap();
        fs::write(&path, agent_reply(300)).unwrap();
        set_file_mtime(&path, FileTime::from_system_time(mtime)).unwrap();
        assert_eq!(
            adapter
                .session_usage(CWD, SID)
                .await
                .unwrap()
                .subagent_tokens,
            700
        );

        fs::write(&path, agent_reply(3000)).unwrap();
        assert_eq!(
            adapter
                .session_usage(CWD, SID)
                .await
                .unwrap()
                .subagent_tokens,
            3000
        );
    }

    /// The session transcript is appended to continuously, so a poll can read it mid-character.
    /// The footer keeps its reading rather than falling back to a row of dashes.
    #[tokio::test]
    async fn session_usage_reads_a_transcript_cut_mid_character() {
        let tmp = tempfile::tempdir().unwrap();
        let content = "{\"type\":\"assistant\",\"timestamp\":\"2000-01-01T00:00:05Z\",\"message\":{\"usage\":{\"input_tokens\":10}}}\n";
        let path = write_jsonl(tmp.path(), SID, content, BASE_SEC);
        let mut bytes = fs::read(&path).unwrap();
        bytes.extend_from_slice(&"日本語".as_bytes()[..4]);
        fs::write(&path, bytes).unwrap();
        let adapter = ClaudeProjectsAdapter::new(tmp.path().to_path_buf());
        assert_eq!(adapter.session_usage(CWD, SID).await.unwrap().session_tokens, 10);
    }

    #[test]
    fn subagent_totals_forget_a_directory_once_its_transcripts_are_gone() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("agent-a1.jsonl");
        fs::write(&path, agent_reply(700)).unwrap();
        let cache = Mutex::new(HashMap::new());
        assert_eq!(subagent_tokens_sync(tmp.path(), &cache), 700);
        assert_eq!(cache.lock().unwrap().len(), 1);

        fs::remove_file(&path).unwrap();
        assert_eq!(subagent_tokens_sync(tmp.path(), &cache), 0);
        assert!(cache.lock().unwrap().is_empty());
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
            transcript_title(&slices.head, 30),
            Some(TranscriptTitle::TypedPrompt("最初の依頼タイトル".to_string()))
        );
        let ev = last_user_or_assistant_event(&slices.tail).expect("tail event");
        assert_eq!(ev.kind, TranscriptKind::User);
        assert!(!ev.interrupted);
    }

    fn read_title_once(path: &Path) -> Option<TranscriptTitle> {
        read_title_sync(path, 30, &Mutex::default())
    }

    fn append(path: &Path, text: &str) {
        let mut file = fs::OpenOptions::new().append(true).open(path).unwrap();
        std::io::Write::write_all(&mut file, text.as_bytes()).unwrap();
    }

    const AI_TITLE: &str = "{\"type\":\"ai-title\",\"aiTitle\":\"要約タイトル\"}\n";

    #[test]
    fn title_survives_a_first_line_larger_than_the_slice_cap() {
        let tmp = tempfile::tempdir().unwrap();
        let meta: String = (0..80)
            .map(|_| format!("{{\"type\":\"summary\",\"summary\":\"{}\"}}\n", "s".repeat(180)))
            .collect();
        let image = "A".repeat(200 * 1024);
        let first_user = format!(
            "{{\"type\":\"user\",\"message\":{{\"content\":[{{\"type\":\"text\",\"text\":\"状態の正当性を確認\"}},{{\"type\":\"image\",\"source\":{{\"data\":\"{image}\"}}}}]}}}}"
        );
        let path = write_jsonl(tmp.path(), SID, &format!("{meta}{first_user}\n"), BASE_SEC);

        let head = read_slices_sync(&path, 64 * 1024, BASE_SEC * 1000)
            .unwrap()
            .head;
        assert_eq!(transcript_title(&head, 30), None);

        assert_eq!(
            read_title_once(&path),
            Some(TranscriptTitle::TypedPrompt("状態の正当性を確認".to_string()))
        );
    }

    #[tokio::test]
    async fn read_title_missing_transcript_is_none() {
        let tmp = tempfile::tempdir().unwrap();
        let adapter = ClaudeProjectsAdapter::new(tmp.path().to_path_buf());
        assert!(adapter.read_title(CWD, SID, 30).await.is_none());
    }

    #[test]
    fn title_reads_past_an_empty_first_user_utterance() {
        let tmp = tempfile::tempdir().unwrap();
        let content = "{\"type\":\"summary\",\"summary\":\"s\"}\n{\"type\":\"user\",\"message\":{\"content\":\"\"}}\n{\"type\":\"user\",\"message\":{\"content\":\"後の依頼\"}}\n";
        let path = write_jsonl(tmp.path(), SID, content, BASE_SEC);
        assert_eq!(
            read_title_once(&path),
            Some(TranscriptTitle::TypedPrompt("後の依頼".to_string()))
        );
    }

    #[test]
    fn a_later_pass_reads_only_the_appended_lines_and_picks_up_the_ai_title() {
        let tmp = tempfile::tempdir().unwrap();
        let path = write_jsonl(
            tmp.path(),
            SID,
            "{\"type\":\"user\",\"message\":{\"content\":\"最初の依頼\"}}\n",
            BASE_SEC,
        );
        let scans = Mutex::default();
        assert_eq!(
            read_title_sync(&path, 30, &scans),
            Some(TranscriptTitle::TypedPrompt("最初の依頼".to_string()))
        );

        append(&path, AI_TITLE);
        assert_eq!(
            read_title_sync(&path, 30, &scans),
            Some(TranscriptTitle::Ai("要約タイトル".to_string()))
        );
        assert!(scans.lock().unwrap().is_empty(), "a settled transcript is not tracked any further");
    }

    #[test]
    fn a_line_still_being_written_is_read_once_it_is_complete() {
        let tmp = tempfile::tempdir().unwrap();
        let (written, rest) = AI_TITLE.split_at(20);
        let path = write_jsonl(tmp.path(), SID, written, BASE_SEC);
        let scans = Mutex::default();
        assert_eq!(read_title_sync(&path, 30, &scans), None);

        append(&path, rest);
        assert_eq!(
            read_title_sync(&path, 30, &scans),
            Some(TranscriptTitle::Ai("要約タイトル".to_string()))
        );
    }

    #[test]
    fn a_transcript_shorter_than_the_saved_offset_is_scanned_again_from_the_start() {
        let tmp = tempfile::tempdir().unwrap();
        let long_prompt = format!(
            "{{\"type\":\"user\",\"message\":{{\"content\":\"{}\"}}}}\n",
            "長".repeat(200)
        );
        let path = write_jsonl(tmp.path(), SID, &long_prompt, BASE_SEC);
        let scans = Mutex::default();
        read_title_sync(&path, 30, &scans);

        fs::write(&path, AI_TITLE).unwrap();
        assert_eq!(
            read_title_sync(&path, 30, &scans),
            Some(TranscriptTitle::Ai("要約タイトル".to_string()))
        );
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
    fn subagent_transcripts_name_their_agent_and_mtime_age() {
        let tmp = tempfile::tempdir().unwrap();
        let sub_sid = "11111111-2222-3333-4444-555555555555";
        write_subagent(tmp.path(), sub_sid, "agent-aaa.jsonl", BASE_SEC);
        write_subagent(tmp.path(), sub_sid, "agent-bbb.jsonl", BASE_SEC - 120);
        let dir = tmp.path().join(PROJ_DIR).join(sub_sid).join("subagents");
        let mut found = subagent_transcripts_sync(&dir, BASE_SEC * 1000);
        found.sort_by(|a, b| a.age_sec.partial_cmp(&b.age_sec).unwrap());
        assert_eq!(
            found,
            vec![
                SubagentTranscript { agent_id: "aaa".to_string(), age_sec: 0.0 },
                SubagentTranscript { agent_id: "bbb".to_string(), age_sec: 120.0 },
            ]
        );
    }

    #[test]
    fn subagent_transcripts_ignore_non_agent_jsonl_files() {
        let tmp = tempfile::tempdir().unwrap();
        let sid = "22222222-2222-3333-4444-555555555555";
        write_subagent(tmp.path(), sid, "agent-aaa.jsonl", BASE_SEC);
        write_subagent(tmp.path(), sid, "agent-aaa.meta.json", BASE_SEC);
        write_subagent(tmp.path(), sid, "note.txt", BASE_SEC);
        let dir = tmp.path().join(PROJ_DIR).join(sid).join("subagents");
        let found = subagent_transcripts_sync(&dir, BASE_SEC * 1000);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].agent_id, "aaa");
    }

    #[test]
    fn subagent_transcripts_missing_dir_is_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp
            .path()
            .join(PROJ_DIR)
            .join("99999999-0000-0000-0000-000000000000")
            .join("subagents");
        assert!(subagent_transcripts_sync(&dir, BASE_SEC * 1000).is_empty());
    }

    #[tokio::test]
    async fn adapter_reads_slices_through_async_wrapper() {
        let tmp = tempfile::tempdir().unwrap();
        write_jsonl(tmp.path(), SID, "{\"type\":\"user\"}\n", BASE_SEC);
        let adapter = ClaudeProjectsAdapter {
            root_dir: tmp.path().to_path_buf(),
            subagent_totals: SubagentTotals::default(),
            title_scans: TitleScans::default(),
            max_slice_bytes: 64 * 1024,
            now_ms: Box::new(|| (BASE_SEC + 3) * 1000),
        };
        let slices = adapter.read_slices(CWD, SID).await.unwrap();
        assert_eq!(slices.mtime_age_sec, 3.0);
        assert!(adapter.subagent_transcripts(CWD, SID).await.is_empty());
    }
}
