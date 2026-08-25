//! The PTY host — the server directly owns and reads each session's PTY.
//!
//! Design principle (proven in the PoC and agreed upon):
//! **The server is the sole PTY owner and reader of each session, and views (browsers) subscribe to
//! the server.** Because size authority is consolidated to a single point in the server, there is no
//! shared-window size contention between views.
//!
//! One session = one `PtySession`. A single reader thread reads the PTY output and:
//! - accumulates the full output in a [`ScrollbackBuffer`] for replay on attach,
//! - feeds the same byte stream to [`vt100`] to reconstruct the visible screen,
//! - fans out to all subscribers via broadcast.
//!
//! Not yet wired into the runtime (WS routes); non-breaking. The cutover comes later.
//! Undecided design choices (persistence = a launchd resident process / resize arbitration for
//! grouped sessions / output coalescing) are tracked separately. The source of truth for behavior is
//! the `tests` at the end of this file.

use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tokio::sync::broadcast;

/// Capacity of the broadcast channel (number of chunks). A slow subscriber can lag by this much, and
/// beyond it drops output via `Lagged`. This is the primary backpressure preventing unbounded
/// outbound memory growth (a minimal safety valve for the "unbounded outbound queue" concern; the
/// permanent fix, output coalescing, is handled separately).
const BROADCAST_CAPACITY: usize = 1024;

/// Maximum number of bytes the reader handles in a single read.
const READ_CHUNK: usize = 8192;

/// PTY launch configuration.
pub struct PtyConfig {
    /// The command to launch (a shell, etc.). The caller assembles env / cwd.
    pub command: CommandBuilder,
    pub cols: u16,
    pub rows: u16,
}

impl PtyConfig {
    /// A configuration that launches `command` with the default size.
    pub fn new(command: CommandBuilder) -> Self {
        Self {
            command,
            cols: 80,
            rows: 24,
        }
    }
}

/// State shared by the reader thread, subscribers, and state queries.
///
/// The reader takes this lock exactly once per chunk and performs the append to `scrollback`, the feed
/// to `parser`, and the send to `tx` **together**. Because [`PtySession::subscribe`] also takes the
/// scrollback snapshot and `tx.subscribe()` under the same lock, **no double delivery or dropped output
/// occurs at the subscription boundary** (a chunk that entered replay is not re-sent live, and vice versa).
///
/// The `scrollback` retains the **full session history without eviction** so replay can restore the
/// session from its very first prompt; the aggregate memory cost across sessions is watched separately
/// (`scrollback_len` feeds the scrollback-memory monitor). Since the parser consumes all bytes,
/// `screen_contents()` is complete, but the raw replay may begin partway through an escape sequence, so
/// it is not guaranteed to match the reconstructed screen. On attach, this raw replay rebuilds the
/// scrollback, and then the redraw sequence from `screen_formatted()` precisely overwrites the current
/// screen (the source of truth is `send_restore` and its tests in `term_attach_pty`).
struct Inner {
    scrollback: ScrollbackBuffer,
    parser: vt100::Parser,
    tx: broadcast::Sender<Arc<[u8]>>,
}

/// A single PTY session solely owned by the server.
pub struct PtySession {
    inner: Arc<Mutex<Inner>>,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    /// The PID of the child (= the process group leader; since portable-pty calls setsid, pgid==pid).
    child_pid: u32,
    /// A flag ensuring [`PtySession::shutdown`] (kill+reap+join) runs exactly once.
    /// Since the PID may be reused after reap, this is a safety valve against firing a second group
    /// kill.
    reaped: AtomicBool,
    reader_handle: Mutex<Option<JoinHandle<()>>>,
}

#[cfg(unix)]
const SIG_TERM: i32 = libc::SIGTERM;
#[cfg(unix)]
const SIG_KILL: i32 = libc::SIGKILL;
#[cfg(not(unix))]
const SIG_TERM: i32 = 15;
#[cfg(not(unix))]
const SIG_KILL: i32 = 9;

/// The return of [`PtySession::subscribe`]. Drawing `replay` (the full history up to the
/// subscription point) fully first, then streaming the live chunks from `receiver`, restores the
/// screen on connect.
pub struct Subscription {
    /// The full scrollback contents at the subscription point (raw bytes of all output so far).
    pub replay: Vec<u8>,
    /// Subsequent live output. `Lagged` indicates dropped output for a lagging subscriber.
    pub receiver: broadcast::Receiver<Arc<[u8]>>,
}

impl PtySession {
    /// Opens the PTY, launches `command`, and starts a single reader thread.
    pub fn spawn(config: PtyConfig) -> std::io::Result<Self> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: config.rows,
                cols: config.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(to_io)?;

        let child = pair.slave.spawn_command(config.command).map_err(to_io)?;
        // The portable-pty pty backend always returns a PID. None is unexpected, so we fail the spawn
        // to shut off the path of "PID unknown -> group kill impossible -> grandchildren linger and
        // join hangs" from the start.
        let child_pid = child
            .process_id()
            .ok_or_else(|| to_io("child process id unavailable"))?;
        // Close the slave after spawn. From then on only the child process holds the slave fd, and
        // when the child exits, the master's read returns EOF (the reader thread's stop condition).
        drop(pair.slave);

        let reader = pair.master.try_clone_reader().map_err(to_io)?;
        let writer = pair.master.take_writer().map_err(to_io)?;

        let (tx, _rx) = broadcast::channel(BROADCAST_CAPACITY);
        let inner = Arc::new(Mutex::new(Inner {
            scrollback: ScrollbackBuffer::new(),
            parser: vt100::Parser::new(config.rows, config.cols, 0),
            tx,
        }));

        let handle = {
            let inner = inner.clone();
            thread::spawn(move || reader_loop(reader, inner))
        };

        Ok(Self {
            inner,
            writer: Mutex::new(writer),
            master: Mutex::new(pair.master),
            child: Mutex::new(child),
            child_pid,
            reaped: AtomicBool::new(false),
            reader_handle: Mutex::new(Some(handle)),
        })
    }

    /// Subscribe. Atomically takes `replay` (the full history so far) and the live receiver under the
    /// lock, **preventing double delivery and dropped output at the subscription boundary**.
    pub fn subscribe(&self) -> Subscription {
        let inner = lock_recover(&self.inner);
        Subscription {
            replay: inner.scrollback.snapshot(),
            receiver: inner.tx.subscribe(),
        }
    }

    /// A fresh live receiver only, **without** snapshotting the (now unbounded) history. The Lagged
    /// recovery path needs just a caught-up receiver and resends the current screen separately, so it
    /// must not pay for — or clone the full history under the lock via — [`subscribe`](Self::subscribe).
    pub fn resubscribe(&self) -> broadcast::Receiver<Arc<[u8]>> {
        lock_recover(&self.inner).tx.subscribe()
    }

    /// Current retained scrollback size in bytes. Feeds the scrollback-memory monitor, which sums this
    /// across sessions to warn when aggregate usage enters the danger zone.
    pub fn scrollback_len(&self) -> usize {
        lock_recover(&self.inner).scrollback.len()
    }

    /// Aggregates input from all views and writes to the PTY (the sole writer owner).
    pub fn write_input(&self, data: &[u8]) -> std::io::Result<()> {
        let mut writer = lock_recover(&self.writer);
        writer.write_all(data)?;
        writer.flush()
    }

    /// Matches the size of the PTY and the reconstruction parser. Applied immediately since the server
    /// is the size authority.
    pub fn resize(&self, cols: u16, rows: u16) -> std::io::Result<()> {
        lock_recover(&self.master)
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(to_io)?;
        lock_recover(&self.inner)
            .parser
            .screen_mut()
            .set_size(rows, cols);
        Ok(())
    }

    /// Plain text of the headless-reconstructed visible screen (passed to state detection).
    pub fn screen_contents(&self) -> String {
        lock_recover(&self.inner).parser.screen().contents()
    }

    /// A redraw escape sequence that restores the current visible screen (including colors and cursor
    /// position). On attach/tab switch it precisely overwrites the current screen following the raw
    /// ring replay (scrollback restoration); for recovery after a broadcast `Lagged`/resume it is used
    /// alone to re-send the current screen (so as not to duplicate scrollback).
    pub fn screen_formatted(&self) -> Vec<u8> {
        lock_recover(&self.inner)
            .parser
            .screen()
            .contents_formatted()
    }

    /// The reconstructed screen's size `(rows, cols)`.
    pub fn screen_size(&self) -> (u16, u16) {
        lock_recover(&self.inner).parser.screen().size()
    }

    /// Cursor position `(row, col)`.
    pub fn cursor_position(&self) -> (u16, u16) {
        lock_recover(&self.inner).parser.screen().cursor_position()
    }

    /// The child's PID (= the process group ID).
    pub fn pid(&self) -> u32 {
        self.child_pid
    }

    /// Requests graceful termination of the process group (SIGTERM). Idempotent; failures are ignored.
    /// Assumes an operation of forcibly killing via [`PtySession::kill`] after a grace period
    /// (TERM -> grace -> KILL).
    pub fn terminate(&self) {
        self.signal_group(SIG_TERM);
    }

    /// Forcibly kills the process group (SIGKILL). Idempotent; failures are ignored.
    pub fn kill(&self) {
        self.signal_group(SIG_KILL);
    }

    /// Sends a signal to the entire process group. Since portable-pty calls setsid on the child
    /// (pgid==pid), a negative PID takes down children and grandchildren all at once (preventing
    /// lingering processes).
    ///
    /// Limitation: it does not reach a grandchild that created its own group via `setsid`/`setpgid`
    /// (only descendants of the same session are guaranteed). Before cutover, measure empirically
    /// whether claude creates grandchildren that call setsid.
    #[cfg(unix)]
    fn signal_group(&self, sig: i32) {
        unsafe {
            libc::kill(-(self.child_pid as i32), sig);
        }
    }

    #[cfg(not(unix))]
    fn signal_group(&self, _sig: i32) {
        let _ = lock_recover(&self.child).kill();
    }

    /// Reaps the exited child to prevent it becoming a zombie (called only within
    /// [`PtySession::shutdown`], after kill).
    fn reap(&self) {
        let _ = lock_recover(&self.child).wait();
    }

    /// SIGKILL the process group -> reap the child -> join the reader thread (blocking).
    ///
    /// Runs **exactly once** via the `reaped` flag. Since the PID may be reused by another process
    /// after reap, it does not fire a second group kill (preventing accidental hits on an unrelated
    /// group). Because it is blocking, call it from an async context via `spawn_blocking`
    /// ([`crate::session_registry::SessionRegistry::remove`]). `Drop` calls it as a safety net (a
    /// no-op if already removed).
    pub fn shutdown(&self) {
        if self.reaped.swap(true, Ordering::SeqCst) {
            return;
        }
        self.kill();
        self.reap();
        if let Some(handle) = lock_recover(&self.reader_handle).take() {
            let _ = handle.join();
        }
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Lock acquisition that continues processing with the latest internal state even if poisoned. If the
/// reader thread panics while holding the lock, this stops subscribers, state queries, and the writer
/// from cascading into a panic via `.unwrap()`. The recovered inner is in the consistent state from
/// just before the panic (since the lock is taken exactly once per chunk for a bulk update, it never
/// straddles an intermediate state).
fn lock_recover<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Reads PTY output and performs the ring append, vt100 feed, and broadcast together under the lock.
/// When read returns 0 (EOF) or Err (= child process exit), it breaks out of the loop.
fn reader_loop(mut reader: Box<dyn Read + Send>, inner: Arc<Mutex<Inner>>) {
    let mut buf = [0u8; READ_CHUNK];
    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        let chunk: Arc<[u8]> = Arc::from(&buf[..n]);
        let mut guard = lock_recover(&inner);
        guard.scrollback.push(chunk.as_ref());
        guard.parser.process(chunk.as_ref());
        // Err if there are no subscribers. Dropped output is handled on the subscriber side via
        // replay/Lagged, so it is ignored here.
        let _ = guard.tx.send(chunk);
    }
}

/// An append-only buffer that retains the full raw output of a session (the scrollback).
/// Nothing is evicted, so replay on attach can restore the session from its very first
/// prompt; the aggregate memory across sessions is watched by the scrollback-memory monitor via
/// [`len`](Self::len) rather than bounded here.
struct ScrollbackBuffer {
    buf: Vec<u8>,
}

impl ScrollbackBuffer {
    fn new() -> Self {
        Self { buf: Vec::new() }
    }

    fn push(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }

    fn snapshot(&self) -> Vec<u8> {
        self.buf.clone()
    }

    fn len(&self) -> usize {
        self.buf.len()
    }
}

fn to_io<E: std::fmt::Display>(err: E) -> std::io::Error {
    std::io::Error::other(err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::time::{timeout_at, Instant};

    fn sh(script: &str) -> PtyConfig {
        let mut cmd = CommandBuilder::new("sh");
        cmd.arg("-c");
        cmd.arg(script);
        cmd.env("TERM", "xterm-256color");
        PtyConfig::new(cmd)
    }

    /// Reads and collects `sub`'s replay + live until it contains `needle` (or times out), returning
    /// it as a string. Since output up to the subscription point goes into replay and the rest into
    /// the receiver, this is robust against races with subscribe.
    async fn drain_until(sub: &mut Subscription, needle: &str, timeout_ms: u64) -> String {
        let mut acc = sub.replay.clone();
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        while !String::from_utf8_lossy(&acc).contains(needle) {
            match timeout_at(deadline, sub.receiver.recv()).await {
                Ok(Ok(chunk)) => acc.extend_from_slice(&chunk),
                Ok(Err(broadcast::error::RecvError::Lagged(_))) => continue,
                _ => break,
            }
        }
        String::from_utf8_lossy(&acc).into_owned()
    }

    /// Waits until `pid` disappears (`kill(pid, 0)` returns ESRCH).
    #[cfg(unix)]
    async fn wait_until_dead(pid: i32, timeout_ms: u64) -> bool {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            if unsafe { libc::kill(pid, 0) } == -1 {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// Confirms that even if the reader thread panics while holding the inner lock and poisons the
    /// Mutex, subscribers, state queries, the writer, and resize keep responding with the latest state
    /// without cascading panics. With the old `.lock().unwrap()`, each call after poisoning would
    /// panic across the board.
    #[tokio::test]
    async fn poisoned_inner_does_not_cascade_panic() {
        let session = PtySession::spawn(sh("sleep 2")).unwrap();
        // Intentionally poison inner via a panic while holding the lock (simulating a reader thread
        // panic).
        let inner = session.inner.clone();
        let handle = std::thread::spawn(move || {
            let _guard = inner.lock().unwrap();
            panic!("simulate reader panic while holding inner lock");
        });
        assert!(handle.join().is_err());
        assert!(session.inner.is_poisoned());

        // None of these panic even after poisoning (i.e. the cascade is severed).
        let _ = session.screen_contents();
        let _ = session.screen_size();
        let _ = session.cursor_position();
        let _ = session.screen_formatted();
        let sub = session.subscribe();
        let _ = sub.replay.len();
        session.write_input(b"echo hi\n").unwrap();
        session.resize(100, 40).unwrap();
    }

    /// Evidence that killpg prevents the "kills only the child and grandchildren linger" problem.
    /// Confirms that a grandchild (a background sleep) launched by the child shell is taken down
    /// together by the group kill and reaped by init.
    #[cfg(unix)]
    #[tokio::test]
    async fn kill_terminates_grandchild_processes() {
        let session = PtySession::spawn(sh("sleep 60 & echo GPID=$!; sleep 60")).unwrap();
        let mut sub = session.subscribe();
        let seen = drain_until(&mut sub, "GPID=", 2000).await;
        let gpid: i32 = seen
            .split("GPID=")
            .nth(1)
            .and_then(|s| {
                s.split(|c: char| !c.is_ascii_digit())
                    .find(|t| !t.is_empty())
            })
            .and_then(|t| t.parse().ok())
            .expect("grandchild pid parsed from output");

        assert_eq!(
            unsafe { libc::kill(gpid, 0) },
            0,
            "grandchild {gpid} should be alive before kill"
        );
        session.kill();
        assert!(
            wait_until_dead(gpid, 3000).await,
            "grandchild {gpid} should die with the process group"
        );
    }

    #[tokio::test]
    async fn output_reaches_replay_and_headless_screen() {
        let session = PtySession::spawn(sh("printf 'hello-zashiki\\n'; sleep 1")).unwrap();
        // Wait until output enters the ring, then subscribe -> can be observed deterministically via
        // replay.
        tokio::time::sleep(Duration::from_millis(300)).await;
        let mut sub = session.subscribe();
        let seen = drain_until(&mut sub, "hello-zashiki", 2000).await;
        assert!(
            seen.contains("hello-zashiki"),
            "stream/replay missing output: {seen:?}"
        );
        // capture-pane replacement: it also appears in the visible screen headless-reconstructed from
        // the raw bytes alone.
        assert!(
            session.screen_contents().contains("hello-zashiki"),
            "headless screen missing output: {:?}",
            session.screen_contents()
        );
    }

    #[tokio::test]
    async fn input_is_forwarded_and_echoed() {
        // cat returns stdin straight to stdout. It is also echoed by the PTY line discipline.
        let session = PtySession::spawn(sh("cat")).unwrap();
        let mut sub = session.subscribe();
        session.write_input(b"ping-42\n").unwrap();
        let seen = drain_until(&mut sub, "ping-42", 2000).await;
        assert!(seen.contains("ping-42"), "input not echoed back: {seen:?}");
    }

    #[tokio::test]
    async fn resize_updates_headless_screen_size() {
        let session = PtySession::spawn(sh("sleep 1")).unwrap();
        assert_eq!(session.screen_size(), (24, 80));
        session.resize(40, 10).unwrap();
        // Since the server is the size authority, resize is applied synchronously.
        assert_eq!(session.screen_size(), (10, 40));
    }

    #[tokio::test]
    async fn two_subscribers_both_receive_live_output() {
        // Use sleep to leave room to interleave the subscription before output.
        let session = PtySession::spawn(sh("sleep 0.2; printf 'AAA-shared\\n'; sleep 1")).unwrap();
        let mut a = session.subscribe();
        let mut b = session.subscribe();
        let seen_a = drain_until(&mut a, "AAA-shared", 2000).await;
        let seen_b = drain_until(&mut b, "AAA-shared", 2000).await;
        assert!(
            seen_a.contains("AAA-shared"),
            "subscriber A missed output: {seen_a:?}"
        );
        assert!(
            seen_b.contains("AAA-shared"),
            "subscriber B missed output: {seen_b:?}"
        );
    }

    #[test]
    fn scrollback_buffer_retains_all_appended_output_in_order() {
        let mut sb = ScrollbackBuffer::new();
        sb.push(b"ab");
        sb.push(b"cd");
        sb.push(b"ef");
        // Nothing is evicted: the full history is retained so replay reaches the first prompt.
        assert_eq!(sb.snapshot(), b"abcdef");
        assert_eq!(sb.len(), 6);
    }

    #[test]
    fn scrollback_buffer_retains_a_large_chunk_whole() {
        let mut sb = ScrollbackBuffer::new();
        sb.push(b"0123456789");
        assert_eq!(sb.snapshot(), b"0123456789");
        assert_eq!(sb.len(), 10);
    }
}
