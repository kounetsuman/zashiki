//! Implementation behind `GET /api/git/status`.
//! It only runs git (branch/porcelain); parsing the porcelain output reuses
//! `zashiki_core::git::parse_git_status` (an example of wiring core + server together).

use std::path::Path;
use std::process::Stdio;
use std::sync::{Arc, OnceLock};

use serde::Serialize;
use tokio::process::Command;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::repos::ScannedRepo;

/// Max git processes run at once for status scans (bounded by [`status_semaphore`]).
const STATUS_CONCURRENCY: usize = 8;

/// Process-wide status-scan budget, shared by every concurrent `GET /api/git/status`.
fn status_semaphore() -> Arc<Semaphore> {
    static SEM: OnceLock<Arc<Semaphore>> = OnceLock::new();
    SEM.get_or_init(|| Arc::new(Semaphore::new(STATUS_CONCURRENCY)))
        .clone()
}

/// Response for `GET /api/git/status` (`GitStatusResponse`).
#[derive(Serialize)]
pub struct GitStatusResponse {
    pub repos: Vec<RepoStatus>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub org: String,
    pub repo: String,
    pub path: String,
    pub branch: String,
    pub is_worktree: bool,
    /// Committer date of HEAD (ISO 8601), or empty when the repo has no commits.
    pub last_commit: String,
    pub staged: Vec<GitFileEntry>,
    pub changed: Vec<GitFileEntry>,
}

#[derive(Serialize)]
pub struct GitFileEntry {
    pub code: String,
    pub path: String,
}

/// Response for `POST /api/git/diff`. Carries the two file versions so the client can render both
/// unified and split via CodeMirror's merge view. `oldText`/`newText` are empty when `binary` or
/// `tooLarge`, both of which are decided before either body is loaded.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffPayload {
    pub old_text: String,
    pub new_text: String,
    pub binary: bool,
    pub too_large: bool,
    pub added: u32,
    pub removed: u32,
}

/// Upper bound on either side's blob size (bytes) before a diff is refused as too large.
const DIFF_MAX_BYTES: u64 = 5 * 1024 * 1024;
/// Upper bound on added+removed lines before a diff is refused as too large.
const DIFF_MAX_LINES: u32 = 20_000;

impl From<zashiki_core::git::GitFileEntry> for GitFileEntry {
    fn from(e: zashiki_core::git::GitFileEntry) -> Self {
        GitFileEntry {
            code: e.code,
            path: e.path,
        }
    }
}

/// The stdout of `git -C <path> <args...>` (empty string on failure or non-UTF8; not via a shell).
async fn git_output(path: &Path, args: &[&str]) -> String {
    Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .await
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default()
}

// ---- Write-side git execution ----
//
// We execute without a shell, with `core.quotepath=false` and
// `GIT_LITERAL_PATHSPECS=1`. File arguments are always passed after `--`, disabling
// pathspec magic (leading `:`, `*` globs) to guarantee "that one file only".

/// Timeout for commit (so it doesn't hang even while a GPG signing tool is locked).
const COMMIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// A git execution failure (non-zero exit or spawn failure).
#[derive(Debug)]
pub struct GitError {
    pub stderr: String,
}

impl std::fmt::Display for GitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "git failed: {}", self.stderr.trim())
    }
}

impl std::error::Error for GitError {}

fn git_command(path: &Path, args: &[&str]) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(path)
        .arg("-c")
        .arg("core.quotepath=false")
        .args(args)
        .env("GIT_LITERAL_PATHSPECS", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd
}

/// Run `git` without passing stdin; on a non-zero exit, return a `GitError` carrying stderr.
async fn run_git(path: &Path, args: &[&str]) -> Result<(), GitError> {
    let output = git_command(path, args)
        .output()
        .await
        .map_err(|e| GitError {
            stderr: e.to_string(),
        })?;
    if output.status.success() {
        Ok(())
    } else {
        Err(GitError {
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}

pub async fn stage(path: &Path, file: &str) -> Result<(), GitError> {
    run_git(path, &["add", "--", file]).await
}

pub async fn unstage(path: &Path, file: &str) -> Result<(), GitError> {
    run_git(path, &["reset", "-q", "--", file]).await
}

pub async fn stage_all(path: &Path) -> Result<(), GitError> {
    run_git(path, &["add", "."]).await
}

pub async fn unstage_all(path: &Path) -> Result<(), GitError> {
    run_git(path, &["reset", "-q", "--", "."]).await
}

/// Whether there is at least one staged change (a diff against the index). Used to reject empty commits early.
/// `diff --cached --quiet` exits non-zero when there is a diff -> true. No diff or a git error
/// (e.g. not a repo) falls to false, so before calling, guarantee that the repo is in the scanned
/// list (isAllowedRepo).
pub async fn has_staged(path: &Path) -> bool {
    match git_command(path, &["diff", "--cached", "--quiet"])
        .output()
        .await
    {
        Ok(output) => !output.status.success(),
        Err(_) => false,
    }
}

/// stdout of `git ...` under the hardened write-op env (`GIT_LITERAL_PATHSPECS=1`, `core.quotepath=false`),
/// keeping stdout even on a non-zero exit (`git diff --no-index` exits non-zero when the files differ).
async fn git_stdout(path: &Path, args: &[&str]) -> String {
    git_command(path, args)
        .output()
        .await
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default()
}

/// The byte size of a blob addressed as `<rev>:<file>` (e.g. `HEAD:app.ts`, `:app.ts`), or 0 when
/// the object is absent (a new file at HEAD, a staged-deleted file in the index).
async fn blob_size(path: &Path, spec: &str) -> u64 {
    git_stdout(path, &["cat-file", "-s", spec])
        .await
        .trim()
        .parse()
        .unwrap_or(0)
}

/// The text of a blob addressed as `<rev>:<file>`, or empty when the object is absent.
async fn show_blob(path: &Path, spec: &str) -> String {
    git_stdout(path, &["show", spec]).await
}

/// Worktree file text, read only when the file resolves inside the repo. A symlink escaping the repo
/// yields empty rather than following it, so a diff never discloses an out-of-repo file's contents
/// (git's own diff never follows symlinks either; this guards our direct read).
fn read_worktree_within_repo(repo: &Path, file: &str) -> String {
    let (Ok(real), Ok(repo_real)) = (
        std::fs::canonicalize(repo.join(file)),
        std::fs::canonicalize(repo),
    ) else {
        return String::new();
    };
    if !real.starts_with(&repo_real) {
        return String::new();
    }
    std::fs::read(&real)
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .unwrap_or_default()
}

/// Added/removed line counts from a single-path `--numstat`, plus whether git treats it as binary
/// (numstat prints `-\t-` for binary). Absent/no-change output yields `(0, 0, false)`.
fn parse_numstat(out: &str) -> (u32, u32, bool) {
    let Some(line) = out.lines().next() else {
        return (0, 0, false);
    };
    let mut cols = line.split('\t');
    let a = cols.next().unwrap_or("");
    let d = cols.next().unwrap_or("");
    if a == "-" || d == "-" {
        return (0, 0, true);
    }
    (a.parse().unwrap_or(0), d.parse().unwrap_or(0), false)
}

/// Diff for one file, returning the (old, new) versions to compare:
/// - untracked -> (empty, worktree file)
/// - staged    -> (HEAD blob, index blob)
/// - changed   -> (index blob, worktree file)
///
/// Binary and over-limit diffs are decided from `--numstat` and `cat-file -s` before either body is
/// read, so a huge file never has to be materialized to be refused.
pub async fn diff(path: &Path, file: &str, staged: bool, untracked: bool) -> DiffPayload {
    let numstat_args: Vec<&str> = if untracked {
        vec!["diff", "--no-index", "--numstat", "--", "/dev/null", file]
    } else if staged {
        vec!["diff", "--cached", "--numstat", "--", file]
    } else {
        vec!["diff", "--numstat", "--", file]
    };
    let (added, removed, binary) = parse_numstat(&git_stdout(path, &numstat_args).await);
    if binary {
        return DiffPayload {
            old_text: String::new(),
            new_text: String::new(),
            binary: true,
            too_large: false,
            added: 0,
            removed: 0,
        };
    }

    // The old side's rev token, joined as `<rev>:<file>`: "HEAD" -> HEAD:file, "" -> :file (index).
    let (old_spec, new_from_worktree) = if untracked {
        (None, true)
    } else if staged {
        (Some("HEAD"), false)
    } else {
        (Some(""), true)
    };
    let (old_size, new_size) = tokio::join!(
        async {
            match old_spec {
                Some(rev) => blob_size(path, &format!("{rev}:{file}")).await,
                None => 0,
            }
        },
        async {
            if new_from_worktree {
                tokio::fs::metadata(path.join(file))
                    .await
                    .map(|m| m.len())
                    .unwrap_or(0)
            } else {
                blob_size(path, &format!(":{file}")).await
            }
        },
    );
    if added.saturating_add(removed) > DIFF_MAX_LINES || old_size.max(new_size) > DIFF_MAX_BYTES {
        return DiffPayload {
            old_text: String::new(),
            new_text: String::new(),
            binary: false,
            too_large: true,
            added,
            removed,
        };
    }

    let (old_text, new_text) = tokio::join!(
        async {
            match old_spec {
                Some(rev) => show_blob(path, &format!("{rev}:{file}")).await,
                None => String::new(),
            }
        },
        async {
            if new_from_worktree {
                let (repo, f) = (path.to_path_buf(), file.to_string());
                tokio::task::spawn_blocking(move || read_worktree_within_repo(&repo, &f))
                    .await
                    .unwrap_or_default()
            } else {
                show_blob(path, &format!(":{file}")).await
            }
        },
    );
    DiffPayload {
        old_text,
        new_text,
        binary: false,
        too_large: false,
        added,
        removed,
    }
}

/// Commit the staged changes. The message is passed via `-F -` (stdin) so even a leading `-` is safe.
/// Times out after 15s so it doesn't hang while GPG signing is locked.
pub async fn commit(path: &Path, message: &str) -> Result<(), GitError> {
    use tokio::io::AsyncWriteExt;

    let mut cmd = git_command(path, &["commit", "-F", "-"]);
    cmd.stdin(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| GitError {
        stderr: e.to_string(),
    })?;
    if let Some(mut stdin) = child.stdin.take() {
        // A message-write failure (e.g. EPIPE) is caught by the non-zero exit on the wait side.
        let _ = stdin.write_all(message.as_bytes()).await;
        let _ = stdin.shutdown().await;
    }
    let output = match tokio::time::timeout(COMMIT_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => {
            return Err(GitError {
                stderr: e.to_string(),
            })
        }
        Err(_) => {
            return Err(GitError {
                stderr: "commit timed out".to_string(),
            })
        }
    };
    if output.status.success() {
        Ok(())
    } else {
        Err(GitError {
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}

/// The current branch, or the short SHA when HEAD is detached (`git branch --show-current` prints
/// nothing there). Keeps `branch` non-empty for a valid-but-headless repo so the client can show it.
async fn resolve_branch(path: &Path) -> String {
    let current = git_output(path, &["branch", "--show-current"]).await;
    let current = current.trim();
    if !current.is_empty() {
        return current.to_string();
    }
    git_output(path, &["rev-parse", "--short", "HEAD"])
        .await
        .trim()
        .to_string()
}

/// The committer date of HEAD (ISO 8601), or empty for a repo with no commits.
async fn last_commit_iso(path: &Path) -> String {
    git_output(path, &["log", "-1", "--format=%cI"])
        .await
        .trim()
        .to_string()
}

async fn build_repo_status(r: ScannedRepo) -> RepoStatus {
    let path = Path::new(&r.path);
    // Awaited in series, not joined: one git process per held permit keeps STATUS_CONCURRENCY an exact process cap.
    let branch = resolve_branch(path).await;
    let raw = git_output(path, &["--no-optional-locks", "status", "--porcelain=v1"]).await;
    let last_commit = last_commit_iso(path).await;
    let parsed = zashiki_core::git::parse_git_status(&raw);
    RepoStatus {
        org: r.org,
        repo: r.repo,
        path: r.path,
        branch,
        is_worktree: r.is_worktree,
        last_commit,
        staged: parsed.staged.into_iter().map(Into::into).collect(),
        changed: parsed.changed.into_iter().map(Into::into).collect(),
    }
}

/// Remove a linked worktree without `--force`, so git refuses a dirty worktree rather than
/// discarding uncommitted work; the explicit path argument bounds what is removed.
pub async fn remove_worktree(path: &Path) -> Result<(), GitError> {
    let path_str = path.to_string_lossy();
    run_git(path, &["worktree", "remove", "--", &path_str]).await
}

/// Runs `work` over `items` with at most `sem`'s permits in flight, returning results in input order.
async fn run_bounded<I, R, F, Fut>(items: Vec<I>, sem: Arc<Semaphore>, work: F) -> Vec<R>
where
    I: Send + 'static,
    R: Send + 'static,
    F: Fn(I) -> Fut + Send + Sync + Clone + 'static,
    Fut: std::future::Future<Output = R> + Send,
{
    let mut set = JoinSet::new();
    for (index, item) in items.into_iter().enumerate() {
        let sem = sem.clone();
        let work = work.clone();
        set.spawn(async move {
            let _permit = sem.acquire_owned().await.expect("semaphore not closed");
            (index, work(item).await)
        });
    }
    let mut indexed: Vec<(usize, R)> = Vec::new();
    while let Some(joined) = set.join_next().await {
        if let Ok(pair) = joined {
            indexed.push(pair);
        }
    }
    indexed.sort_by_key(|(i, _)| *i);
    indexed.into_iter().map(|(_, r)| r).collect()
}

/// Collect each repo's status under the process-wide concurrency cap, preserving input order.
pub async fn git_status(scanned: Vec<ScannedRepo>) -> Vec<RepoStatus> {
    run_bounded(scanned, status_semaphore(), build_repo_status).await
}

/// Body validation for `POST /api/git/open`. Does not open files whose symlink
/// points outside the repository. A realpath failure returns 404; resolving outside the repo returns 400; safe returns None.
pub fn reject_open_target(repo_path: &str, file: &str) -> Option<(axum::http::StatusCode, String)> {
    use axum::http::StatusCode;
    let (Ok(real), Ok(repo_real)) = (
        std::fs::canonicalize(Path::new(repo_path).join(file)),
        std::fs::canonicalize(repo_path),
    ) else {
        return Some((StatusCode::NOT_FOUND, "file not found".to_string()));
    };
    if real.starts_with(&repo_real) {
        None
    } else {
        Some((
            StatusCode::BAD_REQUEST,
            "file resolves outside the repo".to_string(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(dir: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            // Block global config (to avoid hangs waiting on gpgsign signing or a missing identity in CI).
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("run git");
        assert!(status.success(), "git {args:?} failed");
    }

    /// A throwaway repo that is init'd with an initial commit (identity and disabled signing fixed repo-locally).
    fn init_repo(p: &Path) {
        git(p, &["init", "-q", "-b", "main"]);
        git(p, &["config", "user.email", "test@example.com"]);
        git(p, &["config", "user.name", "zashiki test"]);
        git(p, &["config", "commit.gpgsign", "false"]);
        std::fs::write(p.join("base.txt"), "base\n").unwrap();
        git(p, &["add", "base.txt"]);
        git(p, &["commit", "-q", "-m", "init"]);
    }

    fn status_paths(p: &Path) -> (Vec<String>, Vec<String>) {
        let raw = std::process::Command::new("git")
            .arg("-C")
            .arg(p)
            .args(["status", "--porcelain=v1"])
            .output()
            .unwrap();
        let parsed =
            zashiki_core::git::parse_git_status(&String::from_utf8_lossy(&raw.stdout));
        (
            parsed.staged.into_iter().map(|e| e.path).collect(),
            parsed.changed.into_iter().map(|e| e.path).collect(),
        )
    }

    #[tokio::test]
    async fn stage_then_unstage_one_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        init_repo(p);
        std::fs::write(p.join("base.txt"), "modified\n").unwrap();

        stage(p, "base.txt").await.unwrap();
        assert!(status_paths(p).0.contains(&"base.txt".to_string()));
        unstage(p, "base.txt").await.unwrap();
        let (staged, changed) = status_paths(p);
        assert!(!staged.contains(&"base.txt".to_string()));
        assert!(changed.contains(&"base.txt".to_string()));
    }

    #[tokio::test]
    async fn stage_dash_prefixed_and_glob_literal() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        init_repo(p);
        std::fs::write(p.join("--force.txt"), "tricky\n").unwrap();
        // Even with a leading `-` it isn't treated as an option (thanks to the `--` separator).
        stage(p, "--force.txt").await.unwrap();
        assert!(status_paths(p).0.contains(&"--force.txt".to_string()));

        // `*` is not glob-expanded; since the literal `*` doesn't exist it fails and stages no other files.
        std::fs::write(p.join("victim.txt"), "stay\n").unwrap();
        assert!(stage(p, "*").await.is_err());
        assert!(!status_paths(p).0.contains(&"victim.txt".to_string()));
    }

    #[tokio::test]
    async fn stage_all_then_unstage_all() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        init_repo(p);
        std::fs::write(p.join("base.txt"), "modified\n").unwrap();
        std::fs::write(p.join("untracked.txt"), "new\n").unwrap();

        stage_all(p).await.unwrap();
        assert!(status_paths(p).1.is_empty());
        assert!(!status_paths(p).0.is_empty());
        unstage_all(p).await.unwrap();
        assert!(status_paths(p).0.is_empty());
        assert!(!status_paths(p).1.is_empty());
    }

    #[tokio::test]
    async fn commit_advances_head_and_has_staged_gate() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        init_repo(p);
        // When nothing is staged, has_staged=false (triggers a 409).
        assert!(!has_staged(p).await);

        std::fs::write(p.join("commit-me.txt"), "hello\n").unwrap();
        stage(p, "commit-me.txt").await.unwrap();
        assert!(has_staged(p).await);

        let before = std::process::Command::new("git")
            .arg("-C")
            .arg(p)
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap()
            .stdout;
        // A message with a leading `-` is passed safely via -F -.
        commit(p, "--amend looking message").await.unwrap();
        let after = std::process::Command::new("git")
            .arg("-C")
            .arg(p)
            .args(["rev-parse", "HEAD"])
            .output()
            .unwrap()
            .stdout;
        assert_ne!(before, after);
        let subject = std::process::Command::new("git")
            .arg("-C")
            .arg(p)
            .args(["log", "-1", "--pretty=%s"])
            .output()
            .unwrap()
            .stdout;
        assert_eq!(
            String::from_utf8_lossy(&subject).trim(),
            "--amend looking message"
        );
        assert!(!has_staged(p).await);
    }

    #[cfg(unix)]
    #[test]
    fn reject_open_target_blocks_escape_symlink_and_missing() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::write(repo.join("real.txt"), "x").unwrap();
        std::os::unix::fs::symlink("/etc/hosts", repo.join("sneaky")).unwrap();
        let repo_str = repo.to_string_lossy();

        assert!(reject_open_target(&repo_str, "real.txt").is_none());
        let (code, _) = reject_open_target(&repo_str, "sneaky").unwrap();
        assert_eq!(code, axum::http::StatusCode::BAD_REQUEST);
        let (code, _) = reject_open_target(&repo_str, "no-such.txt").unwrap();
        assert_eq!(code, axum::http::StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn git_status_reports_branch_staged_and_changed() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        git(p, &["init", "-q"]);
        git(p, &["checkout", "-q", "-b", "main"]);
        std::fs::write(p.join("staged.txt"), "s").unwrap();
        git(p, &["add", "staged.txt"]); // -> staged "A"
        std::fs::write(p.join("untracked.md"), "u").unwrap(); // -> changed "??"

        let scanned = vec![ScannedRepo {
            org: "org1".to_string(),
            repo: "repo-a".to_string(),
            path: p.to_string_lossy().into_owned(),
            is_worktree: false,
        }];
        let repos = git_status(scanned).await;

        assert_eq!(repos.len(), 1);
        let rs = &repos[0];
        assert_eq!(rs.org, "org1");
        assert_eq!(rs.repo, "repo-a");
        assert_eq!(rs.branch, "main");
        assert_eq!(rs.staged.len(), 1);
        assert_eq!(rs.staged[0].code, "A");
        assert_eq!(rs.staged[0].path, "staged.txt");
        assert!(rs
            .changed
            .iter()
            .any(|e| e.code == "??" && e.path == "untracked.md"));
    }

    #[tokio::test]
    async fn run_bounded_caps_concurrency_and_keeps_order() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let permits = 3;
        let sem = Arc::new(Semaphore::new(permits));
        let live = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));

        let out = run_bounded((0..50).collect::<Vec<usize>>(), sem, {
            let live = live.clone();
            let peak = peak.clone();
            move |n: usize| {
                let live = live.clone();
                let peak = peak.clone();
                async move {
                    let in_flight = live.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(in_flight, Ordering::SeqCst);
                    tokio::time::sleep(std::time::Duration::from_millis(2)).await;
                    live.fetch_sub(1, Ordering::SeqCst);
                    n * 2
                }
            }
        })
        .await;

        assert_eq!(out, (0..50).map(|n| n * 2).collect::<Vec<usize>>());
        assert!(
            peak.load(Ordering::SeqCst) <= permits,
            "peak {} exceeded cap {permits}",
            peak.load(Ordering::SeqCst)
        );
    }

    #[tokio::test]
    async fn git_status_preserves_input_order() {
        // Even with non-existent paths (git produces empty output), it doesn't fail and preserves input order.
        let scanned = (0..5)
            .map(|i| ScannedRepo {
                org: "o".to_string(),
                repo: format!("r{i}"),
                path: format!("/no/such/repo-{i}"),
                is_worktree: false,
            })
            .collect();
        let repos = git_status(scanned).await;
        let order: Vec<String> = repos.into_iter().map(|r| r.repo).collect();
        assert_eq!(order, vec!["r0", "r1", "r2", "r3", "r4"]);
    }

    #[tokio::test]
    async fn git_status_falls_back_to_short_sha_on_detached_head() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        init_repo(p);
        // Detached HEAD: `git branch --show-current` prints nothing, so branch must not be empty.
        git(p, &["checkout", "-q", "--detach"]);

        let scanned = vec![ScannedRepo {
            org: "o".to_string(),
            repo: "r".to_string(),
            path: p.to_string_lossy().into_owned(),
            is_worktree: false,
        }];
        let repos = git_status(scanned).await;

        let short_sha = String::from_utf8_lossy(
            &std::process::Command::new("git")
                .arg("-C")
                .arg(p)
                .args(["rev-parse", "--short", "HEAD"])
                .output()
                .unwrap()
                .stdout,
        )
        .trim()
        .to_string();
        assert!(!short_sha.is_empty());
        assert_eq!(repos[0].branch, short_sha);
    }

    /// Adds a linked worktree of `main` at `wt_path` on a new branch, returning the worktree path.
    fn add_worktree(main: &Path, wt_path: &Path, branch: &str) {
        git(
            main,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                branch,
                &wt_path.to_string_lossy(),
            ],
        );
    }

    #[tokio::test]
    async fn build_repo_status_reports_worktree_flag_and_last_commit() {
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join("main");
        std::fs::create_dir_all(&main).unwrap();
        init_repo(&main);
        let wt = dir.path().join("wt");
        add_worktree(&main, &wt, "feature");

        let main_status = build_repo_status(ScannedRepo {
            org: "o".to_string(),
            repo: "main".to_string(),
            path: main.to_string_lossy().into_owned(),
            is_worktree: false,
        })
        .await;
        assert!(!main_status.is_worktree);
        assert!(!main_status.last_commit.is_empty());

        let wt_status = build_repo_status(ScannedRepo {
            org: "o".to_string(),
            repo: "wt".to_string(),
            path: wt.to_string_lossy().into_owned(),
            is_worktree: true,
        })
        .await;
        assert!(wt_status.is_worktree);
        assert!(!wt_status.last_commit.is_empty());
    }

    #[tokio::test]
    async fn build_repo_status_empty_last_commit_before_first_commit() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        git(p, &["init", "-q", "-b", "main"]);

        let status = build_repo_status(ScannedRepo {
            org: "o".to_string(),
            repo: "r".to_string(),
            path: p.to_string_lossy().into_owned(),
            is_worktree: false,
        })
        .await;
        assert_eq!(status.last_commit, "");
    }

    #[test]
    fn repo_status_serializes_new_fields_in_camel_case() {
        let rs = RepoStatus {
            org: "o".to_string(),
            repo: "r".to_string(),
            path: "/p".to_string(),
            branch: "main".to_string(),
            is_worktree: true,
            last_commit: "2026-08-22T16:21:44+09:00".to_string(),
            staged: Vec::new(),
            changed: Vec::new(),
        };
        let json = serde_json::to_string(&rs).unwrap();
        assert!(json.contains(r#""isWorktree":true"#));
        assert!(json.contains(r#""lastCommit":"2026-08-22T16:21:44+09:00""#));
    }

    #[tokio::test]
    async fn remove_worktree_removes_clean_and_keeps_branch() {
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join("main");
        std::fs::create_dir_all(&main).unwrap();
        init_repo(&main);
        let wt = dir.path().join("wt");
        add_worktree(&main, &wt, "feature");
        assert!(wt.exists());

        remove_worktree(&wt).await.unwrap();
        assert!(!wt.exists());
        // The branch survives worktree removal.
        let branches = std::process::Command::new("git")
            .arg("-C")
            .arg(&main)
            .args(["branch", "--list", "feature"])
            .output()
            .unwrap()
            .stdout;
        assert!(String::from_utf8_lossy(&branches).contains("feature"));
    }

    #[tokio::test]
    async fn remove_worktree_refuses_dirty_without_force() {
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join("main");
        std::fs::create_dir_all(&main).unwrap();
        init_repo(&main);
        let wt = dir.path().join("wt");
        add_worktree(&main, &wt, "feature");
        std::fs::write(wt.join("dirty.txt"), "uncommitted\n").unwrap();

        let err = remove_worktree(&wt).await.unwrap_err();
        assert!(err.stderr.contains("use --force"));
        assert!(wt.exists());
    }

    #[tokio::test]
    async fn remove_worktree_refuses_main_working_tree() {
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join("main");
        std::fs::create_dir_all(&main).unwrap();
        init_repo(&main);

        let err = remove_worktree(&main).await.unwrap_err();
        assert!(err.stderr.contains("main working tree"));
        assert!(main.exists());
    }

    #[tokio::test]
    async fn diff_changed_modified_file_compares_index_to_worktree() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        init_repo(p);
        std::fs::write(p.join("base.txt"), "changed\n").unwrap();

        let d = diff(p, "base.txt", false, false).await;
        assert!(!d.binary && !d.too_large);
        assert_eq!(d.old_text, "base\n");
        assert_eq!(d.new_text, "changed\n");
        assert_eq!((d.added, d.removed), (1, 1));
    }

    #[tokio::test]
    async fn diff_staged_side_compares_head_to_index() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        init_repo(p);
        // A newly added file has no HEAD blob, so the old side is empty.
        std::fs::write(p.join("new.txt"), "hi\n").unwrap();
        git(p, &["add", "new.txt"]);

        let d = diff(p, "new.txt", true, false).await;
        assert_eq!(d.old_text, "");
        assert_eq!(d.new_text, "hi\n");
        assert_eq!(d.added, 1);
    }

    #[tokio::test]
    async fn diff_untracked_file_is_all_new() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        init_repo(p);
        std::fs::write(p.join("untracked.txt"), "u1\nu2\n").unwrap();

        let d = diff(p, "untracked.txt", false, true).await;
        assert_eq!(d.old_text, "");
        assert_eq!(d.new_text, "u1\nu2\n");
        assert_eq!(d.added, 2);
    }

    #[tokio::test]
    async fn diff_deleted_file_has_empty_new() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        init_repo(p);
        std::fs::remove_file(p.join("base.txt")).unwrap();

        let d = diff(p, "base.txt", false, false).await;
        assert_eq!(d.old_text, "base\n");
        assert_eq!(d.new_text, "");
        assert_eq!(d.removed, 1);
    }

    #[tokio::test]
    async fn diff_binary_untracked_sets_flag_without_bodies() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        init_repo(p);
        std::fs::write(p.join("blob.bin"), [0u8, 1, 2, 0, 255, 0]).unwrap();

        let d = diff(p, "blob.bin", false, true).await;
        assert!(d.binary);
        assert_eq!(d.old_text, "");
        assert_eq!(d.new_text, "");
    }

    #[tokio::test]
    async fn diff_over_line_limit_is_too_large_without_bodies() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        init_repo(p);
        std::fs::write(p.join("huge.txt"), "x\n".repeat((DIFF_MAX_LINES + 1) as usize)).unwrap();

        let d = diff(p, "huge.txt", false, true).await;
        assert!(d.too_large);
        assert_eq!(d.new_text, "");
    }

    #[tokio::test]
    async fn diff_counts_a_leading_colon_filename_via_literal_pathspecs() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        init_repo(p);
        // A leading `:` is pathspec magic unless GIT_LITERAL_PATHSPECS is set; the numstat must
        // still count the change rather than silently matching nothing.
        std::fs::write(p.join(":weird.txt"), "orig\n").unwrap();
        git(p, &["add", "-A"]);
        git(p, &["commit", "-q", "-m", "add colon file"]);
        std::fs::write(p.join(":weird.txt"), "changed\n").unwrap();

        let d = diff(p, ":weird.txt", false, false).await;
        assert_eq!((d.added, d.removed), (1, 1));
        assert_eq!(d.old_text, "orig\n");
        assert_eq!(d.new_text, "changed\n");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn diff_untracked_symlink_does_not_leak_outside_contents() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        init_repo(&repo);
        let secret = dir.path().join("secret.txt");
        std::fs::write(&secret, "TOP SECRET\n").unwrap();
        std::os::unix::fs::symlink(&secret, repo.join("link")).unwrap();

        let d = diff(&repo, "link", false, true).await;
        assert!(!d.new_text.contains("TOP SECRET"));
    }
}
