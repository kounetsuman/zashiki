//! Implementation of `GET/POST /api/file`.
//! A file read/write REST endpoint for the editor. Path defense uses the same 3 layers as the
//! explorer (fs.rs): scanRepos allowlist → is_safe_repo_relative_path → realpath escape detection.
//! The allowlist check is done by the caller (lib.rs); this module handles file safety + realpath
//! containment + the size limit + the actual I/O (reads are decoded chunk by chunk for streaming).

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
pub(crate) fn status_for_fs_error(e: &io::Error) -> (StatusCode, String) {
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

/// The text encodings a file read can decode with (`encoding` on `GET /api/file`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextEncoding {
    Utf8,
    ShiftJis,
    EucJp,
}

impl TextEncoding {
    /// The wire value, matching `TEXT_ENCODINGS` in packages/shared/src/files.ts.
    pub fn from_wire(value: &str) -> Option<Self> {
        match value {
            "utf8" => Some(TextEncoding::Utf8),
            "shift_jis" => Some(TextEncoding::ShiftJis),
            "euc_jp" => Some(TextEncoding::EucJp),
            _ => None,
        }
    }

    fn wire(self) -> &'static str {
        match self {
            TextEncoding::Utf8 => "utf8",
            TextEncoding::ShiftJis => "shift_jis",
            TextEncoding::EucJp => "euc_jp",
        }
    }
}

/// Turns a file read chunk by chunk into UTF-8, keeping the decoder's state across chunks so a
/// character split between two chunks still decodes. Invalid bytes are replaced lossily (reads never
/// fail), and a BOM is kept as text.
pub struct ChunkDecoder {
    decoder: encoding_rs::Decoder,
}

impl ChunkDecoder {
    pub fn new(encoding: TextEncoding) -> Self {
        let encoding = match encoding {
            TextEncoding::Utf8 => encoding_rs::UTF_8,
            TextEncoding::ShiftJis => encoding_rs::SHIFT_JIS,
            TextEncoding::EucJp => encoding_rs::EUC_JP,
        };
        Self {
            decoder: encoding.new_decoder_without_bom_handling(),
        }
    }

    /// `last` is true for the final chunk (possibly empty), which flushes a dangling partial character.
    pub fn decode(&mut self, bytes: &[u8], last: bool) -> String {
        let capacity = self
            .decoder
            .max_utf8_buffer_length(bytes.len())
            .unwrap_or(bytes.len() * 3 + 4);
        let mut out = String::with_capacity(capacity);
        let _ = self.decoder.decode_to_string(bytes, &mut out, last);
        out
    }
}

/// Reads `reader` `chunk_bytes` at a time as UTF-8 text, flushing a dangling partial character at the end.
pub fn decoded_chunks<R: tokio::io::AsyncRead + Unpin>(
    reader: R,
    encoding: TextEncoding,
    chunk_bytes: usize,
) -> impl futures_util::Stream<Item = io::Result<String>> {
    let state = Some((reader, ChunkDecoder::new(encoding), vec![0u8; chunk_bytes]));
    futures_util::stream::unfold(state, |state| async move {
        use tokio::io::AsyncReadExt;
        let (mut reader, mut decoder, mut buf) = state?;
        match reader.read(&mut buf).await {
            Ok(0) => Some((Ok(decoder.decode(&[], true)), None)),
            Ok(n) => {
                let text = decoder.decode(&buf[..n], false);
                Some((Ok(text), Some((reader, decoder, buf))))
            }
            Err(e) => Some((Err(e), None)),
        }
    })
}

/// Resolves a text file for a read, refusing it (413) before any of it is read when it is over `max_bytes`.
pub fn text_file_within_repo(
    repo_path: &str,
    file: &str,
    max_bytes: u64,
) -> Result<(PathBuf, std::fs::Metadata), (StatusCode, String)> {
    let (abs, meta) = resolved_file_within_repo(repo_path, file)?;
    if meta.len() > max_bytes {
        return Err((
            StatusCode::PAYLOAD_TOO_LARGE,
            "file too large to open in the editor".to_string(),
        ));
    }
    Ok((abs, meta))
}

/// The ETag of a file read: changes when the file's size or modification time changes, and differs
/// per encoding so a version read in one encoding never stands in for another.
pub fn version_tag(meta: &std::fs::Metadata, encoding: TextEncoding) -> String {
    let modified_ns = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos());
    format!("W/\"{}-{}-{}\"", meta.len(), modified_ns, encoding.wire())
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

    /// Reads the way the route does: resolve, then stream it in `chunk`-byte pieces.
    fn read(
        repo: &str,
        file: &str,
        max_bytes: u64,
        encoding: TextEncoding,
        chunk: usize,
    ) -> Result<String, (StatusCode, String)> {
        use futures_util::TryStreamExt;
        let (abs, _) = text_file_within_repo(repo, file, max_bytes)?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        Ok(runtime.block_on(async {
            let opened = tokio::fs::File::open(abs).await.unwrap();
            let pieces: Vec<String> = decoded_chunks(opened, encoding, chunk)
                .try_collect()
                .await
                .unwrap();
            pieces.concat()
        }))
    }

    #[test]
    fn reads_file_content() {
        let (_d, repo) = repo();
        assert_eq!(
            read(&repo, "README.md", FILE_MAX_BYTES, TextEncoding::Utf8, 4096).unwrap(),
            "# hello\n"
        );
    }

    #[test]
    fn decodes_with_the_chosen_encoding_even_when_a_character_spans_two_chunks() {
        let (_d, repo) = repo();
        // "名前,値\n" in Shift_JIS and in EUC-JP.
        std::fs::write(Path::new(&repo).join("sjis.csv"), b"\x96\xbc\x91\x4f,\x92\x6c\n").unwrap();
        std::fs::write(Path::new(&repo).join("euc.csv"), b"\xcc\xbe\xc1\xb0,\xc3\xcd\n").unwrap();
        let read = |file, encoding, chunk| read(&repo, file, FILE_MAX_BYTES, encoding, chunk).unwrap();
        for chunk in [1, 3, 4096] {
            assert_eq!(read("sjis.csv", TextEncoding::ShiftJis, chunk), "名前,値\n");
            assert_eq!(read("euc.csv", TextEncoding::EucJp, chunk), "名前,値\n");
        }
        assert!(read("sjis.csv", TextEncoding::Utf8, 4096).contains('\u{FFFD}'));
        std::fs::write(Path::new(&repo).join("bom.txt"), "\u{FEFF}あ").unwrap();
        assert_eq!(read("bom.txt", TextEncoding::Utf8, 1), "\u{FEFF}あ");
    }

    #[test]
    fn a_partial_character_at_the_end_is_flushed_as_a_replacement() {
        let (_d, repo) = repo();
        std::fs::write(Path::new(&repo).join("cut.csv"), b"a\x96").unwrap();
        assert_eq!(
            read(&repo, "cut.csv", FILE_MAX_BYTES, TextEncoding::ShiftJis, 1).unwrap(),
            "a\u{FFFD}"
        );
    }

    #[test]
    fn missing_file_is_404() {
        let (_d, repo) = repo();
        let (code, _) = text_file_within_repo(&repo, "nope.txt", FILE_MAX_BYTES).unwrap_err();
        assert_eq!(code, StatusCode::NOT_FOUND);
    }

    #[test]
    fn directory_is_400_not_a_file() {
        let (_d, repo) = repo();
        let (code, msg) = text_file_within_repo(&repo, "src", FILE_MAX_BYTES).unwrap_err();
        assert_eq!(code, StatusCode::BAD_REQUEST);
        assert_eq!(msg, "not a file");
    }

    #[test]
    fn oversize_file_is_413() {
        let (_d, repo) = repo();
        let big = Path::new(&repo).join("big.txt");
        std::fs::write(&big, "x".repeat(100)).unwrap();
        let (code, _) = text_file_within_repo(&repo, "big.txt", 32).unwrap_err();
        assert_eq!(code, StatusCode::PAYLOAD_TOO_LARGE);
        assert!(text_file_within_repo(&repo, "big.txt", 100).is_ok());
    }

    #[test]
    fn version_tag_changes_with_the_content_and_the_encoding() {
        let (_d, repo) = repo();
        let path = Path::new(&repo).join("README.md");
        let tag = |encoding| version_tag(&std::fs::metadata(&path).unwrap(), encoding);
        let before = tag(TextEncoding::Utf8);
        assert_eq!(before, tag(TextEncoding::Utf8));
        assert_ne!(before, tag(TextEncoding::ShiftJis));
        filetime::set_file_mtime(&path, filetime::FileTime::from_unix_time(1_000_000, 0)).unwrap();
        assert_ne!(before, tag(TextEncoding::Utf8));
        let same_time = tag(TextEncoding::Utf8);
        std::fs::write(&path, "# hello, world\n").unwrap();
        filetime::set_file_mtime(&path, filetime::FileTime::from_unix_time(1_000_000, 0)).unwrap();
        assert_ne!(same_time, tag(TextEncoding::Utf8));
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
        let (code, msg) = text_file_within_repo(&repo_str, "escape.txt", FILE_MAX_BYTES).unwrap_err();
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
