//! Startup token generation and write-out.
//!
//! Generates a 48-hex-digit token and writes it to
//! `~/.zashiki/token` with mode 0600. The CLI integration (the `zashiki` command) and the Tauri
//! sidecar (`read_token` in `sidecar.rs`) read this file. The sidecar requires it to be alphanumeric
//! and non-empty (hex satisfies this).

use std::io::Read as _;
use std::path::Path;

/// Encode 24 bytes as lowercase hex (48 digits).
pub fn hex_token(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(char::from_digit((b >> 4) as u32, 16).unwrap());
        s.push(char::from_digit((b & 0x0f) as u32, 16).unwrap());
    }
    s
}

/// Generate a 48-digit hex token from OS randomness (/dev/urandom). To avoid adding dependencies we
/// read /dev/urandom directly instead of using getrandom/rand (it is always present on macOS/Linux).
pub fn generate_token() -> std::io::Result<String> {
    let mut buf = [0u8; 24];
    let mut f = std::fs::File::open("/dev/urandom")?;
    f.read_exact(&mut buf)?;
    Ok(hex_token(&buf))
}

/// Write the token with mode 0600 (creating the parent directory with mode 0700). Call this only
/// after listen succeeds (so that a double-start failing on bind does not clobber the running
/// instance's token).
pub fn write_token_file(path: &Path, token: &str) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        }
    }
    std::fs::write(path, token)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_token_は各バイトを2桁小文字hexにする() {
        assert_eq!(hex_token(&[0x00, 0x0f, 0xff, 0xa5]), "000fffa5");
        assert_eq!(hex_token(&[]), "");
    }

    #[test]
    fn generate_token_は48桁の英数字hexを返す() {
        let t = generate_token().unwrap();
        assert_eq!(t.len(), 48, "randomBytes(24).hex 相当の 48 桁");
        assert!(
            t.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
            "sidecar read_token が要求する英数字（小文字 hex）: {t}"
        );
        // A separate call yields a different value (i.e. it is random).
        assert_ne!(t, generate_token().unwrap());
    }

    #[test]
    fn write_token_file_は0600で書き親を作る() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sub").join("token");
        write_token_file(&path, "abc123DEF").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "abc123DEF");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "token は 0600");
        }
    }

    #[test]
    fn write_token_file_は既存を上書きしても0600を保つ() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("token");
        std::fs::write(&path, "old").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        }
        write_token_file(&path, "newtoken").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "newtoken");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }
}
