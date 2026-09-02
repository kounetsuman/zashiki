use std::process::Command;

fn main() {
    embed_git_sha();
    // Autogenerate the ACL permission for the open_devtools app command so a capability can grant the
    // remote-loaded frontend access to it (a plain tauri_build::build() would not emit it).
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["open_devtools"])),
    )
    .expect("failed to run tauri-build");
}

/// Embeds the same value as the server's build.rs as `ZK_GIT_SHA`. In the distributed .app,
/// the server and desktop are built from the same commit, so this value matching healthz's
/// `git_sha` means the running server belongs to the current build.
fn embed_git_sha() {
    println!("cargo:rerun-if-env-changed=ZK_GIT_SHA");
    emit_git_rerun_paths();
    let sha = git_sha().unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=ZK_GIT_SHA={sha}");
}

/// Emits `rerun-if-changed` so build.rs re-runs when HEAD moves.
/// In a worktree, `.git` is not a directory but a file pointing via `gitdir:`, so the fixed
/// `../../../.git/HEAD` cannot be resolved and the SHA gets stuck. Query the real path from
/// `git rev-parse --git-path` so HEAD/logs are watched correctly even in a worktree. When git is
/// absent, emit nothing (this re-runs every time, but the SHA falls back to "unknown" on the safe side).
fn emit_git_rerun_paths() {
    for arg in ["HEAD", "logs/HEAD"] {
        if let Some(path) = git_path(arg) {
            println!("cargo:rerun-if-changed={path}");
        }
    }
}

/// Resolves the real file path via `git rev-parse --git-path <arg>` (worktree-aware).
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
    let out = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .output()
        .ok()?;
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
