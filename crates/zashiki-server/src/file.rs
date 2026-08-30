//! Implementation of `GET/POST /api/file`.
//! A file read/write REST endpoint for the editor. Path defense uses the same 3 layers as the
//! explorer (fs.rs): scanRepos allowlist → is_safe_repo_relative_path → realpath escape detection.
//! The allowlist check is done by the caller (lib.rs); this module handles file safety + realpath
//! containment + the size limit + the actual I/O.

use std::io;
use std::path::{Path, PathBuf};

use axum::http::StatusCode;

/// Maximum byte size of a single file that read/write handles (2MiB).
pub const FILE_MAX_BYTES: u64 = 2 * 1024 * 1024;

// ENOTDIR / ELOOP are not in stable ErrorKind, so pick them up via raw_os_error (same as fs.rs).
const EISDIR: i32 = 21;
const ENOTDIR: i32 = 20;
const ELOOP_LINUX: i32 = 40;
const ELOOP_MACOS: i32 = 62;

/// Maps fs errors to the error contract (404/400/403 + EISDIR/ENOTDIR/ELOOP).
fn status_for_fs_error(e: &io::Error) -> (StatusCode, String) {
    let (code, msg) = match e.kind() {
        io::ErrorKind::NotFound => (StatusCode::NOT_FOUND, "file not found"),
        io::ErrorKind::PermissionDenied => (StatusCode::FORBIDDEN, "permission denied"),
        _ => match e.raw_os_error() {
            Some(EISDIR) => (StatusCode::BAD_REQUEST, "not a file"),
            Some(ENOTDIR) => (StatusCode::BAD_REQUEST, "not a directory"),
            Some(ELOOP_LINUX) | Some(ELOOP_MACOS) => {
                (StatusCode::BAD_REQUEST, "too many symbolic links")
            }
            _ => (StatusCode::INTERNAL_SERVER_ERROR, "fs error"),
        },
    };
    (code, msg.to_string())
}

/// Checks whether the resolved file stays within the repo (realpath comparison; rejects escaping symlinks). Returns the real path if it does.
/// On realpath failure, falls to 404/400 via statusForFsError.
fn resolve_within_repo(repo_path: &str, file: &str) -> Result<PathBuf, (StatusCode, String)> {
    let real = std::fs::canonicalize(Path::new(repo_path).join(file))
        .map_err(|e| status_for_fs_error(&e))?;
    let repo_real = std::fs::canonicalize(repo_path).map_err(|e| status_for_fs_error(&e))?;
    if real.starts_with(&repo_real) {
        Ok(real)
    } else {
        Err((
            StatusCode::BAD_REQUEST,
            "file resolves outside the repo".to_string(),
        ))
    }
}

/// Resolves a repo-relative path to an in-repo absolute path and asserts it is a regular file.
/// Shared by /api/file and /api/media so both enforce the same realpath containment + isFile defense.
fn resolved_file_within_repo(
    repo_path: &str,
    file: &str,
) -> Result<(PathBuf, std::fs::Metadata), (StatusCode, String)> {
    let abs = resolve_within_repo(repo_path, file)?;
    let meta = std::fs::metadata(&abs).map_err(|e| status_for_fs_error(&e))?;
    if !meta.is_file() {
        return Err((StatusCode::BAD_REQUEST, "not a file".to_string()));
    }
    Ok((abs, meta))
}

/// Reads from an abs path that has passed the in-repo realpath check (blocking; callers use spawn_blocking).
/// statFile → 400 if !isFile, 413 if size>max, readTextFile → content.
pub fn read_within_repo(
    repo_path: &str,
    file: &str,
    max_bytes: u64,
) -> Result<String, (StatusCode, String)> {
    let (abs, meta) = resolved_file_within_repo(repo_path, file)?;
    if meta.len() > max_bytes {
        return Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            "file too large to open in the editor".to_string(),
        ));
    }
    // Content is read as UTF-8; non-UTF-8 bytes are replaced lossily (reads never fail).
    let bytes = std::fs::read(&abs).map_err(|e| status_for_fs_error(&e))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Resolves a repo-relative file to an absolute path for streaming (realpath containment + isFile),
/// with no size cap so large videos stream rather than being rejected.
pub fn media_path_within_repo(
    repo_path: &str,
    file: &str,
) -> Result<PathBuf, (StatusCode, String)> {
    let (abs, _) = resolved_file_within_repo(repo_path, file)?;
    Ok(abs)
}

/// Overwrites content to an abs path that has passed the in-repo realpath check (blocking).
/// The byte length of content is validated before the call (413); this does realpath + write.
pub fn write_within_repo(
    repo_path: &str,
    file: &str,
    content: &str,
) -> Result<(), (StatusCode, String)> {
    let abs = resolve_within_repo(repo_path, file)?;
    std::fs::write(&abs, content).map_err(|e| status_for_fs_error(&e))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(repo.join("src")).unwrap();
        std::fs::write(repo.join("README.md"), "# hello\n").unwrap();
        std::fs::write(repo.join("src/app.ts"), "export {}\n").unwrap();
        let repo_str = repo.to_string_lossy().into_owned();
        (dir, repo_str)
    }

    #[test]
    fn reads_file_content() {
        let (_d, repo) = repo();
        assert_eq!(
            read_within_repo(&repo, "README.md", FILE_MAX_BYTES).unwrap(),
            "# hello\n"
        );
    }

    #[test]
    fn missing_file_is_404() {
        let (_d, repo) = repo();
        let (code, _) = read_within_repo(&repo, "nope.txt", FILE_MAX_BYTES).unwrap_err();
        assert_eq!(code, StatusCode::NOT_FOUND);
    }

    #[test]
    fn directory_is_400_not_a_file() {
        let (_d, repo) = repo();
        let (code, msg) = read_within_repo(&repo, "src", FILE_MAX_BYTES).unwrap_err();
        assert_eq!(code, StatusCode::BAD_REQUEST);
        assert_eq!(msg, "not a file");
    }

    #[test]
    fn oversize_file_is_413() {
        let (_d, repo) = repo();
        let big = Path::new(&repo).join("big.txt");
        std::fs::write(&big, "x".repeat(100)).unwrap();
        let (code, _) = read_within_repo(&repo, "big.txt", 32).unwrap_err();
        assert_eq!(code, StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[test]
    fn media_path_resolves_a_file_and_rejects_a_directory() {
        let (_d, repo) = repo();
        assert!(media_path_within_repo(&repo, "README.md").is_ok());
        let (code, msg) = media_path_within_repo(&repo, "src").unwrap_err();
        assert_eq!(code, StatusCode::BAD_REQUEST);
        assert_eq!(msg, "not a file");
    }

    #[cfg(unix)]
    #[test]
    fn media_path_symlink_escape_is_400() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::write(dir.path().join("secret.mp4"), "x").unwrap();
        std::os::unix::fs::symlink(dir.path().join("secret.mp4"), repo.join("escape.mp4"))
            .unwrap();
        let repo_str = repo.to_string_lossy();
        let (code, msg) = media_path_within_repo(&repo_str, "escape.mp4").unwrap_err();
        assert_eq!(code, StatusCode::BAD_REQUEST);
        assert_eq!(msg, "file resolves outside the repo");
    }

    #[test]
    fn writes_file_content() {
        let (_d, repo) = repo();
        write_within_repo(&repo, "src/app.ts", "export const x = 1\n").unwrap();
        assert_eq!(
            std::fs::read_to_string(Path::new(&repo).join("src/app.ts")).unwrap(),
            "export const x = 1\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_is_400_and_does_not_read_target() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::write(dir.path().join("secret.txt"), "TOP SECRET\n").unwrap();
        std::os::unix::fs::symlink(dir.path().join("secret.txt"), repo.join("escape.txt")).unwrap();
        let repo_str = repo.to_string_lossy();
        let (code, msg) = read_within_repo(&repo_str, "escape.txt", FILE_MAX_BYTES).unwrap_err();
        assert_eq!(code, StatusCode::BAD_REQUEST);
        assert_eq!(msg, "file resolves outside the repo");
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_write_does_not_touch_target() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let secret = dir.path().join("secret.txt");
        std::fs::write(&secret, "TOP SECRET\n").unwrap();
        std::os::unix::fs::symlink(&secret, repo.join("escape.txt")).unwrap();
        let repo_str = repo.to_string_lossy();
        let (code, _) = write_within_repo(&repo_str, "escape.txt", "HACKED\n").unwrap_err();
        assert_eq!(code, StatusCode::BAD_REQUEST);
        assert_eq!(std::fs::read_to_string(&secret).unwrap(), "TOP SECRET\n");
    }
}
