//! Append-only trace of the quit sequence, written to `~/Library/Logs/zashiki/shell.log`.
//!
//! The shell's other progress output goes to stderr, which is discarded when the .app is launched
//! from Finder. The quit sequence needs a durable sink of its own: its failure modes (a WebView that
//! never answers, a save that never confirms) show nothing in the UI and nothing in the server's log,
//! so without this file a quit that silently refuses to happen leaves no trace to read afterwards.
//!
//! `ZK_SHELL_LOG` redirects the file, for running the shell without writing into the real log.

use std::ffi::OsString;
use std::fs::{create_dir_all, OpenOptions};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Reads a panic payload as text, covering the `&str` and `String` shapes that `panic!`/`unwrap`
/// produce; anything else is reported as non-string rather than dropped.
fn panic_payload_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "<non-string panic payload>".to_string()
    }
}

/// Routes panics into this log before chaining to the previous hook, mirroring the server's
/// `install_panic_logger`. The quit sequence runs on its own thread and takes locks that can be
/// poisoned; without this its trace would simply stop mid-sequence, since a panic prints only to the
/// stderr this module exists because nothing keeps.
pub fn install_panic_logger() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "<unknown location>".to_string());
        log(&format!(
            "panicked at {location}: {}",
            panic_payload_message(info.payload())
        ));
        prev(info);
    }));
}

/// Appends one timestamped line, mirroring it to stderr for `cargo tauri dev` runs. Logging is
/// best-effort: an unwritable log must never be the reason a quit fails.
pub fn log(msg: &str) {
    append(log_path().as_deref(), &timestamp(SystemTime::now()), msg);
}

fn append(path: Option<&Path>, stamp: &str, msg: &str) {
    let line = format!("{stamp} {msg}\n");
    eprint!("[zashiki-shell] {line}");
    let Some(path) = path else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = create_dir_all(dir);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(line.as_bytes());
    }
}

fn log_path() -> Option<PathBuf> {
    resolve_log_path(std::env::var_os("ZK_SHELL_LOG"), std::env::var_os("HOME"))
}

/// Sits beside the server's own logs so the quit sequence and the server's view of the same moment
/// can be read together. Without a home directory there is nowhere to put it and logging is skipped.
fn resolve_log_path(override_path: Option<OsString>, home: Option<OsString>) -> Option<PathBuf> {
    if let Some(path) = override_path {
        return Some(PathBuf::from(path));
    }
    Some(PathBuf::from(home?).join("Library/Logs/zashiki/shell.log"))
}

/// Formats an instant as UTC ISO-8601 to the second, matching the server log's timestamps so the two
/// files can be read side by side.
fn timestamp(now: SystemTime) -> String {
    let Ok(since_epoch) = now.duration_since(UNIX_EPOCH) else {
        return "0000-00-00T00:00:00Z".to_string();
    };
    let secs = since_epoch.as_secs();
    let (year, month, day) = civil_from_days((secs / 86_400) as i64);
    let time = secs % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        time / 3600,
        (time % 3600) / 60,
        time % 60
    )
}

/// Howard Hinnant's days-from-epoch to civil-date conversion (the usual proleptic Gregorian
/// algorithm), so the shell can stamp its log without pulling in a date crate.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * shifted_month + 2) / 5 + 1) as u32;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn at(epoch_secs: u64) -> String {
        timestamp(UNIX_EPOCH + Duration::from_secs(epoch_secs))
    }

    #[test]
    fn timestamp_matches_the_server_logs_utc_iso_format() {
        assert_eq!(at(0), "1970-01-01T00:00:00Z");
        assert_eq!(at(1_788_000_000), "2026-08-29T10:40:00Z");
    }

    #[test]
    fn timestamp_handles_leap_days_and_year_ends() {
        assert_eq!(at(1_709_164_800), "2024-02-29T00:00:00Z");
        assert_eq!(at(1_704_067_199), "2023-12-31T23:59:59Z");
    }

    #[test]
    fn log_path_prefers_the_override_and_otherwise_sits_beside_the_server_log() {
        assert_eq!(
            resolve_log_path(Some("/tmp/shell.log".into()), Some("/Users/x".into())),
            Some(PathBuf::from("/tmp/shell.log"))
        );
        assert_eq!(
            resolve_log_path(None, Some("/Users/x".into())),
            Some(PathBuf::from("/Users/x/Library/Logs/zashiki/shell.log"))
        );
        // No home directory: nowhere to write, so logging is skipped rather than guessed at.
        assert_eq!(resolve_log_path(None, None), None);
    }

    #[test]
    fn append_creates_the_directory_and_keeps_earlier_lines() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/shell.log");
        append(Some(&path), "2026-09-14T10:40:00Z", "first");
        append(Some(&path), "2026-09-14T10:40:01Z", "second");

        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "2026-09-14T10:40:00Z first\n2026-09-14T10:40:01Z second\n"
        );
    }
}
