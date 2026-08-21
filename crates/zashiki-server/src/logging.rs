//! Persistent, redacted server log: `tracing` events to a rotating file plus stderr.

use std::borrow::Cow;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use file_rotate::{compression::Compression, suffix::AppendCount, ContentLimit, FileRotate};
use regex::Regex;
use secrecy::{ExposeSecret as _, SecretString};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::layer::SubscriberExt as _;
use tracing_subscriber::util::SubscriberInitExt as _;
use tracing_subscriber::EnvFilter;

const MAX_LOG_BYTES: usize = 10 * 1024 * 1024;
const MAX_LOG_FILES: usize = 7;
#[cfg(unix)]
const LOG_FILE_MODE: u32 = 0o600;

static TOKEN_SHAPE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b[0-9a-fA-F]{48}\b").expect("static regex"));

/// Rewrites a formatted log line to drop secrets before it reaches a sink.
pub struct Redactor {
    home: Option<String>,
    // Literal token catches an any-shape ZK_TOKEN; TOKEN_SHAPE backs up other 48-hex secrets.
    token: Option<String>,
}

impl Redactor {
    pub fn new(home: Option<String>, token: Option<String>) -> Self {
        Self {
            // len > 1 so a degenerate HOME (e.g. "/") doesn't rewrite every path separator.
            home: home.filter(|h| h.len() > 1),
            token: token.filter(|t| !t.is_empty()),
        }
    }

    pub fn redact(&self, line: &str) -> String {
        let mut out = Cow::Borrowed(line);
        if let Some(token) = &self.token {
            if out.contains(token.as_str()) {
                out = Cow::Owned(out.replace(token.as_str(), "[REDACTED_TOKEN]"));
            }
        }
        if let Some(home) = &self.home {
            if out.contains(home.as_str()) {
                out = Cow::Owned(out.replace(home.as_str(), "~"));
            }
        }
        TOKEN_SHAPE.replace_all(&out, "[REDACTED_TOKEN]").into_owned()
    }
}

/// `io::Write` adapter that redacts each complete line; buffers across `write` calls to keep a secret
/// scrubbed even when it is split mid-line.
pub struct RedactWriter<W: Write> {
    inner: W,
    redactor: Arc<Redactor>,
    buf: Vec<u8>,
}

impl<W: Write> RedactWriter<W> {
    pub fn new(inner: W, redactor: Arc<Redactor>) -> Self {
        Self { inner, redactor, buf: Vec::new() }
    }

    fn drain_lines(&mut self) -> io::Result<()> {
        while let Some(nl) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=nl).collect();
            let text = String::from_utf8_lossy(&line[..line.len() - 1]);
            self.inner.write_all(self.redactor.redact(&text).as_bytes())?;
            self.inner.write_all(b"\n")?;
        }
        Ok(())
    }
}

impl<W: Write> Write for RedactWriter<W> {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        self.buf.extend_from_slice(data);
        self.drain_lines()?;
        Ok(data.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        if !self.buf.is_empty() {
            let text = String::from_utf8_lossy(&self.buf);
            self.inner.write_all(self.redactor.redact(&text).as_bytes())?;
            self.buf.clear();
        }
        self.inner.flush()
    }
}

impl<W: Write> Drop for RedactWriter<W> {
    fn drop(&mut self) {
        let _ = self.flush();
    }
}

fn build_rotating_writer(path: &Path, max_bytes: usize, max_files: usize) -> FileRotate<AppendCount> {
    FileRotate::new(
        path,
        AppendCount::new(max_files),
        ContentLimit::Bytes(max_bytes),
        Compression::OnRotate(1),
        #[cfg(unix)]
        Some(LOG_FILE_MODE),
    )
}

fn open_log_file(path: &Path) -> io::Result<FileRotate<AppendCount>> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // FileRotate::new defers the open, so probe writability here to make the fail-soft decision eager.
    // The probe must set the mode, since creating the file here means FileRotate won't (its mode applies
    // only to files it creates).
    let mut opts = std::fs::OpenOptions::new();
    opts.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        opts.mode(LOG_FILE_MODE);
    }
    opts.open(path)?;
    Ok(build_rotating_writer(path, MAX_LOG_BYTES, MAX_LOG_FILES))
}

/// Installs the global `tracing` subscriber, redacting both stderr and the rotating file. Adds the file
/// when `log_path` is writable, else stays stderr-only so an unwritable log dir never blocks startup.
/// Returns the file worker's guard, held for the process lifetime.
pub fn init(log_path: Option<PathBuf>, token: Option<&SecretString>) -> Option<WorkerGuard> {
    let token = token.map(|t| t.expose_secret().clone());
    let redactor = Arc::new(Redactor::new(std::env::var("HOME").ok(), token));
    let stderr_redactor = Arc::clone(&redactor);
    // Default info (RUST_LOG overrides): keeps dependency debug/trace out of the sinks.
    let filter = EnvFilter::builder()
        .with_default_directive(tracing_subscriber::filter::LevelFilter::INFO.into())
        .from_env_lossy();
    // with_ansi(false): color escapes would corrupt the crash tail and the redactor's literal matches.
    let stderr_layer = tracing_subscriber::fmt::layer()
        .with_ansi(false)
        .with_writer(move || RedactWriter::new(io::stderr(), Arc::clone(&stderr_redactor)));

    let (file_layer, guard) = match log_path.as_deref().map(open_log_file).transpose() {
        Ok(Some(rotate)) => {
            let (writer, guard) = tracing_appender::non_blocking(RedactWriter::new(rotate, redactor));
            let layer = tracing_subscriber::fmt::layer().with_ansi(false).with_writer(writer);
            (Some(layer), Some(guard))
        }
        Ok(None) => (None, None),
        Err(e) => {
            eprintln!("zashiki-server: persistent log file unavailable: {e}");
            (None, None)
        }
    };

    // try_init (not init) so a second call is a no-op rather than a panic.
    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(stderr_layer)
        .with(file_layer)
        .try_init();
    guard
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef"; // 48 hex

    fn redactor() -> Arc<Redactor> {
        Arc::new(Redactor::new(Some("/Users/alice".to_string()), Some(TOKEN.to_string())))
    }

    #[test]
    fn redact_scrubs_48_hex_token() {
        let out = redactor().redact(&format!("token file wrote {TOKEN} ok"));
        assert!(!out.contains(TOKEN), "token must not survive: {out}");
        assert!(out.contains("[REDACTED_TOKEN]"), "{out}");
    }

    #[test]
    fn redact_scrubs_any_shape_external_token() {
        // An externally supplied ZK_TOKEN need not be 48 hex; the literal seed must still catch it.
        let r = Redactor::new(None, Some("hunter2".to_string()));
        assert_eq!(r.redact("auth with hunter2 failed"), "auth with [REDACTED_TOKEN] failed");
    }

    #[test]
    fn redact_scrubs_token_abutting_word_chars() {
        // The 48-hex regex needs word boundaries; the literal seed does not, so a token joined to a word
        // char (e.g. inside a filename) is still caught.
        let out = redactor().redact(&format!("wrote {TOKEN}_bak"));
        assert!(!out.contains(TOKEN), "{out}");
    }

    #[test]
    fn redact_without_token_seed_still_scrubs_48_hex() {
        let r = Redactor::new(None, None);
        let out = r.redact(&format!("saw {TOKEN}"));
        assert!(!out.contains(TOKEN) && out.contains("[REDACTED_TOKEN]"), "{out}");
    }

    #[test]
    fn redact_leaves_64_hex_sha_intact() {
        let sha = "a".repeat(64);
        let out = redactor().redact(&format!("commit {sha}"));
        assert!(out.contains(&sha), "a 64-hex sha is not token-shaped: {out}");
    }

    #[test]
    fn redact_scrubs_uppercase_token() {
        let upper = TOKEN.to_uppercase();
        let out = redactor().redact(&format!("ZK_TOKEN={upper}"));
        assert!(!out.contains(&upper) && out.contains("[REDACTED_TOKEN]"), "{out}");
    }

    #[test]
    fn redact_collapses_home_to_tilde() {
        let out = redactor().redact("restore failed at /Users/alice/.zashiki/saves/last.tsv");
        assert_eq!(out, "restore failed at ~/.zashiki/saves/last.tsv");
    }

    #[test]
    fn redact_collapses_every_home_occurrence() {
        let out = redactor().redact("/Users/alice/a and /Users/alice/b");
        assert_eq!(out, "~/a and ~/b");
    }

    #[test]
    fn redact_is_noop_without_secrets() {
        assert_eq!(redactor().redact("plain listening line"), "plain listening line");
    }

    #[test]
    fn empty_home_disables_path_collapse() {
        let r = Redactor::new(Some(String::new()), None);
        assert_eq!(r.redact("/Users/alice/x"), "/Users/alice/x");
    }

    #[test]
    fn degenerate_root_home_does_not_collapse_separators() {
        let r = Redactor::new(Some("/".to_string()), None);
        assert_eq!(r.redact("/Users/alice/x"), "/Users/alice/x");
    }

    #[test]
    fn open_log_file_creates_parent_and_probes_writable() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("logs").join("server.log");
        assert!(open_log_file(&path).is_ok());
        assert!(path.parent().unwrap().is_dir());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "the live log must be created owner-only");
        }
    }

    #[test]
    #[cfg(unix)]
    fn open_log_file_then_write_keeps_live_file_owner_only() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("server.log");
        let mut w = open_log_file(&path).unwrap();
        writeln!(w, "a line").unwrap();
        w.flush().unwrap();
        drop(w);
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "the live log must stay owner-only after writes");
    }

    #[test]
    fn open_log_file_errs_when_path_is_unwritable() {
        let dir = tempfile::tempdir().unwrap();
        // Parent is a regular file, so create_dir_all/open must fail and callers fall back to stderr-only.
        let file = dir.path().join("not-a-dir");
        std::fs::write(&file, b"x").unwrap();
        assert!(open_log_file(&file.join("server.log")).is_err());
    }

    #[test]
    fn redact_writer_scrubs_token_split_across_writes() {
        let sink = Vec::new();
        let mut w = RedactWriter::new(sink, redactor());
        // Split the token between two write() calls; only line buffering catches this.
        w.write_all(format!("line {}", &TOKEN[..20]).as_bytes()).unwrap();
        w.write_all(format!("{}\n", &TOKEN[20..]).as_bytes()).unwrap();
        let out = String::from_utf8(std::mem::take(&mut w.inner)).unwrap();
        assert!(!out.contains(TOKEN) && out.contains("[REDACTED_TOKEN]"), "{out}");
    }

    #[test]
    fn redact_writer_scrubs_each_line_of_a_multiline_event() {
        let sink = Vec::new();
        let mut w = RedactWriter::new(sink, redactor());
        w.write_all(format!("a /Users/alice/x\nb {TOKEN}\n").as_bytes()).unwrap();
        let out = String::from_utf8(std::mem::take(&mut w.inner)).unwrap();
        assert_eq!(out, "a ~/x\nb [REDACTED_TOKEN]\n");
    }

    #[test]
    fn redact_writer_flushes_residual_without_trailing_newline() {
        let sink = Vec::new();
        let mut w = RedactWriter::new(sink, redactor());
        w.write_all(format!("tail {TOKEN}").as_bytes()).unwrap();
        w.flush().unwrap();
        let out = String::from_utf8(std::mem::take(&mut w.inner)).unwrap();
        assert_eq!(out, "tail [REDACTED_TOKEN]");
    }

    #[test]
    fn rotation_bounds_file_count_and_applies_mode() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("server.log");
        let mut w = build_rotating_writer(&path, 100, 3);
        for i in 0..200 {
            writeln!(w, "line {i:04} 0123456789abcdef0123456789abcdef").unwrap();
        }
        w.flush().unwrap();
        drop(w);

        let files: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with("server.log"))
            .collect();
        assert!(
            files.len() <= 3 + 1,
            "live file + at most max_files rotations, got {}",
            files.len()
        );
        // gz rotations inherit umask; their content is already redacted, so only the uncompressed files
        // (which file-rotate mode-sets) must stay owner-only.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            for f in files.iter().filter(|f| !f.file_name().to_string_lossy().ends_with(".gz")) {
                let mode = f.metadata().unwrap().permissions().mode();
                assert_eq!(mode & 0o777, 0o600, "{:?} must be 0600", f.file_name());
            }
        }
    }

    #[test]
    fn fmt_layer_emits_no_ansi_escapes() {
        use std::sync::Mutex;
        use tracing_subscriber::fmt::MakeWriter;

        #[derive(Clone)]
        struct Shared(Arc<Mutex<Vec<u8>>>);
        impl Write for Shared {
            fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        impl<'a> MakeWriter<'a> for Shared {
            type Writer = Shared;
            fn make_writer(&'a self) -> Shared {
                self.clone()
            }
        }

        let buf = Arc::new(Mutex::new(Vec::new()));
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_writer(Shared(Arc::clone(&buf)))
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            tracing::error!("boundary failure at /Users/alice/.zashiki");
        });
        assert!(
            !buf.lock().unwrap().contains(&0x1b),
            "no ESC byte may reach a sink that feeds a public issue"
        );
    }
}
