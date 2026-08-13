use std::process::Command;

/// Embed the git HEAD SHA as `ZK_GIT_SHA` at build time.
/// The desktop shell compares this value via healthz to avoid piggybacking on a
/// stale server. Outside a git checkout or when git is unavailable, an override
/// via the `ZK_GIT_SHA` env var is allowed, with a final fallback of "unknown".
fn main() {
    println!("cargo:rerun-if-env-changed=ZK_GIT_SHA");
    emit_git_rerun_paths();
    let sha = git_sha().unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=ZK_GIT_SHA={sha}");
}

/// Emit `rerun-if-changed` so build.rs re-runs when HEAD moves.
/// In a worktree, `.git` is a file pointing at a `gitdir:` rather than a directory,
/// so a fixed `../../.git/HEAD` cannot be resolved and the SHA gets stuck. Query the
/// real path via `git rev-parse --git-path` so HEAD/logs are watched correctly even in
/// a worktree. When git is unavailable, emit nothing (this forces a re-run every time,
/// but the SHA falls back to "unknown", which is safe).
fn emit_git_rerun_paths() {
    for arg in ["HEAD", "logs/HEAD"] {
        if let Some(path) = git_path(arg) {
            println!("cargo:rerun-if-changed={path}");
        }
    }
}

/// Resolve the real file path via `git rev-parse --git-path <arg>` (worktree-aware).
fn git_path(arg: &str) -> Option<String> {
    let out = Command::new("git")
        .args(["rev-parse", "--git-path", arg])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let path = String::from_utf8(out.stdout).ok()?.trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

fn git_sha() -> Option<String> {
    if let Ok(sha) = std::env::var("ZK_GIT_SHA") {
        let sha = sha.trim().to_string();
        if !sha.is_empty() {
            return Some(sha);
        }
    }
    let out = Command::new("git").args(["rev-parse", "HEAD"]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let sha = String::from_utf8(out.stdout).ok()?.trim().to_string();
    if sha.is_empty() {
        None
    } else {
        Some(sha)
    }
}
