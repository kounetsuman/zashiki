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
    /// Dropped once no more output can arrive, so subscribers see the stream close. Without that, a
    /// bridge holding an `Arc<PtySession>` keeps its receiver open on a session that is gone and waits
    /// forever. The scrollback and last screen above stay readable either way.
    tx: Option<broadcast::Sender<Arc<[u8]>>>,
    /// The reader thread has stopped, so nothing more will be forwarded. Closing the stream waits for
    /// this: a child's last output — often the reason it died — is still in flight when its exit
    /// becomes observable, and subscribers would lose exactly the lines worth reading.
    reader_done: bool,
    /// Whether output is still worth keeping. Cleared by [`PtySession::stop`]: nothing will read this
    /// session's history again, and a reader that outlives the teardown would otherwise grow a buffer
    /// the scrollback-memory monitor no longer sums.
    retain: bool,
}

impl Inner {
    /// A receiver for live output. Already closed once teardown has dropped the sender, which is how
    /// an attached bridge learns the session is gone.
    fn subscribe(&self) -> broadcast::Receiver<Arc<[u8]>> {
        match &self.tx {
            Some(tx) => tx.subscribe(),
            None => {
                let (tx, rx) = broadcast::channel(1);
                drop(tx);
                rx
            }
        }
    }
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
    reaped: AtomicBool,
    /// The child has been waited on, which frees its pid: it must not be waited on again, and
    /// [`PtySession::pid`] must stop reporting it.
    child_collected: AtomicBool,
    /// The child was reaped by teardown, so nothing may be signalled at that pid — it may already
    /// belong to something else. Separate from `child_collected` because the non-unix kill goes through
    /// a handle rather than a pid, and muting that would take away its only way to reach a survivor.
    child_reaped: AtomicBool,
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

/// DECRST for the mouse-tracking modes and encodings vt100 tracks, prepended to the restore redraw so
/// the shared xterm reaches the pristine baseline `state_formatted` re-asserts modes against (`None`
/// emits nothing, so a mouse-off terminal must actively clear another terminal's leaked tracking).
/// Confined to vt100-tracked modes: it cannot re-assert others, so resetting them would strip a
/// terminal that legitimately set one. Canonical spec: the `screen_restore_sequence` tests.
const MOUSE_TRACKING_RESET: &[u8] = b"\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l";

/// Restore redraw for `screen`: reset mouse tracking, then `state_formatted` (visible cells plus the
/// screen's input modes). The result leaves the terminal's modes exactly matching `screen`. Canonical
/// spec: the `screen_restore_sequence` tests below.
fn screen_restore_sequence(screen: &vt100::Screen) -> Vec<u8> {
    let mut out = MOUSE_TRACKING_RESET.to_vec();
    out.extend_from_slice(&screen.state_formatted());
    out
}

/// Number of times opening a PTY is attempted before a spawn is reported as failed.
const OPENPTY_ATTEMPTS: usize = 4;

/// macOS refuses an occasional PTY allocation even with hundreds of slots free, measured at roughly
/// one in five thousand when ptys are opened concurrently across processes. Retrying straight away
/// clears it, and costs next to nothing when a refusal turns out to be real exhaustion.
fn open_pty_with_retry<T, E>(mut open: impl FnMut() -> Result<T, E>) -> Result<T, E> {
    let mut attempt = 1;
    loop {
        match open() {
            Ok(opened) => return Ok(opened),
            Err(_) if attempt < OPENPTY_ATTEMPTS => attempt += 1,
            Err(err) => return Err(err),
        }
    }
}

impl PtySession {
    /// Opens the PTY, launches `command`, and starts a single reader thread.
    pub fn spawn(config: PtyConfig) -> std::io::Result<Self> {
        let pty_system = native_pty_system();
        let pair = open_pty_with_retry(|| {
            pty_system.openpty(PtySize {
                rows: config.rows,
                cols: config.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
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
            tx: Some(tx),
            reader_done: false,
            retain: true,
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
            child_collected: AtomicBool::new(false),
            child_reaped: AtomicBool::new(false),
            reader_handle: Mutex::new(Some(handle)),
        })
    }

    /// Subscribe. Atomically takes `replay` (the full history so far) and the live receiver under the
    /// lock, **preventing double delivery and dropped output at the subscription boundary**.
    pub fn subscribe(&self) -> Subscription {
        let inner = lock_recover(&self.inner);
        Subscription {
            replay: inner.scrollback.snapshot(),
            receiver: inner.subscribe(),
        }
    }

    /// A fresh live receiver only, **without** snapshotting the (now unbounded) history. The Lagged
    /// recovery path needs just a caught-up receiver and resends the current screen separately, so it
    /// must not pay for — or clone the full history under the lock via — [`subscribe`](Self::subscribe).
    pub fn resubscribe(&self) -> broadcast::Receiver<Arc<[u8]>> {
        lock_recover(&self.inner).subscribe()
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

    /// A redraw escape sequence that restores the current visible screen and its input modes (colors,
    /// cursor position, and mouse tracking / bracketed paste / application cursor+keypad). On attach/tab
    /// switch it precisely overwrites the current screen following the raw ring replay (scrollback
    /// restoration); for recovery after a broadcast `Lagged`/resume it is used alone to re-send the
    /// current screen (so as not to duplicate scrollback). See `screen_restore_sequence`.
    pub fn screen_formatted(&self) -> Vec<u8> {
        screen_restore_sequence(lock_recover(&self.inner).parser.screen())
    }

    /// The reconstructed screen's size `(rows, cols)`.
    pub fn screen_size(&self) -> (u16, u16) {
        lock_recover(&self.inner).parser.screen().size()
    }

    /// Cursor position `(row, col)`.
    pub fn cursor_position(&self) -> (u16, u16) {
        lock_recover(&self.inner).parser.screen().cursor_position()
    }

    /// The child's PID (= the process group ID), or 0 once it has been collected. A reaped pid can be
    /// handed to an unrelated process, and the poller walks this pid's subtree to find the terminal's
    /// claude — so a stale one could attribute a stranger's session to this terminal.
    pub fn pid(&self) -> u32 {
        if self.child_collected.load(Ordering::SeqCst) {
            return 0;
        }
        self.child_pid
    }

    /// Whether the child has ended, **without reaping it**. Non-blocking, so the status poller can ask
    /// on every tick.
    ///
    /// Not reaping is the point: an unreaped child keeps its pid — and with it the process group id,
    /// since portable-pty calls setsid — reserved. That is what keeps [`PtySession::shutdown`]'s group
    /// kill aimed at this terminal: once reaped, the pid can be handed to an unrelated process, and a
    /// later kill would land on that one instead. The child is collected when the session is removed.
    #[cfg(unix)]
    pub fn has_exited(&self) -> bool {
        if self.child_reaped.load(Ordering::SeqCst) {
            // Attempted on every call, not just the one that first observes the exit: the reader may
            // not have finished draining then, and `close_output` waits for it.
            self.close_output();
            return true;
        }
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let rc = unsafe {
            libc::waitid(
                libc::P_PID,
                self.child_pid as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if rc != 0 {
            // ECHILD means it was already collected, so the pid is free and nothing may be signalled
            // at it any more.
            if std::io::Error::last_os_error().raw_os_error() == Some(libc::ECHILD) {
                self.child_reaped.store(true, Ordering::SeqCst);
                self.child_collected.store(true, Ordering::SeqCst);
                self.close_output();
                return true;
            }
            return false;
        }
        // WNOHANG reports "nothing to see yet" by leaving the pid unset.
        if siginfo_pid(&info) == 0 {
            return false;
        }
        self.close_output();
        true
    }

    /// Closes the output stream so subscribers stop waiting on a session that is gone. Needs both: the
    /// child has ended (a reader can stop on a read error while the child is still working, and closing
    /// there would leave a live terminal unable to accept input) and the reader has finished forwarding
    /// (its last chunks are the ones that say why the child died).
    fn close_output(&self) {
        let mut inner = lock_recover(&self.inner);
        if inner.reader_done {
            inner.tx = None;
        }
    }

    /// Whether the child has ended. Non-blocking, so the status poller can ask on every tick.
    ///
    /// Unlike the unix path this does collect the child (there is no non-reaping probe here), but it
    /// deliberately does not record that: `child_reaped` mutes the kill paths, and here the kill is a
    /// handle-based `Child::kill` rather than a pid, so muting it would only take away the one way a
    /// surviving descendant can still be dealt with.
    #[cfg(not(unix))]
    pub fn has_exited(&self) -> bool {
        // Attempted on every call, not just the one that first observes the exit: the reader may not
        // have finished draining then, and `close_output` waits for it.
        if matches!(lock_recover(&self.child).try_wait(), Ok(Some(_))) {
            // Collected, so the pid is free — but the kill here is handle-based, so it stays usable.
            self.child_collected.store(true, Ordering::SeqCst);
            self.close_output();
            return true;
        }
        false
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
    /// Muted once the child has been waited on: its pid can be reassigned from that moment, and this
    /// would then take down whatever group now owns it. Teardown signals before it waits, so its own
    /// kill still goes through, and [`PtySession::has_exited`] deliberately leaves the child unreaped
    /// so an exited terminal stays killable.
    ///
    /// Limitation: it does not reach a grandchild that created its own group via `setsid`/`setpgid`
    /// (only descendants of the same session are guaranteed). Before cutover, measure empirically
    /// whether claude creates grandchildren that call setsid.
    #[cfg(unix)]
    fn signal_group(&self, sig: i32) {
        if self.child_reaped.load(Ordering::SeqCst) {
            return;
        }
        unsafe {
            libc::kill(-(self.child_pid as i32), sig);
        }
    }

    #[cfg(not(unix))]
    fn signal_group(&self, _sig: i32) {
        if self.child_reaped.load(Ordering::SeqCst) {
            return;
        }
        let _ = lock_recover(&self.child).kill();
    }

    /// Reaps the exited child to prevent it becoming a zombie (called only within
    /// [`PtySession::shutdown`], after kill).
    fn reap(&self) {
        // Set first: the pid becomes reusable the instant `wait` returns, and a concurrent signal in
        // between would land on whatever took it. The child is still collectable with the flags up, and
        // `shutdown` has already sent its own kill by this point.
        self.child_reaped.store(true, Ordering::SeqCst);
        self.child_collected.store(true, Ordering::SeqCst);
        let _ = lock_recover(&self.child).wait();
    }

    /// SIGKILL the process group and collect the child, leaving the reader thread to finish on its own.
    ///
    /// For a caller that must not be held up: the reader only returns once every fd on the pty slave is
    /// closed, and a descendant that escaped the group kill (see [`PtySession::signal_group`]) can hold
    /// it open indefinitely. The child is dead and collected either way; what is skipped is only the
    /// wait for that thread, which then ends whenever its last writer does.
    ///
    /// Runs **exactly once**, sharing the flag with [`PtySession::shutdown`] so neither repeats a kill
    /// at a pid the OS may have reassigned.
    pub fn stop(&self) {
        if self.reaped.swap(true, Ordering::SeqCst) {
            return;
        }
        self.kill();
        self.reap();
    }

    /// Drops the history of a session that has been replaced. Called once the replacement is registered,
    /// not as part of the teardown: a relaunch that fails leaves this session in the row so the user can
    /// read what happened and try again, and that is the one case where the history still matters. After
    /// a successful swap nothing reads it again, and a reader left running by a descendant that escaped
    /// the kill would keep appending to a buffer the scrollback-memory monitor no longer sums.
    pub fn discard_history(&self) {
        let mut inner = lock_recover(&self.inner);
        inner.retain = false;
        inner.scrollback = ScrollbackBuffer::new();
    }

    /// SIGKILL the process group -> reap the child -> join the reader thread (blocking).
    ///
    /// Runs **exactly once** via the `reaped` flag, and is the only place the child is collected — an
    /// exited terminal stays a zombie until then, which is what keeps the group kill aimed correctly.
    /// Because it is blocking, call it from an async context via `spawn_blocking`
    /// ([`crate::session_registry::SessionRegistry::remove`]). `Drop` calls it as a safety net (a
    /// no-op if already removed).
    pub fn shutdown(&self) {
        if self.reaped.swap(true, Ordering::SeqCst) {
            // A `stop` came first: the child is already dead and collected, so close the stream now
            // rather than waiting on the reader. That wait exists to let a dying child's last output
            // through, and here the teardown is deliberate — nobody is looking for those bytes. The
            // reader is not joined either: `Drop` reaches this branch too, on whatever task held the
            // last `Arc`, and a join can take as long as a descendant that escaped the kill keeps the
            // pty slave open. That reader is also why the history is dropped here — it would otherwise
            // keep appending to a buffer nothing sums any more.
            let mut inner = lock_recover(&self.inner);
            inner.tx = None;
            inner.retain = false;
            inner.scrollback = ScrollbackBuffer::new();
            return;
        }
        self.kill();
        self.reap();
        if let Some(handle) = lock_recover(&self.reader_handle).take() {
            let _ = handle.join();
        }
        // After the join, so the reader's last chunks are out. Ends every attached bridge, so a client
        // does not sit rendering a session that is gone — including one that missed the reconnect notice.
        self.close_output();
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// The pid `waitid` reported, which the two platforms expose differently.
#[cfg(target_os = "macos")]
fn siginfo_pid(info: &libc::siginfo_t) -> libc::pid_t {
    info.si_pid
}

#[cfg(all(unix, not(target_os = "macos")))]
fn siginfo_pid(info: &libc::siginfo_t) -> libc::pid_t {
    unsafe { info.si_pid() }
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
    /// Marks the reader finished however the thread leaves — including a panic, which would otherwise
    /// leave the stream unclosable and every attached bridge waiting on output that can never come.
    struct MarkDone(Arc<Mutex<Inner>>);
    impl Drop for MarkDone {
        fn drop(&mut self) {
            lock_recover(&self.0).reader_done = true;
        }
    }
    let _done = MarkDone(Arc::clone(&inner));

    let mut buf = [0u8; READ_CHUNK];
    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        let chunk: Arc<[u8]> = Arc::from(&buf[..n]);
        let mut guard = lock_recover(&inner);
        if !guard.retain {
            // Torn down: whatever still holds the pty open is no longer this terminal's history.
            continue;
        }
        guard.scrollback.push(chunk.as_ref());
        guard.parser.process(chunk.as_ref());
        // Err if there are no subscribers. Dropped output is handled on the subscriber side via
        // replay/Lagged, so it is ignored here.
        if let Some(tx) = &guard.tx {
            let _ = tx.send(chunk);
        }
    }
    // `MarkDone` records the finish; see `close_output` for what waits on it.
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

    /// A child that ends on its own is reported as exited while staying unreaped, so its pid is still
    /// reserved; teardown is what collects it and frees the pid.
    #[cfg(unix)]
    #[tokio::test]
    async fn has_exited_reports_without_reaping_and_teardown_collects() {
        let session = PtySession::spawn(sh("exit 0")).unwrap();
        let pid = session.pid() as i32;
        let deadline = Instant::now() + Duration::from_millis(3000);
        while !session.has_exited() {
            assert!(
                Instant::now() < deadline,
                "a finished child should be reported as exited"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(
            unsafe { libc::kill(pid, 0) },
            0,
            "the pid should stay reserved until teardown collects it"
        );

        session.shutdown();
        assert!(
            wait_until_dead(pid, 2000).await,
            "teardown should leave no zombie"
        );
    }

    /// Teardown after `has_exited` has reported the exit still completes: the child is collected and
    /// the reader thread joined, rather than either being skipped.
    #[cfg(unix)]
    #[tokio::test]
    async fn shutdown_after_has_exited_still_joins_the_reader() {
        let session = PtySession::spawn(sh("exit 0")).unwrap();
        let deadline = Instant::now() + Duration::from_millis(3000);
        while !session.has_exited() {
            assert!(Instant::now() < deadline, "the child should end on its own");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        session.shutdown();
        assert!(
            lock_recover(&session.reader_handle).is_none(),
            "shutdown should still join the reader thread"
        );
    }

    /// Teardown closes the output stream, so an attached bridge stops waiting on a session that is
    /// gone. Without this a client that missed the reconnect notice would render a dead PTY forever.
    #[tokio::test]
    async fn shutdown_closes_subscribers() {
        let session = PtySession::spawn(sh("sleep 30")).unwrap();
        let mut sub = session.subscribe();
        session.shutdown();
        assert!(
            matches!(sub.receiver.recv().await, Err(broadcast::error::RecvError::Closed)),
            "a subscriber should see the stream close"
        );
        // A late subscriber gets a closed receiver too, rather than one that never yields.
        let mut late = session.subscribe();
        assert!(matches!(
            late.receiver.recv().await,
            Err(broadcast::error::RecvError::Closed)
        ));
    }

    /// The stream stays open while the child is alive, whatever the reader thread did. A reader that
    /// stops on a read error must not look like the session ending, or an attached term would go
    /// permanently deaf and dumb on a terminal that is still working.
    #[cfg(unix)]
    #[tokio::test]
    async fn output_stream_stays_open_while_the_child_lives() {
        let session = PtySession::spawn(sh("sleep 30")).unwrap();
        // Ask the way the poller does; the child is alive, so nothing should be closed.
        assert!(!session.has_exited());
        let mut sub = session.subscribe();
        assert!(
            tokio::time::timeout(Duration::from_millis(100), sub.receiver.recv())
                .await
                .is_err(),
            "a live session's stream should be open and simply idle"
        );
        session.shutdown();
    }

    /// Once the child has ended, the next poll closes the stream so attached terms learn about it —
    /// teardown may never come, since an exited terminal stays registered to be restarted.
    #[cfg(unix)]
    #[tokio::test]
    async fn observing_the_exit_closes_the_output_stream() {
        let session = PtySession::spawn(sh("exit 0")).unwrap();
        let deadline = Instant::now() + Duration::from_millis(3000);
        while !session.has_exited() {
            assert!(Instant::now() < deadline, "the child should end on its own");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let mut sub = session.subscribe();
        assert!(matches!(
            sub.receiver.recv().await,
            Err(broadcast::error::RecvError::Closed)
        ));
    }

    /// The child's last output is the reason it died, so observing the exit must not cut the stream
    /// before those bytes are forwarded.
    #[cfg(unix)]
    #[tokio::test]
    async fn the_last_output_before_an_exit_still_reaches_subscribers() {
        let session = PtySession::spawn(sh("printf 'dying-words\\n'; exit 3")).unwrap();
        let mut sub = session.subscribe();
        // Ask the way the poller does, as early as possible, while the reader may still be forwarding.
        let deadline = Instant::now() + Duration::from_millis(3000);
        while !session.has_exited() {
            assert!(Instant::now() < deadline, "the child should end on its own");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let seen = drain_until(&mut sub, "dying-words", 2000).await;
        assert!(seen.contains("dying-words"), "got {seen:?}");
    }

    /// A restart stops the old session without waiting for its reader; closing that terminal afterwards
    /// must still finish the job, or an attached bridge would sit on a stream that never closes.
    #[cfg(unix)]
    #[tokio::test]
    async fn shutdown_after_stop_still_closes_the_stream() {
        let session = PtySession::spawn(sh("sleep 30")).unwrap();
        let mut sub = session.subscribe();
        session.stop();
        session.shutdown();
        // Bounded: a stream that never closes should fail the test, not hang the suite.
        let closed = tokio::time::timeout(Duration::from_millis(2000), sub.receiver.recv()).await;
        assert!(
            matches!(closed, Ok(Err(broadcast::error::RecvError::Closed))),
            "got {closed:?}"
        );
    }

    /// A replaced session stops retaining output. Its reader can outlive the teardown — a descendant
    /// that escaped the group kill keeps the pty open — and nothing sums that buffer any more. The
    /// history survives `stop` itself, because a relaunch that fails leaves this session in the row.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_replaced_session_keeps_no_more_scrollback() {
        let session = PtySession::spawn(sh("printf 'before\\n'; sleep 30")).unwrap();
        let mut sub = session.subscribe();
        drain_until(&mut sub, "before", 2000).await;
        assert!(session.scrollback_len() > 0);

        session.stop();
        assert!(
            session.scrollback_len() > 0,
            "a stopped session still holds its history for a failed relaunch"
        );

        session.discard_history();
        assert_eq!(session.scrollback_len(), 0);
    }

    /// Closing a terminal that a failed relaunch left stopped still releases its history: the row is
    /// going away, and a reader kept alive by a stray descendant would otherwise grow a buffer the
    /// scrollback-memory monitor no longer sums.
    #[cfg(unix)]
    #[tokio::test]
    async fn closing_a_stopped_session_releases_its_history() {
        let session = PtySession::spawn(sh("printf 'before\\n'; sleep 30")).unwrap();
        let mut sub = session.subscribe();
        drain_until(&mut sub, "before", 2000).await;
        session.stop();
        assert!(session.scrollback_len() > 0);

        session.shutdown();
        assert_eq!(session.scrollback_len(), 0);
    }

    /// A running child is not reported as exited.
    #[cfg(unix)]
    #[tokio::test]
    async fn has_exited_is_false_while_the_child_runs() {
        let session = PtySession::spawn(sh("sleep 5")).unwrap();
        assert!(!session.has_exited());
        session.shutdown();
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

    /// A descendant that outlives the leader is still killed once the poller has seen the leader end.
    /// Reporting the exit leaves the child unreaped, so the pgid stays this terminal's and the group
    /// form of kill keeps reaching what is left of it.
    #[cfg(unix)]
    #[tokio::test]
    async fn kill_after_has_exited_still_reaches_surviving_group_members() {
        // Ignoring HUP is what makes this the interesting case: the descendant survives the leader
        // (and the pty hangup that follows it), so only the group kill can still reach it. The leader
        // waits before exiting so the trap is in place by the time the hangup arrives.
        let session =
            PtySession::spawn(sh("(trap '' HUP; sleep 60) & echo GPID=$!; sleep 0.3; exit 0"))
                .unwrap();
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

        let deadline = Instant::now() + Duration::from_millis(3000);
        while !session.has_exited() {
            assert!(Instant::now() < deadline, "the leader should exit on its own");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(
            unsafe { libc::kill(gpid, 0) },
            0,
            "grandchild {gpid} should outlive the reaped leader"
        );

        session.kill();
        assert!(
            wait_until_dead(gpid, 3000).await,
            "grandchild {gpid} should still die with the process group after the reap"
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

    fn restore_seq(feed: &[u8]) -> Vec<u8> {
        let mut parser = vt100::Parser::new(24, 80, 0);
        parser.process(feed);
        screen_restore_sequence(parser.screen())
    }

    #[test]
    fn restore_sequence_reasserts_active_mouse_tracking() {
        // A Cockpit Terminal whose Claude Session enabled mouse tracking: switching to it must re-enable
        // it on the shared xterm.
        let seq = restore_seq(b"\x1b[?1002h\x1b[?1006h");
        assert!(contains(&seq, b"\x1b[?1002h"), "missing mouse DECSET: {seq:?}");
    }

    #[test]
    fn restore_sequence_clears_mouse_tracking_when_inactive() {
        // A terminal with mouse tracking off: its redraw must actively DECRST so it clears another
        // terminal's leaked tracking from the shared xterm, and must not spuriously enable it.
        let seq = restore_seq(b"idle");
        assert!(contains(&seq, b"\x1b[?1002l"), "missing mouse DECRST: {seq:?}");
        assert!(!contains(&seq, b"\x1b[?1002h"), "unexpected mouse DECSET: {seq:?}");
    }

    #[test]
    fn restore_sequence_does_not_reenable_mouse_toggled_off() {
        // Enabled then disabled within the terminal -> ends off; the redraw must not re-enable it.
        let seq = restore_seq(b"\x1b[?1002h\x1b[?1002l");
        assert!(!contains(&seq, b"\x1b[?1002h"), "unexpected mouse DECSET: {seq:?}");
        assert!(contains(&seq, b"\x1b[?1002l"), "missing mouse DECRST: {seq:?}");
    }

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        haystack.windows(needle.len()).any(|w| w == needle)
    }

    #[test]
    fn opening_a_pty_retries_a_transient_failure() {
        let attempts = std::cell::Cell::new(0);

        let opened = open_pty_with_retry(|| {
            attempts.set(attempts.get() + 1);
            if attempts.get() < OPENPTY_ATTEMPTS {
                Err("transient")
            } else {
                Ok("opened")
            }
        });

        assert_eq!(opened, Ok("opened"));
        assert_eq!(attempts.get(), OPENPTY_ATTEMPTS);
    }

    #[test]
    fn opening_a_pty_gives_up_once_the_attempts_are_spent() {
        let attempts = std::cell::Cell::new(0);

        let opened: Result<&str, &str> = open_pty_with_retry(|| {
            attempts.set(attempts.get() + 1);
            Err("unavailable")
        });

        assert_eq!(opened, Err("unavailable"));
        assert_eq!(attempts.get(), OPENPTY_ATTEMPTS);
    }
}
