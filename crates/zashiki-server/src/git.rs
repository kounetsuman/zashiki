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

// ---- git execution ----
//
// Every git process starts from `git_base`: no shell, `core.quotepath=false`,
// `GIT_LITERAL_PATHSPECS=1` (file arguments always follow `--`, so pathspec magic such as a
// leading `:` or `*` globs never widens "that one file"), and `core.fsmonitor=false`.
//
// Commands Zashiki runs without the user asking for a repo change (status, diff view) go through
// `ReadOnlyGit`, which also refuses every other program a repo's own config can name. Write
// commands (stage, commit, worktree remove) keep the repo's hooks and filters: they are explicit
// user actions, and skipping a clean filter there would stage the wrong content.

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

fn git_base(path: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(path)
        .args(["-c", "core.quotepath=false", "-c", "core.fsmonitor=false"])
        .env("GIT_LITERAL_PATHSPECS", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd
}

fn git_command(path: &Path, args: &[&str]) -> Command {
    let mut cmd = git_base(path);
    cmd.args(args);
    cmd
}

/// Config that makes a read-only command skip the repo's hooks (no index write can fire
/// `post-index-change`) and signature verification through its `gpg.program`.
const READ_ONLY_CONFIG: [&str; 4] = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "log.showSignature=false",
];

/// `args` with `--no-ext-diff --no-textconv` after a `diff`/`show`/`log` subcommand, so a diff
/// driver or textconv named by the repo's `.gitattributes` never runs.
fn read_only_args<'a>(args: &[&'a str]) -> Vec<&'a str> {
    let mut out = args.to_vec();
    if matches!(args.first(), Some(&("diff" | "show" | "log"))) {
        out.splice(1..1, ["--no-ext-diff", "--no-textconv"]);
    }
    out
}

/// Disabling overrides for every filter driver and config-defined hook that comes from outside
/// the user's own system/global config, from `git config --list --show-scope -z`. Names are
/// matched as bytes because git allows any bytes in a subsection name. An empty
/// `clean`/`smudge`/`process` disables that filter step, `required=false` keeps git from
/// failing, and `enabled=false` turns a `hook.<name>` off.
fn repo_config_overrides(listing: &[u8]) -> Vec<(Vec<u8>, &'static str)> {
    let mut drivers: Vec<&[u8]> = Vec::new();
    let mut hooks: Vec<&[u8]> = Vec::new();
    let mut fields = listing.split(|&b| b == 0);
    while let (Some(scope), Some(entry)) = (fields.next(), fields.next()) {
        if matches!(scope, b"system" | b"global") {
            continue;
        }
        let key = entry.split(|&b| b == b'\n').next().unwrap_or_default();
        let (names, rest) = if let Some(rest) = key.strip_prefix(b"filter.") {
            (&mut drivers, rest)
        } else if let Some(rest) = key.strip_prefix(b"hook.") {
            (&mut hooks, rest)
        } else {
            continue;
        };
        if let Some(dot) = rest.iter().rposition(|&b| b == b'.') {
            let name = &rest[..dot];
            if !names.contains(&name) {
                names.push(name);
            }
        }
    }
    let key = |section: &[u8], name: &[u8], var: &[u8]| {
        [section, b".", name, b".", var].concat()
    };
    let filter_overrides = drivers.into_iter().flat_map(|d| {
        [
            (key(b"filter", d, b"clean"), ""),
            (key(b"filter", d, b"smudge"), ""),
            (key(b"filter", d, b"process"), ""),
            (key(b"filter", d, b"required"), "false"),
        ]
    });
    let hook_overrides = hooks
        .into_iter()
        .map(|h| (key(b"hook", h, b"enabled"), "false"));
    filter_overrides.chain(hook_overrides).collect()
}

#[cfg(unix)]
fn os_string(bytes: Vec<u8>) -> std::ffi::OsString {
    use std::os::unix::ffi::OsStringExt;
    std::ffi::OsString::from_vec(bytes)
}

#[cfg(not(unix))]
fn os_string(bytes: Vec<u8>) -> std::ffi::OsString {
    String::from_utf8_lossy(&bytes).into_owned().into()
}

/// git for commands Zashiki runs on a repo by itself, which must not execute any program the
/// repo's own config names. Config overrides go through `GIT_CONFIG_KEY_n` rather than `-c`
/// because a driver or hook name may contain `=`, which `-c` would split on.
struct ReadOnlyGit<'a> {
    path: &'a Path,
    config_overrides: Vec<(std::ffi::OsString, &'static str)>,
}

impl<'a> ReadOnlyGit<'a> {
    async fn open(path: &'a Path) -> Self {
        let listing = git_command(path, &["config", "--list", "--show-scope", "-z"])
            .output()
            .await
            .map(|o| o.stdout)
            .unwrap_or_default();
        Self {
            path,
            config_overrides: repo_config_overrides(&listing)
                .into_iter()
                .map(|(key, value)| (os_string(key), value))
                .collect(),
        }
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut cmd = git_base(self.path);
        cmd.args(READ_ONLY_CONFIG)
            .args(read_only_args(args))
            .env("GIT_OPTIONAL_LOCKS", "0");
        let inherited: usize = std::env::var("GIT_CONFIG_COUNT")
            .ok()
            .and_then(|n| n.parse().ok())
            .unwrap_or(0);
        for (i, (key, value)) in self.config_overrides.iter().enumerate() {
            let n = inherited + i;
            cmd.env(format!("GIT_CONFIG_KEY_{n}"), key)
                .env(format!("GIT_CONFIG_VALUE_{n}"), value);
        }
        if !self.config_overrides.is_empty() {
            cmd.env(
                "GIT_CONFIG_COUNT",
                (inherited + self.config_overrides.len()).to_string(),
            );
        }
        cmd
    }

    /// stdout even on a non-zero exit (`git diff --no-index` exits non-zero when the files
    /// differ); empty on spawn failure.
    async fn stdout(&self, args: &[&str]) -> String {
        self.command(args)
            .output()
            .await
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .unwrap_or_default()
    }
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
    match ReadOnlyGit::open(path)
        .await
        .command(&["diff", "--cached", "--quiet"])
        .output()
        .await
    {
        Ok(output) => !output.status.success(),
        Err(_) => false,
    }
}

/// The byte size of a blob addressed as `<rev>:<file>` (e.g. `HEAD:app.ts`, `:app.ts`), or 0 when
/// the object is absent (a new file at HEAD, a staged-deleted file in the index).
async fn blob_size(git: &ReadOnlyGit<'_>, spec: &str) -> u64 {
    git.stdout(&["cat-file", "-s", spec])
        .await
        .trim()
        .parse()
        .unwrap_or(0)
}

/// The text of a blob addressed as `<rev>:<file>`, or empty when the object is absent.
async fn show_blob(git: &ReadOnlyGit<'_>, spec: &str) -> String {
    git.stdout(&["show", spec]).await
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
    let git = ReadOnlyGit::open(path).await;
    let (added, removed, binary) = parse_numstat(&git.stdout(&numstat_args).await);
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
                Some(rev) => blob_size(&git, &format!("{rev}:{file}")).await,
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
                blob_size(&git, &format!(":{file}")).await
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
                Some(rev) => show_blob(&git, &format!("{rev}:{file}")).await,
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
                show_blob(&git, &format!(":{file}")).await
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
async fn resolve_branch(git: &ReadOnlyGit<'_>) -> String {
    let current = git.stdout(&["branch", "--show-current"]).await;
    let current = current.trim();
    if !current.is_empty() {
        return current.to_string();
    }
    git.stdout(&["rev-parse", "--short", "HEAD"])
        .await
        .trim()
        .to_string()
}

/// The committer date of HEAD (ISO 8601), or empty for a repo with no commits.
async fn last_commit_iso(git: &ReadOnlyGit<'_>) -> String {
    git.stdout(&["log", "-1", "--format=%cI"])
        .await
        .trim()
        .to_string()
}

async fn build_repo_status(r: ScannedRepo) -> RepoStatus {
    let path = Path::new(&r.path);
    // Awaited in series, not joined: one git process per held permit keeps STATUS_CONCURRENCY an exact process cap.
    let git = ReadOnlyGit::open(path).await;
    let branch = resolve_branch(&git).await;
    let raw = git.stdout(&["status", "--porcelain=v1"]).await;
    let last_commit = last_commit_iso(&git).await;
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

    /// Writes an executable `/bin/sh` script at `dir/name` that appends `name` to `marker` and passes
    /// stdin through, so it can stand in for any program a repo's config points git at.
    #[cfg(unix)]
    fn marker_script(dir: &Path, name: &str, marker: &Path) -> String {
        use std::os::unix::fs::PermissionsExt;
        let script = dir.join(name);
        std::fs::write(
            &script,
            format!("#!/bin/sh\necho {name} >> '{}'\ncat\n", marker.display()),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        script.to_string_lossy().into_owned()
    }

    /// A repo whose own `.git/config` and `.git/info/attributes` point every program-running key
    /// (fsmonitor, clean/smudge/process filters, diff driver, textconv, hooks) at marker scripts.
    #[cfg(unix)]
    struct HostileRepo {
        _dir: tempfile::TempDir,
        repo: std::path::PathBuf,
        marker: std::path::PathBuf,
    }

    #[cfg(unix)]
    impl HostileRepo {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let repo = dir.path().join("repo");
            let bin = dir.path().join("bin");
            std::fs::create_dir_all(&repo).unwrap();
            std::fs::create_dir_all(&bin).unwrap();
            let marker = dir.path().join("marker");
            init_repo(&repo);

            for (key, name) in [
                ("core.fsmonitor", "fsmonitor"),
                ("filter.evil.clean", "clean"),
                ("filter.evil.smudge", "smudge"),
                ("diff.evil.command", "external-diff"),
                ("diff.evil.textconv", "textconv"),
            ] {
                let script = marker_script(&bin, name, &marker);
                git(&repo, &["config", key, &script]);
            }
            let hooks = repo.join(".git/hooks");
            std::fs::create_dir_all(&hooks).unwrap();
            marker_script(&hooks, "post-index-change", &marker);
            let config_hook = marker_script(&bin, "config-hook", &marker);
            git(&repo, &["config", "hook.evil.command", &config_hook]);
            git(&repo, &["config", "hook.evil.event", "post-index-change"]);
            std::fs::write(
                repo.join(".git/info/attributes"),
                "* filter=evil diff=evil\n",
            )
            .unwrap();
            // Same content, older mtime: the index entry is stat-dirty but not racy, so git
            // re-reads the file and would refresh the index entry.
            std::fs::write(repo.join("base.txt"), "base\n").unwrap();
            std::fs::File::options()
                .write(true)
                .open(repo.join("base.txt"))
                .unwrap()
                .set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(60))
                .unwrap();
            std::fs::write(repo.join("untracked.txt"), "u\n").unwrap();
            Self {
                _dir: dir,
                repo,
                marker,
            }
        }

        fn forget(&self) {
            let _ = std::fs::remove_file(&self.marker);
        }

        fn ran(&self) -> String {
            std::fs::read_to_string(&self.marker).unwrap_or_default()
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn periodic_status_runs_no_program_from_repo_config() {
        let h = HostileRepo::new();

        let status = build_repo_status(ScannedRepo {
            org: "o".to_string(),
            repo: "r".to_string(),
            path: h.repo.to_string_lossy().into_owned(),
            is_worktree: false,
        })
        .await;

        assert_eq!(h.ran(), "");
        assert_eq!(status.branch, "main");
        assert!(status.changed.iter().any(|e| e.path == "untracked.txt"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn read_only_git_disables_a_filter_whose_name_is_not_utf8() {
        use std::io::Write;
        let h = HostileRepo::new();
        let script = marker_script(h.repo.parent().unwrap(), "raw-clean", &h.marker);
        let mut config = std::fs::OpenOptions::new()
            .append(true)
            .open(h.repo.join(".git/config"))
            .unwrap();
        config.write_all(b"[filter \"\xff\"]\n\tclean = ").unwrap();
        config.write_all(script.as_bytes()).unwrap();
        config.write_all(b"\n").unwrap();
        std::fs::write(h.repo.join(".git/info/attributes"), b"* filter=\xff\n").unwrap();

        build_repo_status(ScannedRepo {
            org: "o".to_string(),
            repo: "r".to_string(),
            path: h.repo.to_string_lossy().into_owned(),
            is_worktree: false,
        })
        .await;
        diff(&h.repo, "base.txt", false, false).await;
        diff(&h.repo, "untracked.txt", false, true).await;

        assert_eq!(h.ran(), "");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn periodic_status_does_not_verify_signatures_with_repo_gpg_program() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("repo");
        std::fs::create_dir_all(&p).unwrap();
        init_repo(&p);
        let marker = dir.path().join("marker");
        let gpg = dir.path().join("gpg");
        std::fs::write(
            &gpg,
            format!(
                "#!/bin/sh\ncase \"$*\" in\n*--verify*) echo verify >> '{}' ;;\n*) cat >/dev/null; printf '\\n[GNUPG:] SIG_CREATED D\\n' >&2; printf -- '-----BEGIN PGP SIGNATURE-----\\nAAAA\\n-----END PGP SIGNATURE-----\\n' ;;\nesac\n",
                marker.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&gpg, std::fs::Permissions::from_mode(0o755)).unwrap();
        let gpg = gpg.to_string_lossy().into_owned();
        git(&p, &["config", "gpg.program", &gpg]);
        git(&p, &["commit", "-q", "-S", "--allow-empty", "-m", "signed"]);
        git(&p, &["config", "log.showSignature", "true"]);

        let status = build_repo_status(ScannedRepo {
            org: "o".to_string(),
            repo: "r".to_string(),
            path: p.to_string_lossy().into_owned(),
            is_worktree: false,
        })
        .await;

        assert_eq!(std::fs::read_to_string(&marker).unwrap_or_default(), "");
        assert!(!status.last_commit.is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn diff_runs_no_program_from_repo_config() {
        let h = HostileRepo::new();
        let stat_dirty = diff(&h.repo, "base.txt", false, false).await;
        assert_eq!(h.ran(), "");
        assert_eq!((stat_dirty.added, stat_dirty.removed), (0, 0));

        std::fs::write(h.repo.join("staged.txt"), "s\n").unwrap();
        git(&h.repo, &["-c", "filter.evil.clean=cat", "add", "staged.txt"]);
        std::fs::write(h.repo.join("base.txt"), "base\nagain\n").unwrap();
        h.forget();

        let changed = diff(&h.repo, "base.txt", false, false).await;
        let staged = diff(&h.repo, "staged.txt", true, false).await;
        let untracked = diff(&h.repo, "untracked.txt", false, true).await;
        let has = has_staged(&h.repo).await;

        assert_eq!(h.ran(), "");
        assert_eq!(changed.new_text, "base\nagain\n");
        assert_eq!(staged.new_text, "s\n");
        assert_eq!(untracked.added, 1);
        assert!(has);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stage_still_applies_the_repo_clean_filter() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        init_repo(p);
        git(p, &["config", "filter.upper.clean", "tr a-z A-Z"]);
        std::fs::write(p.join(".git/info/attributes"), "*.txt filter=upper\n").unwrap();
        std::fs::write(p.join("note.txt"), "quiet\n").unwrap();

        stage(p, "note.txt").await.unwrap();

        let blob = std::process::Command::new("git")
            .arg("-C")
            .arg(p)
            .args(["show", ":note.txt"])
            .output()
            .unwrap()
            .stdout;
        assert_eq!(String::from_utf8_lossy(&blob), "QUIET\n");
    }

    #[test]
    fn read_only_args_disable_external_diff_and_textconv_for_diff_like_commands() {
        assert_eq!(
            read_only_args(&["diff", "--numstat", "--", "a"]),
            vec!["diff", "--no-ext-diff", "--no-textconv", "--numstat", "--", "a"]
        );
        assert_eq!(
            read_only_args(&["show", "HEAD:a"]),
            vec!["show", "--no-ext-diff", "--no-textconv", "HEAD:a"]
        );
        assert_eq!(
            read_only_args(&["log", "-1", "--format=%cI"]),
            vec!["log", "--no-ext-diff", "--no-textconv", "-1", "--format=%cI"]
        );
        assert_eq!(
            read_only_args(&["branch", "--show-current"]),
            vec!["branch", "--show-current"]
        );
    }

    #[test]
    fn repo_config_overrides_disable_only_filters_and_hooks_the_repo_itself_defines() {
        let listing: &[u8] = b"global\0filter.lfs.process\ngit-lfs filter-process\0\
                       local\0core.bare\nfalse\0\
                       local\0filter.evil.clean\n/x/clean\0\
                       local\0filter.evil.smudge\n/x/smudge\0\
                       worktree\0filter.a=b.c.process\n/x/p\0\
                       local\0filter.evil.required\ntrue\0\
                       local\0filter.\xff.clean\n/x/raw\0\
                       system\0filter.sys.clean\nsys\0\
                       local\0hook.lint.command\n/x/h\0\
                       local\0hook.lint.event\npost-index-change\0\
                       global\0hook.mine.command\n/x/mine\0";
        let overrides = repo_config_overrides(listing);
        let keys: Vec<&[u8]> = overrides.iter().map(|(k, _)| k.as_slice()).collect();
        let expected: Vec<&[u8]> = vec![
            b"filter.evil.clean",
            b"filter.evil.smudge",
            b"filter.evil.process",
            b"filter.evil.required",
            b"filter.a=b.c.clean",
            b"filter.a=b.c.smudge",
            b"filter.a=b.c.process",
            b"filter.a=b.c.required",
            b"filter.\xff.clean",
            b"filter.\xff.smudge",
            b"filter.\xff.process",
            b"filter.\xff.required",
            b"hook.lint.enabled",
        ];
        assert_eq!(keys, expected);
        assert!(overrides.iter().all(|(k, v)| *v
            == if k.ends_with(b".required") || k.ends_with(b".enabled") {
                "false"
            } else {
                ""
            }));
    }
}
