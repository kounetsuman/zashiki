//! Implementation of `GET /api/fs/list`.
//! A read-only REST endpoint that enumerates a single level directly under a directory. Escapes out
//! of the repo (`..` / symlink) are rejected by `is_safe_repo_relative_path` (in zashiki-core)
//! plus realpath containment.

use std::io;
use std::path::{Path, PathBuf};

use axum::http::StatusCode;
use serde::Serialize;

/// Upper bound on entries returned for one directory (guards against DoS / rendering stalls from node_modules etc.).
pub const DEFAULT_ENTRY_LIMIT: usize = 2000;

/// Response for `GET /api/fs/list` (`FsListResponse`).
#[derive(Serialize)]
pub struct FsListResponse {
    pub entries: Vec<FsEntry>,
    pub truncated: bool,
}

#[derive(Serialize, Debug)]
pub struct FsEntry {
    pub name: String,
    /// Either `"dir"` or `"file"` (symlinks and non-directories count as file).
    pub kind: &'static str,
}

// ENOTDIR / ELOOP are not in stable ErrorKind, so pick them up via raw_os_error (works on both Linux and macOS).
const ENOTDIR: i32 = 20;
const ELOOP_LINUX: i32 = 40;
const ELOOP_MACOS: i32 = 62;

/// Maps fs errors to the error contract (404/400/403).
fn status_for_fs_error(e: &io::Error) -> (StatusCode, String) {
    let (code, msg) = match e.kind() {
        io::ErrorKind::NotFound => (StatusCode::NOT_FOUND, "directory not found"),
        io::ErrorKind::PermissionDenied => (StatusCode::FORBIDDEN, "permission denied"),
        _ => match e.raw_os_error() {
            Some(ENOTDIR) => (StatusCode::BAD_REQUEST, "not a directory"),
            Some(ELOOP_LINUX) | Some(ELOOP_MACOS) => {
                (StatusCode::BAD_REQUEST, "too many symbolic links")
            }
            _ => (StatusCode::INTERNAL_SERVER_ERROR, "fs error"),
        },
    };
    (code, msg.to_string())
}

/// Checks whether the resolved directory stays within the repo (realpath comparison; rejects escaping symlinks). Returns the real path if it does.
fn resolve_within_repo(repo_path: &str, dir: &str) -> Result<PathBuf, (StatusCode, String)> {
    let target = if dir.is_empty() {
        PathBuf::from(repo_path)
    } else {
        Path::new(repo_path).join(dir)
    };
    let real = std::fs::canonicalize(&target).map_err(|e| status_for_fs_error(&e))?;
    let repo_real = std::fs::canonicalize(repo_path).map_err(|e| status_for_fs_error(&e))?;
    // Path::starts_with matches per component, so /repo and /repository are not confused (equality also returns true).
    if real.starts_with(&repo_real) {
        Ok(real)
    } else {
        Err((
            StatusCode::BAD_REQUEST,
            "dir resolves outside the repo".to_string(),
        ))
    }
}

/// Enumerates entries directly under the real directory (excludes `.git`, does not follow symlinks for the kind, truncates at the limit).
fn list_dir(abs: &Path, limit: usize) -> io::Result<(Vec<FsEntry>, bool)> {
    let mut entries = Vec::new();
    let mut truncated = false;
    for dent in std::fs::read_dir(abs)? {
        let dent = dent?;
        let name = dent.file_name().to_string_lossy().into_owned();
        if name == ".git" {
            continue; // Do not enumerate internal metadata (other dotfiles are shown)
        }
        if entries.len() >= limit {
            truncated = true;
            break;
        }
        let kind = match dent.file_type() {
            Ok(ft) if ft.is_dir() => "dir",
            _ => "file",
        };
        entries.push(FsEntry { name, kind });
    }
    sort_fs_entries(&mut entries);
    Ok((entries, truncated))
}

/// Directories first, then by name (Intl.Collator is approximated by lowercasing).
fn sort_fs_entries(entries: &mut [FsEntry]) {
    let rank = |kind: &str| if kind == "dir" { 0 } else { 1 };
    entries.sort_by(|a, b| {
        rank(a.kind)
            .cmp(&rank(b.kind))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
}

/// Validates repoPath/dir and returns the immediate entries (blocking; callers run it via spawn_blocking).
pub fn list_within_repo(
    repo_path: &str,
    dir: &str,
    limit: usize,
) -> Result<(Vec<FsEntry>, bool), (StatusCode, String)> {
    let abs = resolve_within_repo(repo_path, dir)?;
    list_dir(&abs, limit).map_err(|e| status_for_fs_error(&e))
}

/// Splits an in-progress path input into (parent, prefix) for the org-add browse endpoint. A trailing
/// `/` lists that directory (empty prefix); otherwise the segment after the last `/` is the prefix to
/// match. An input with no `/` yields an empty parent (the caller treats that as "nothing to browse yet").
pub fn split_parent_prefix(input: &str) -> (String, String) {
    if let Some(stripped) = input.strip_suffix('/') {
        let parent = if stripped.is_empty() {
            "/".to_string()
        } else {
            stripped.to_string()
        };
        return (parent, String::new());
    }
    match input.rsplit_once('/') {
        Some((parent, name)) => {
            let parent = if parent.is_empty() {
                "/".to_string()
            } else {
                parent.to_string()
            };
            (parent, name.to_string())
        }
        None => (String::new(), input.to_string()),
    }
}

/// Enumerates the visible subdirectories of `abs` whose names start with `prefix` (case-insensitive).
/// Only directories are returned (an org root must be a directory), `.git` is excluded, and the result
/// is truncated at `limit`.
fn list_dirs_with_prefix(abs: &Path, prefix: &str, limit: usize) -> io::Result<(Vec<FsEntry>, bool)> {
    let mut entries = Vec::new();
    let mut truncated = false;
    let want = prefix.to_lowercase();
    for dent in std::fs::read_dir(abs)? {
        let dent = dent?;
        let name = dent.file_name().to_string_lossy().into_owned();
        if name == ".git" {
            continue;
        }
        if !dent.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue; // org roots are directories; symlinks/files never qualify
        }
        if !want.is_empty() && !name.to_lowercase().starts_with(&want) {
            continue;
        }
        if entries.len() >= limit {
            truncated = true;
            break;
        }
        entries.push(FsEntry { name, kind: "dir" });
    }
    sort_fs_entries(&mut entries);
    Ok((entries, truncated))
}

/// Lists subdirectories of `parent_abs` matching `prefix`, but only after confirming `parent_abs` really
/// resolves within one of `allowed_roots` (realpath comparison rejects escaping symlinks). Returns 403
/// when outside scope. Blocking; callers run it via spawn_blocking.
pub fn browse_dirs(
    parent_abs: &Path,
    allowed_roots: &[PathBuf],
    prefix: &str,
    limit: usize,
) -> Result<(Vec<FsEntry>, bool), (StatusCode, String)> {
    let real = std::fs::canonicalize(parent_abs).map_err(|e| status_for_fs_error(&e))?;
    let within = allowed_roots.iter().any(|root| {
        std::fs::canonicalize(root)
            .map(|root_real| real.starts_with(&root_real))
            .unwrap_or(false)
    });
    if !within {
        return Err((
            StatusCode::FORBIDDEN,
            "path is outside the allowed roots".to_string(),
        ));
    }
    list_dirs_with_prefix(&real, prefix, limit).map_err(|e| status_for_fs_error(&e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_entries_dirs_first_and_excludes_git() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path();
        std::fs::create_dir(base.join("zeta")).unwrap();
        std::fs::create_dir(base.join(".git")).unwrap(); // excluded
        std::fs::write(base.join("alpha.txt"), "a").unwrap();
        std::fs::write(base.join("beta.md"), "b").unwrap();

        let (entries, truncated) = list_dir(base, DEFAULT_ENTRY_LIMIT).unwrap();
        assert!(!truncated);
        // dir(zeta) comes first, then files in name order (alpha, beta). No .git.
        let got: Vec<(&str, &str)> = entries.iter().map(|e| (e.name.as_str(), e.kind)).collect();
        assert_eq!(
            got,
            vec![("zeta", "dir"), ("alpha.txt", "file"), ("beta.md", "file")]
        );
    }

    #[test]
    fn truncates_over_limit() {
        let root = tempfile::tempdir().unwrap();
        for i in 0..5 {
            std::fs::write(root.path().join(format!("f{i}")), "x").unwrap();
        }
        let (entries, truncated) = list_dir(root.path(), 3).unwrap();
        assert_eq!(entries.len(), 3);
        assert!(truncated);
    }

    #[test]
    fn resolves_dir_within_repo() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path();
        std::fs::create_dir(repo.join("sub")).unwrap();
        let repo_str = repo.to_string_lossy();
        assert!(list_within_repo(&repo_str, "", DEFAULT_ENTRY_LIMIT).is_ok());
        assert!(list_within_repo(&repo_str, "sub", DEFAULT_ENTRY_LIMIT).is_ok());
    }

    #[test]
    fn rejects_missing_dir_as_404() {
        let root = tempfile::tempdir().unwrap();
        let (code, _) =
            list_within_repo(&root.path().to_string_lossy(), "nope", DEFAULT_ENTRY_LIMIT)
                .unwrap_err();
        assert_eq!(code, StatusCode::NOT_FOUND);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape_outside_repo() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        // repo/escape → symlink to a real directory outside the repo
        std::os::unix::fs::symlink(outside.path(), repo.join("escape")).unwrap();

        let (code, _) =
            list_within_repo(&repo.to_string_lossy(), "escape", DEFAULT_ENTRY_LIMIT).unwrap_err();
        assert_eq!(code, StatusCode::BAD_REQUEST); // "dir resolves outside the repo"
    }

    #[test]
    fn split_parent_prefix_handles_trailing_slash_and_last_segment() {
        assert_eq!(
            split_parent_prefix("/Users/me/wo"),
            ("/Users/me".to_string(), "wo".to_string())
        );
        assert_eq!(
            split_parent_prefix("/Users/me/"),
            ("/Users/me".to_string(), String::new())
        );
        assert_eq!(
            split_parent_prefix("/"),
            ("/".to_string(), String::new())
        );
        // No separator yet → empty parent (caller treats as "nothing to browse").
        assert_eq!(
            split_parent_prefix("myorg"),
            (String::new(), "myorg".to_string())
        );
    }

    #[test]
    fn browse_dirs_returns_matching_subdirs_only() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().join("workspace");
        std::fs::create_dir(&base).unwrap();
        std::fs::create_dir(base.join("workshop")).unwrap();
        std::fs::create_dir(base.join("Wombat")).unwrap();
        std::fs::create_dir(base.join("other")).unwrap();
        std::fs::create_dir(base.join(".git")).unwrap(); // excluded
        std::fs::write(base.join("wombat.txt"), "x").unwrap(); // file excluded even if it matches

        let roots = vec![root.path().to_path_buf()];
        let (entries, truncated) =
            browse_dirs(&base, &roots, "wo", DEFAULT_ENTRY_LIMIT).unwrap();
        assert!(!truncated);
        // Case-insensitive prefix, dirs only, .git and the matching file excluded.
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["Wombat", "workshop"]);
        assert!(entries.iter().all(|e| e.kind == "dir"));

        // Empty prefix lists every visible subdir (still no .git, no files).
        let (all, _) = browse_dirs(&base, &roots, "", DEFAULT_ENTRY_LIMIT).unwrap();
        assert_eq!(all.len(), 3);
    }

    #[test]
    fn browse_dirs_rejects_parent_outside_allowed_roots() {
        let inside = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let (code, _) =
            browse_dirs(outside.path(), &[inside.path().to_path_buf()], "", DEFAULT_ENTRY_LIMIT)
                .unwrap_err();
        assert_eq!(code, StatusCode::FORBIDDEN);
    }

    #[cfg(unix)]
    #[test]
    fn browse_dirs_rejects_symlink_escape_from_allowed_root() {
        let allowed = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir(outside.path().join("secret")).unwrap();
        // allowed/link → symlink pointing outside the allowed root.
        std::os::unix::fs::symlink(outside.path(), allowed.path().join("link")).unwrap();

        let (code, _) = browse_dirs(
            &allowed.path().join("link"),
            &[allowed.path().to_path_buf()],
            "",
            DEFAULT_ENTRY_LIMIT,
        )
        .unwrap_err();
        assert_eq!(code, StatusCode::FORBIDDEN); // realpath escapes the allowed root
    }
}
