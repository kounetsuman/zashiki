//! Implementation behind `GET /api/git/status` (ported from the TS `packages/server/src/git-routes.ts`).
//! It only runs git (branch/porcelain); parsing the porcelain output reuses the already-ported
//! `zashiki_core::git::parse_git_status` (an example of wiring core + server together).

use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;

use serde::Serialize;
use tokio::process::Command;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::repos::ScannedRepo;

/// Number of git processes to run concurrently (TS's STATUS_CONCURRENCY=8; guards against resource exhaustion).
const STATUS_CONCURRENCY: usize = 8;

/// Response for `GET /api/git/status` (TS: `GitStatusResponse` in `packages/shared/src/git.ts`).
#[derive(Serialize)]
pub struct GitStatusResponse {
    pub repos: Vec<RepoStatus>,
}

#[derive(Serialize)]
pub struct RepoStatus {
    pub org: String,
    pub repo: String,
    pub path: String,
    pub branch: String,
    pub staged: Vec<GitFileEntry>,
    pub changed: Vec<GitFileEntry>,
}

#[derive(Serialize)]
pub struct GitFileEntry {
    pub code: String,
    pub path: String,
}

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

// ---- Write-side git execution (ported from the TS `packages/server/src/infra/git.ts`) ----
//
// Like TS's `runGit`, we execute without a shell, with `core.quotepath=false` and
// `GIT_LITERAL_PATHSPECS=1`. File arguments are always passed after `--`, disabling
// pathspec magic (leading `:`, `*` globs) to guarantee "that one file only".

/// Timeout for commit (so it doesn't hang even while a GPG signing tool is locked. TS: 15s).
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
/// list (isAllowedRepo) (equivalent to TS `gitHasStaged`).
pub async fn has_staged(path: &Path) -> bool {
    match git_command(path, &["diff", "--cached", "--quiet"])
        .output()
        .await
    {
        Ok(output) => !output.status.success(),
        Err(_) => false,
    }
}

/// Commit the staged changes. The message is passed via `-F -` (stdin) so even a leading `-` is safe.
/// Times out after 15s so it doesn't hang while GPG signing is locked (TS: COMMIT_TIMEOUT_MS).
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

async fn build_repo_status(r: ScannedRepo) -> RepoStatus {
    let path = Path::new(&r.path);
    let (branch, raw) = tokio::join!(
        git_output(path, &["branch", "--show-current"]),
        git_output(path, &["status", "--porcelain=v1"]),
    );
    let parsed = zashiki_core::git::parse_git_status(&raw);
    RepoStatus {
        org: r.org,
        repo: r.repo,
        path: r.path,
        branch: branch.trim().to_string(),
        staged: parsed.staged.into_iter().map(Into::into).collect(),
        changed: parsed.changed.into_iter().map(Into::into).collect(),
    }
}

/// Collect each repo's status in parallel (up to 8) and return them preserving input order.
pub async fn git_status(scanned: Vec<ScannedRepo>) -> Vec<RepoStatus> {
    let sem = Arc::new(Semaphore::new(STATUS_CONCURRENCY));
    let mut set = JoinSet::new();
    for (index, repo) in scanned.into_iter().enumerate() {
        let sem = sem.clone();
        set.spawn(async move {
            let _permit = sem.acquire_owned().await.expect("semaphore not closed");
            (index, build_repo_status(repo).await)
        });
    }
    let mut indexed: Vec<(usize, RepoStatus)> = Vec::new();
    while let Some(joined) = set.join_next().await {
        if let Ok(pair) = joined {
            indexed.push(pair);
        }
    }
    indexed.sort_by_key(|(i, _)| *i);
    indexed.into_iter().map(|(_, rs)| rs).collect()
}

/// Body validation for `POST /api/git/open` (TS `rejectOpenTarget`). Does not open files whose symlink
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
    async fn git_status_preserves_input_order() {
        // Even with non-existent paths (git produces empty output), it doesn't fail and preserves input order.
        let scanned = (0..5)
            .map(|i| ScannedRepo {
                org: "o".to_string(),
                repo: format!("r{i}"),
                path: format!("/no/such/repo-{i}"),
            })
            .collect();
        let repos = git_status(scanned).await;
        let order: Vec<String> = repos.into_iter().map(|r| r.repo).collect();
        assert_eq!(order, vec!["r0", "r1", "r2", "r3", "r4"]);
    }
}
