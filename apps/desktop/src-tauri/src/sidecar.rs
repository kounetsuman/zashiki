//! sidecar server management (the shell starts and monitors the server, and on
//! exit performs a graceful shutdown only if it started the server itself. The
//! tmux session is left running).
//!
//! The decision logic is split into small, cargo-test-able functions.
//! Every stage is emitted to stderr as a progress log (for diagnosability on crash).

use std::collections::VecDeque;
use std::io::{BufRead as _, BufReader, Read as _, Write as _};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const DEFAULT_PORT: u16 = 8790;
const CONNECT_TIMEOUT: Duration = Duration::from_millis(500);
const READ_CHUNK_TIMEOUT: Duration = Duration::from_millis(500);
/// Upper bound for a whole request (guaranteed to return even if the peer never closes the connection).
const RESPONSE_DEADLINE: Duration = Duration::from_secs(3);
const SPAWN_HEALTH_TIMEOUT: Duration = Duration::from_secs(15);
const TOKEN_VERIFY_TIMEOUT: Duration = Duration::from_secs(3);
const POLL_INTERVAL: Duration = Duration::from_millis(200);
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);
/// Number of trailing stderr lines to retain for diagnostics when the server dies.
const STDERR_TAIL_LINES: usize = 20;

pub struct Config {
    pub port: u16,
    pub token_path: PathBuf,
    /// The server binary to launch (the Rust zashiki-server), exec'd directly by the sidecar.
    pub server_bin: PathBuf,
    /// The client dist served statically by the server. In the distributed .app this is a bundled
    /// resource (Contents/Resources/client-dist); in dev it may not exist (the dev WebView opens
    /// Vite:5173 and does not use the server's static serving, so a dist that is absent at spawn
    /// time is not passed as ZK_CLIENT_DIST).
    pub client_dist: PathBuf,
    /// The real bundle version (app.package_info().version), passed to the server as ZK_APP_VERSION so it can
    /// compare against GitHub Releases (#26). The server's own Cargo version stays at the 0.0.0 placeholder, so
    /// this is the only channel carrying the real version. Empty / 0.0.0 (dev) disables the server's update check.
    pub app_version: String,
}

impl Config {
    /// Resolves using the same environment variable scheme as the server (ZK_*).
    /// The token and binary can each be overridden so that tests do not touch the real ~/.zashiki.
    pub fn from_env() -> Self {
        let port = std::env::var("ZK_PORT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(DEFAULT_PORT);
        let token_path = std::env::var("ZK_TOKEN_FILE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| default_token_path());
        let server_bin = std::env::var("ZK_SERVER_BIN")
            .map(PathBuf::from)
            .unwrap_or_else(|_| default_server_bin());
        let client_dist = std::env::var_os("ZK_CLIENT_DIST")
            .map(PathBuf::from)
            .unwrap_or_else(default_client_dist);
        Self {
            port,
            token_path,
            server_bin,
            client_dist,
            // Filled in from app.package_info().version at setup time (main.rs); the env has no real version here.
            app_version: String::new(),
        }
    }
}

fn default_token_path() -> PathBuf {
    // The server writes to ~/.zashiki/token under $HOME (zashiki-server main.rs).
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".zashiki").join("token")
}

/// Resolves the Rust server binary to launch. In the distributed .app it uses the `zashiki-server`
/// bundled in the same directory as this shell executable; in development it uses the cargo output
/// inside the repository.
fn default_server_bin() -> PathBuf {
    let exe = std::env::current_exe().ok();
    let exe_dir = exe.as_deref().and_then(Path::parent);
    let cargo_target =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../crates/zashiki-server/target");
    resolve_server_bin(!cfg!(debug_assertions), exe_dir, &cargo_target)
}

/// Pure logic for resolving the server binary (with current_exe / profile / paths injected from
/// `default_server_bin`).
///
/// - bundled (release build = distributed .app): prefers the bundled sibling `zashiki-server`,
///   falling back to the cargo output (release, then debug) if it is absent.
/// - dev (debug build): does **not** look at the sibling. In tauri's `target/debug`, an externalBin
///   `#!/bin/sh` stub (which exits 0 immediately) can appear under the same name; grabbing it makes
///   the server "exit before startup". In dev, beforeDevCommand builds debug, so it prefers the
///   cargo debug output and falls back to release if absent.
fn resolve_server_bin(bundled: bool, exe_dir: Option<&Path>, cargo_target: &Path) -> PathBuf {
    let release = cargo_target.join("release/zashiki-server");
    let debug = cargo_target.join("debug/zashiki-server");
    if bundled {
        if let Some(sibling) = exe_dir.map(|dir| dir.join("zashiki-server")) {
            if sibling.is_file() {
                return sibling;
            }
        }
        if release.is_file() {
            return release;
        }
        return debug;
    }
    if debug.is_file() {
        return debug;
    }
    release
}

/// Resolves the client dist served statically by the server. In the distributed .app it points from
/// the executable (Contents/MacOS/Zashiki) to `../Resources/client-dist` (the bundled resource);
/// in development it points to the repository's `packages/client/dist` (in dev it may be absent
/// since the WebView opens Vite:5173).
fn default_client_dist() -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let bundled = bundled_client_dist(dir);
            if bundled.is_dir() {
                return bundled;
            }
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../packages/client/dist")
}

/// Pure function deriving the path to the bundled client dist (Contents/Resources/client-dist)
/// from the distributed .app's executable directory (Contents/MacOS).
/// Corresponds to `bundle.resources` in tauri.conf.json (client-dist -> Contents/Resources/client-dist).
fn bundled_client_dist(exe_dir: &Path) -> PathBuf {
    exe_dir.join("../Resources/client-dist")
}

/// Progress log for the startup sequence. If the accident of stderr not being retained on crash
/// recurs, this lets the terminal side trace which stage took how many seconds.
pub struct StepLog {
    started: Instant,
}

impl StepLog {
    pub fn new() -> Self {
        Self {
            started: Instant::now(),
        }
    }

    pub fn log(&self, msg: &str) {
        eprintln!(
            "[zashiki-shell +{:>6.1}s] {msg}",
            self.started.elapsed().as_secs_f64()
        );
    }
}

// ---- HTTP (only healthz / token verification on 127.0.0.1, so raw TCP suffices; avoid adding dependencies) ----

fn http_get(
    port: u16,
    path: &str,
    extra_headers: &[(&str, &str)],
) -> std::io::Result<(u16, String)> {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, CONNECT_TIMEOUT)?;
    stream.set_read_timeout(Some(READ_CHUNK_TIMEOUT))?;
    stream.set_write_timeout(Some(READ_CHUNK_TIMEOUT))?;
    let mut req = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n");
    for (name, value) in extra_headers {
        req.push_str(&format!("{name}: {value}\r\n"));
    }
    req.push_str("\r\n");
    stream.write_all(req.as_bytes())?;

    // The read timeout is per-read only, so against a peer that never closes the connection
    // read_to_end would be unbounded. Use incremental reads with an overall deadline plus
    // content-length completion detection.
    let deadline = Instant::now() + RESPONSE_DEADLINE;
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        if response_complete(&buf) {
            break;
        }
        if Instant::now() >= deadline {
            break;
        }
        match stream.read(&mut chunk) {
            Ok(0) => break, // EOF
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                continue; // per-read timeout; fall through to the deadline check
            }
            Err(e) => return Err(e),
        }
    }
    let text = String::from_utf8_lossy(&buf).into_owned();
    parse_http_response(&text).ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, "malformed HTTP response")
    })
}

/// Content-length-based response completion detection (node's res.end() produces a content-length
/// response). For header configurations where this cannot be determined, returns false and defers
/// to EOF or the deadline.
pub fn response_complete(buf: &[u8]) -> bool {
    let text = String::from_utf8_lossy(buf);
    let Some((head, body)) = text.split_once("\r\n\r\n") else {
        return false;
    };
    let Some(len) = head.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        if name.trim().eq_ignore_ascii_case("content-length") {
            value.trim().parse::<usize>().ok()
        } else {
            None
        }
    }) else {
        return false;
    };
    body.len() >= len
}

pub fn parse_http_response(raw: &str) -> Option<(u16, String)> {
    let (head, body) = raw.split_once("\r\n\r\n").unwrap_or((raw, ""));
    let status_line = head.lines().next()?;
    let mut parts = status_line.split(' ');
    let version = parts.next()?;
    if !version.starts_with("HTTP/") {
        return None;
    }
    let status: u16 = parts.next()?.parse().ok()?;
    Some((status, body.to_string()))
}

/// To avoid mistaking the case where another process merely occupies 8790 for "the server is
/// running", checks the healthz body in addition to the status.
pub fn is_healthy_response(status: u16, body: &str) -> bool {
    status == 200 && body.contains("\"status\":\"ok\"")
}

pub fn check_health(port: u16) -> bool {
    matches!(http_get(port, "/healthz", &[]), Ok((status, body)) if is_healthy_response(status, &body))
}

/// This build's own git SHA (embedded by build.rs). Compared against healthz's `git_sha` to avoid
/// riding along on a stale server. On builds where embedding is not possible it becomes "unknown",
/// in which case no comparison is done (with no basis to decide, it falls back to riding along).
pub const EXPECTED_GIT_SHA: &str = env!("ZK_GIT_SHA");

/// Grace period to wait after sending SIGTERM to a stale server until the port is released (healthz
/// disappears). On SIGTERM the server does a "save session -> withdraw" (graceful). Since healthz
/// keeps responding during the save, this is set longer than the server-side total withdrawal limit
/// (main.rs `SHUTDOWN_BUDGET` = 10s) so as **not to interrupt the save**. Exceeding it means "it hung
/// beyond its own budget" = last-resort SIGKILL.
const STALE_RELEASE_TIMEOUT: Duration = Duration::from_secs(12);

/// Result of the ride-along decision. `Reuse` rides along as before; `Stale` re-acquires (kill -> spawn our own).
#[derive(Debug, PartialEq, Eq)]
pub enum ReuseDecision {
    Reuse,
    Stale,
}

/// Extracts a top-level string field from healthz (JSON).
fn healthz_str_field(body: &str, key: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()?
        .get(key)?
        .as_str()
        .map(str::to_string)
}

/// The server's own pid as declared by healthz. None for old servers that don't support the build ID.
/// pid <= 0 is not accepted: passing a negative value or 0 to `libc::kill` sends the signal to a
/// process group or all processes (POSIX), so this structurally prevents self-destruction from a
/// corrupt or malicious healthz.
pub fn healthz_pid(body: &str) -> Option<i32> {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()?
        .get("pid")?
        .as_i64()
        .and_then(|p| i32::try_from(p).ok())
        .filter(|&p| p > 0)
}

/// Pure function that, assuming healthz is healthy ([`is_healthy_response`]==true), decides whether
/// it is OK to ride along.
/// - dev(debug) build: always rides along, since `git_sha` changes on every rebuild and would drag
///   the session down with it.
/// - this build's `git_sha` is "unknown" (a build where embedding is not possible): rides along, as
///   there is no basis to decide.
/// - healthz's `git_sha` matches expected: rides along.
/// - mismatch, or `git_sha` missing (an old server that doesn't support the build ID): stale.
pub fn classify_reuse(is_dev: bool, expected_sha: &str, body: &str) -> ReuseDecision {
    if is_dev || expected_sha == "unknown" {
        return ReuseDecision::Reuse;
    }
    match healthz_str_field(body, "git_sha") {
        Some(sha) if sha == expected_sha => ReuseDecision::Reuse,
        _ => ReuseDecision::Stale,
    }
}

/// Extracts the single LISTENing pid from `lsof -t` output (newline-separated pids).
/// Multiple pids (fork workers, shared fds, etc.) are treated as "ambiguous which to kill", returning
/// None to avoid collateral damage (healthz's pid takes priority; this is a fallback for old servers).
pub fn parse_lsof_pid(output: &str) -> Option<i32> {
    let pids: Vec<i32> = output
        .lines()
        .filter_map(|line| line.trim().parse().ok())
        .filter(|&pid| pid > 0)
        .collect();
    match pids.as_slice() {
        [pid] => Some(*pid),
        _ => None,
    }
}

/// Whether the server's `/` (static serving of the client dist, no token required) returns an HTML
/// document. Riding along on a server that does not serve it (occupying 8790 without a client dist)
/// makes `/` return 401/404 and leaves the WebView blank, so this detects that and turns it into an
/// error with remediation.
pub fn serves_client_ui(port: u16) -> bool {
    matches!(http_get(port, "/", &[]), Ok((status, body)) if status == 200 && is_html_document(&body))
}

/// Whether the response body is an HTML document (detecting the client's index.html). Ignores leading whitespace and is case-insensitive.
pub fn is_html_document(body: &str) -> bool {
    let head = body.trim_start().to_ascii_lowercase();
    head.starts_with("<!doctype html") || head.starts_with("<html")
}

// ---- Token ----

/// The ~/.zashiki/token written by the server is a hex string (index.ts: randomBytes.toString("hex")).
/// Accepting only alphanumerics structurally eliminates encoding problems when injecting into the initial URL.
pub fn read_token(path: &Path) -> Result<String, String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("トークンファイル {} を読めません: {e}", path.display()))?;
    let token = raw.trim();
    if token.is_empty() {
        return Err(format!("トークンファイル {} が空です", path.display()));
    }
    if !token.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(format!(
            "トークンファイル {} の内容が不正です（英数字以外を含む）",
            path.display()
        ));
    }
    Ok(token.to_string())
}

/// Confirms via a real request whether the token is accepted by the current server
/// (detecting the accident of grabbing a stale token file from a previous launch).
///
/// Migrated to the dedicated endpoint `/api/zk-shell/token-probe` (a strict contract).
/// Only when the token is accepted does the server return 200 + body `{"ok":true}` (a dedicated
/// branch, not the catch-all; app.ts). By checking for both 200 and `"ok":true` in the body, a case
/// where the contract breaks in a merge regression and falls back to the catch-all's implicit 200
/// (`hello`) can be detected without being mistaken for "token accepted". As with
/// is_healthy_response, verifying both "status + body" is the crux of the strict contract (status
/// alone could pick up the catch-all's 200 due to path variations such as a trailing slash).
pub fn verify_token(port: u16, token: &str) -> bool {
    matches!(
        http_get(port, "/api/zk-shell/token-probe", &[("x-zashiki-token", token)]),
        Ok((status, body)) if status == 200 && body.contains("\"ok\":true")
    )
}

/// In-flight work reported by the server's `GET /api/activity`, for the guarded quit (#65).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Activity {
    pub active_sessions: u32,
    pub running_subagents: u32,
    pub background_shells: u32,
}

impl Activity {
    pub fn is_busy(&self) -> bool {
        self.active_sessions + self.running_subagents + self.background_shells > 0
    }

    /// e.g. "2 sessions, 1 background agent, 1 background shell still running".
    pub fn summary(&self) -> String {
        let mut parts = Vec::new();
        if self.active_sessions > 0 {
            parts.push(plural(self.active_sessions, "session"));
        }
        if self.running_subagents > 0 {
            parts.push(plural(self.running_subagents, "background agent"));
        }
        if self.background_shells > 0 {
            parts.push(plural(self.background_shells, "background shell"));
        }
        format!("{} still running", parts.join(", "))
    }
}

fn plural(n: u32, singular: &str) -> String {
    if n == 1 {
        format!("1 {singular}")
    } else {
        format!("{n} {singular}s")
    }
}

/// Parses the `GET /api/activity` JSON body (None if malformed or a field is missing).
pub fn parse_activity(body: &str) -> Option<Activity> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let field = |key: &str| v.get(key).and_then(serde_json::Value::as_u64);
    Some(Activity {
        active_sessions: field("activeSessions")? as u32,
        running_subagents: field("runningSubagents")? as u32,
        background_shells: field("backgroundShells")? as u32,
    })
}

/// Queries the server for in-flight work. None when the request fails or the body is malformed, which
/// the caller treats as "nothing to protect" so an unreachable server never blocks quitting.
pub fn fetch_activity(port: u16, token: &str) -> Option<Activity> {
    match http_get(port, "/api/activity", &[("x-zashiki-token", token)]) {
        Ok((200, body)) => parse_activity(&body),
        _ => None,
    }
}

/// The token is already validated as alphanumeric-only by read_token, so no URL encoding is needed.
pub fn initial_url(base: &str, token: &str) -> String {
    format!("{base}/?token={token}")
}

// ---- Debug mode (enabling the WebView's devtools via `debug` in config.json) ----

/// Resolves the same live-reload config file as the server (ZK_CONFIG, or ~/.zashiki/config.json if unset).
/// The server toggles the client's DebugPanel via `debug` in the same file, and the shell toggles the
/// WebView's devtools via the same flag (= a single "debug mode" drives both together).
pub fn config_path_from_env() -> PathBuf {
    std::env::var_os("ZK_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(default_config_path)
}

fn default_config_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".zashiki").join("config.json")
}

/// Pure function that reads `debug` from config.json leniently. Absent, corrupt, non-object,
/// type-mismatched, or missing all yield false (the same "default false" contract as the server's
/// `parse_config`).
pub fn parse_debug_flag(json_text: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(json_text)
        .ok()
        .as_ref()
        .and_then(|v| v.as_object())
        .and_then(|o| o.get("debug"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// Reads config.json and resolves the debug flag. If it cannot be read (absent, permissions), false.
pub fn read_debug_flag(path: &Path) -> bool {
    std::fs::read_to_string(path)
        .ok()
        .map(|text| parse_debug_flag(&text))
        .unwrap_or(false)
}

/// Pure decision on whether to enable the WebView's devtools (web inspector).
/// dev (`tauri dev`) is always enabled regardless of config so as not to degrade the developer
/// experience. Builds produced by `tauri build` (the distributed .app, including `--debug`) are
/// enabled only when `debug` in config.json is true (devtools can be used only when turned ON via
/// the config file).
///
/// The dev decision injects the same `tauri::is_dev()` (= custom-protocol disabled) as base_url.
/// With `cfg!(debug_assertions)`, `tauri build --debug` would be treated as dev, opening devtools on
/// a distribution-equivalent build while ignoring config (diverging from base_url, which behaves as
/// production).
pub fn devtools_enabled(config_debug: bool, is_dev: bool) -> bool {
    is_dev || config_debug
}

// ---- sidecar lifecycle ----

#[derive(Debug)]
pub enum ServerHandle {
    /// Rode along on an already-running server (not owned by the shell -> not killed on exit).
    External,
    /// Spawned by this shell (gracefully shut down on exit).
    Owned(Child),
}

/// Streams the child's stderr to the parent's stderr while retaining the last N lines for diagnostics
/// (to include "why it died" in the error message when the server dies immediately).
fn tee_stderr(child: &mut Child) -> Arc<Mutex<VecDeque<String>>> {
    let tail: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
    if let Some(stderr) = child.stderr.take() {
        let tail_writer = Arc::clone(&tail);
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                eprintln!("[zashiki-server] {line}");
                if let Ok(mut tail) = tail_writer.lock() {
                    if tail.len() >= STDERR_TAIL_LINES {
                        tail.pop_front();
                    }
                    tail.push_back(line);
                }
            }
        });
    }
    tail
}

fn stderr_tail_text(tail: &Arc<Mutex<VecDeque<String>>>) -> String {
    // Grace for the tee thread to finish writing the tail.
    std::thread::sleep(Duration::from_millis(200));
    match tail.lock() {
        Ok(tail) if !tail.is_empty() => format!(
            "\nserver stderr（末尾）:\n{}",
            tail.iter()
                .map(|l| format!("  {l}"))
                .collect::<Vec<_>>()
                .join("\n")
        ),
        _ => String::new(),
    }
}

/// Pure function that assembles the ZK_* environment variables passed to the spawned server.
/// client_dist is passed as ZK_CLIENT_DIST only when it is an existing directory (in dev, even if the
/// dist is not generated, the server is not killed and simply has no static serving = preserving
/// current behavior).
fn spawn_env(cfg: &Config) -> Vec<(&'static str, String)> {
    let mut env = vec![
        ("ZK_PORT", cfg.port.to_string()),
        (
            "ZK_TOKEN_FILE",
            cfg.token_path.to_string_lossy().into_owned(),
        ),
        // The real bundle version so the server can run the update check (#26). 0.0.0/dev no-ops server-side.
        ("ZK_APP_VERSION", cfg.app_version.clone()),
    ];
    if cfg.client_dist.is_dir() {
        env.push((
            "ZK_CLIENT_DIST",
            cfg.client_dist.to_string_lossy().into_owned(),
        ));
    }
    env
}

/// Identifies the LISTENing pid via lsof. A fallback for old servers whose healthz does not return a
/// pid (assumes macOS; returns None and gives up killing when lsof is absent or there are multiple pids).
fn listener_pid(port: u16) -> Option<i32> {
    let out = Command::new("lsof")
        .args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-t"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_lsof_pid(&String::from_utf8_lossy(&out.stdout))
}

/// Waits until the healthz response disappears (= the port is released and becomes bindable).
fn wait_port_released(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if !check_health(port) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

/// Gracefully brings down a stale server to release the port. Targeting prioritizes the pid declared
/// by healthz (to avoid collateral damage and PID reuse); for old servers (missing pid) it falls back
/// to the LISTENing pid from lsof. If SIGTERM does not release it within the grace period, SIGKILL.
/// Returns whether it was released (= whether it is now OK to spawn our own).
fn reclaim_stale_server(port: u16, healthz_body: &str, log: &StepLog) -> bool {
    let Some(pid) = healthz_pid(healthz_body).or_else(|| listener_pid(port)) else {
        log.log(&format!(
            "stale server の pid を特定できませんでした（healthz に pid 無し・lsof も不定）。掴み直しを断念します（port {port}）"
        ));
        return false;
    };
    log.log(&format!(
        "stale server (pid={pid}) へ SIGTERM（graceful 撤収を最大 {}s 待つ）",
        STALE_RELEASE_TIMEOUT.as_secs()
    ));
    #[cfg(unix)]
    unsafe {
        libc::kill(pid, libc::SIGTERM);
    }
    if wait_port_released(port, STALE_RELEASE_TIMEOUT) {
        log.log("stale server が撤収し port が解放 → 自前 spawn へ");
        return true;
    }
    log.log(&format!(
        "猶予内に port {port} が解放されませんでした → SIGKILL"
    ));
    #[cfg(unix)]
    unsafe {
        libc::kill(pid, libc::SIGKILL);
    }
    wait_port_released(port, Duration::from_secs(2))
}

pub fn ensure_server(cfg: &Config, log: &StepLog) -> Result<ServerHandle, String> {
    log.log(&format!("healthz 確認: http://127.0.0.1:{}/healthz", cfg.port));
    if let Ok((status, body)) = http_get(cfg.port, "/healthz", &[]) {
        if is_healthy_response(status, &body) {
            match classify_reuse(cfg!(debug_assertions), EXPECTED_GIT_SHA, &body) {
                ReuseDecision::Reuse => {
                    log.log("既存 server が稼働中（ビルド一致）→ 相乗りする（終了時に殺さない）");
                    return Ok(ServerHandle::External);
                }
                ReuseDecision::Stale => {
                    log.log(
                        "healthz は健全だがビルド ID 不一致（stale server）→ graceful に掴み直す（issue #340）",
                    );
                    if !reclaim_stale_server(cfg.port, &body, log) {
                        log.log(
                            "stale server を落とせませんでした → 起動不能を避けるためやむを得ず相乗り（要調査）",
                        );
                        return Ok(ServerHandle::External);
                    }
                    // Port already released. Re-acquire ownership via the spawn path below.
                }
            }
        }
    }
    if !cfg.server_bin.is_file() {
        return Err(format!(
            "server バイナリ {} がありません。\n対処: `cargo build --release --manifest-path crates/zashiki-server/Cargo.toml` を実行してください（配布ビルドへの sidecar 同梱は apps/desktop/README.md 参照）",
            cfg.server_bin.display()
        ));
    }
    log.log(&format!(
        "server 未稼働 → spawn: {}（ZK_PORT={}）",
        cfg.server_bin.display(),
        cfg.port
    ));
    // In the distributed .app, base_url opens the server's `/`, so whether static serving is present
    // determines the UI display. To avoid a silent 404 (blank screen), record whether serving is
    // available in the diagnostic log (following the progress-log policy).
    if cfg.client_dist.is_dir() {
        log.log(&format!("client dist を配信させる: {}", cfg.client_dist.display()));
    } else {
        log.log(&format!(
            "client dist 未配信: {} が無い（dev は Vite:5173 が配信。配布 .app でこれが出るなら UI が 404 になる）",
            cfg.client_dist.display()
        ));
    }
    let mut cmd = Command::new(&cfg.server_bin);
    // The server generates a token at startup and writes it to ZK_TOKEN_FILE. Keep it consistent with
    // where the sidecar reads from.
    // If a bundled client dist exists, pass it as ZK_CLIENT_DIST so the server serves it statically (distributed .app).
    for (name, value) in spawn_env(cfg) {
        cmd.env(name, value);
    }
    cmd.stdin(Stdio::null()).stderr(Stdio::piped());
    // Put the child in a dedicated process group so that SIGTERM to the child's pid reaches its
    // descendants, and shutdown sends to the whole group (bringing down grandchildren such as the
    // claude that the server launches).
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        unsafe {
            cmd.pre_exec(|| {
                libc::setpgid(0, 0);
                Ok(())
            });
        }
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| {
            format!(
                "server の起動に失敗（{}）: {e}\n対処: バイナリが実行可能か確認するか、ZK_SERVER_BIN でフルパスを指定してください",
                cfg.server_bin.display()
            )
        })?;
    let stderr_tail = tee_stderr(&mut child);
    let deadline = Instant::now() + SPAWN_HEALTH_TIMEOUT;
    loop {
        if check_health(cfg.port) {
            // Concurrent-startup race: if our child dies with EADDRINUSE and another instance is alive, treat it as riding along.
            return match child.try_wait() {
                Ok(Some(_)) => {
                    log.log("spawn した server は終了したが別インスタンスが健在 → 相乗り");
                    Ok(ServerHandle::External)
                }
                _ => {
                    log.log("spawn した server が healthz 応答 → 所有（終了時に graceful shutdown）");
                    Ok(ServerHandle::Owned(child))
                }
            };
        }
        if let Ok(Some(status)) = child.try_wait() {
            if check_health(cfg.port) {
                log.log("spawn した server は終了したが別インスタンスが健在 → 相乗り");
                return Ok(ServerHandle::External);
            }
            return Err(format!(
                "server が起動前に終了しました（{status}）。{}\n対処: ポート競合なら `lsof -nP -iTCP:{} -sTCP:LISTEN` で占有プロセスを確認してください。ビルドの問題なら `cargo build --release --manifest-path crates/zashiki-server/Cargo.toml` を再実行してください",
                stderr_tail_text(&stderr_tail),
                cfg.port
            ));
        }
        if Instant::now() >= deadline {
            shutdown(&mut child, Duration::from_secs(2));
            return Err(format!(
                "server が {}s 以内に /healthz へ応答しませんでした。{}\n対処: `{}` を直接実行して起動ログを確認してください",
                SPAWN_HEALTH_TIMEOUT.as_secs(),
                stderr_tail_text(&stderr_tail),
                cfg.server_bin.display()
            ));
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

/// Right after healthz OK, writing the token file (after listen) can lag slightly, so retry briefly
/// until it is "readable and accepted by the server".
pub fn resolve_verified_token(
    port: u16,
    token_path: &Path,
    log: &StepLog,
) -> Result<String, String> {
    log.log(&format!("トークン確認: {}", token_path.display()));
    let deadline = Instant::now() + TOKEN_VERIFY_TIMEOUT;
    loop {
        let last_err = match read_token(token_path) {
            Ok(token) => {
                if verify_token(port, &token) {
                    log.log("トークンを server が受理 → 初期 URL を組み立てる");
                    return Ok(token);
                }
                format!(
                    "トークンが server に受理されません（{} が古い可能性）。\n対処: 稼働中の server を再起動してください（シェルが spawn し直します）。`lsof -nP -iTCP:{port} -sTCP:LISTEN` で {port} の server が zashiki 本体か確認するのも有効です",
                    token_path.display()
                )
            }
            Err(e) => format!(
                "{e}\n対処: server が書くはずのファイルです。server 起動ログの `token file: …` の場所と HOME が一致しているか確認してください"
            ),
        };
        if Instant::now() >= deadline {
            return Err(last_err);
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}

/// Whether the WebView opens the UI from the server's own `/` (distributed .app). False in dev, which
/// opens Vite:5173. Pure function that decides based on whether base_url matches the server origin
/// (`http://127.0.0.1:<port>`).
fn ui_served_from_server(base_url: &str, port: u16) -> bool {
    base_url == format!("http://127.0.0.1:{port}")
}

/// Error body with remediation for when the distributed .app cannot display the UI (the server's `/`
/// is not serving the client dist). The wording is split depending on whether it rode along (on an
/// existing server) or spawned its own, since the cause differs.
fn client_ui_unavailable_message(port: u16, rode_along: bool, client_dist: &Path) -> String {
    if rode_along {
        format!(
            "{port} で既に稼働中の別の zashiki server が client UI を配信していません（この配布アプリの同梱 UI を表示できません）。\n\
             対処: 開発用サーバ（`tauri dev` / `cargo run`）を終了してから Zashiki.app を起動し直してください。\n\
             `lsof -nP -iTCP:{port} -sTCP:LISTEN` で {port} の占有プロセスを確認できます。"
        )
    } else {
        format!(
            "同梱 server は起動しましたが client UI（client dist）を配信できませんでした。\n\
             同梱物が壊れている可能性があります（期待パス: {}）。\n\
             対処: `pnpm -F @zashiki/desktop build:app` でビルドし直してください。",
            client_dist.display()
        )
    }
}

/// The full startup routine, from confirming the server is running to assembling the initial URL.
/// If it fails partway, a server that we spawned is not left running but brought down.
pub fn start(cfg: &Config, base_url: &str) -> Result<(String, Option<Child>), String> {
    let log = StepLog::new();
    let handle = ensure_server(cfg, &log)?;
    let rode_along = matches!(handle, ServerHandle::External);
    let mut owned = match handle {
        ServerHandle::Owned(child) => Some(child),
        ServerHandle::External => None,
    };
    let cleanup_owned = |owned: &mut Option<Child>| {
        if let Some(child) = owned.as_mut() {
            log.log("起動失敗 → spawn した server を掃除（SIGTERM）");
            shutdown(child, SHUTDOWN_GRACE);
        }
    };

    let token = match resolve_verified_token(cfg.port, &cfg.token_path, &log) {
        Ok(token) => token,
        Err(e) => {
            cleanup_owned(&mut owned);
            return Err(e);
        }
    };

    // The distributed .app opens base_url = the server origin, so confirm that `/` actually returns
    // the client UI. If the ride-along target does not serve the dist or the bundled resource is
    // missing, produce an error with remediation (the pages error screen) rather than a blank screen.
    if ui_served_from_server(base_url, cfg.port) && !serves_client_ui(cfg.port) {
        cleanup_owned(&mut owned);
        return Err(client_ui_unavailable_message(cfg.port, rode_along, &cfg.client_dist));
    }

    log.log(&format!("起動完了: {base_url}/?token=<{}桁>", token.len()));
    Ok((initial_url(base_url, &token), owned))
}

/// SIGTERM, then SIGKILL if it does not finish within the grace period.
/// Since it was placed in a dedicated process group at spawn time, the signal is sent to the whole
/// group (the shim + the actual node). tmux is an independent server process, so the session remains.
pub fn shutdown(child: &mut Child, grace: Duration) {
    #[cfg(unix)]
    {
        let pgid = child.id() as i32;
        unsafe { libc::kill(-pgid, libc::SIGTERM) };
        let deadline = Instant::now() + grace;
        loop {
            if let Ok(Some(_)) = child.try_wait() {
                break;
            }
            if Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        // SIGKILL any stragglers (such as the shim's children). Harmless if the group is already empty.
        unsafe { libc::kill(-pgid, libc::SIGKILL) };
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    /// Disposable server that accepts a single connection and returns a fixed response.
    /// close_after=false is a "peer that never closes the connection" (reproducing the unbounded read).
    fn serve_once_opts(response: &'static str, close_after: bool) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(response.as_bytes());
                if !close_after {
                    std::thread::sleep(Duration::from_secs(20));
                }
            }
        });
        port
    }

    fn serve_once(response: &'static str) -> u16 {
        serve_once_opts(response, true)
    }

    /// Disposable server that returns the real token-probe contract (200 + {"ok":true}) only when the
    /// request contains the needle, and 401 otherwise.
    fn serve_once_expecting(needle: &'static str) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let res = if req.contains(needle) {
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 11\r\n\r\n{\"ok\":true}"
                } else {
                    "HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n"
                };
                let _ = stream.write_all(res.as_bytes());
            }
        });
        port
    }

    fn closed_port() -> u16 {
        // A port bound and immediately dropped = a port that refuses connections.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    }

    /// A resident server that keeps returning healthz OK (accepting multiple connections). Simulates
    /// the situation where the port is "not released" (a stale server lingering). Lives until the test
    /// process exits.
    fn serve_healthy_forever() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                std::thread::spawn(move || {
                    let mut buf = [0u8; 4096];
                    let _ = stream.read(&mut buf);
                    let _ = stream.write_all(
                        b"HTTP/1.1 200 OK\r\ncontent-length: 15\r\n\r\n{\"status\":\"ok\"}",
                    );
                });
            }
        });
        port
    }

    #[test]
    fn parse_http_response_はステータスとボディを取り出す() {
        let raw = "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{\"status\":\"ok\"}";
        assert_eq!(
            parse_http_response(raw),
            Some((200, "{\"status\":\"ok\"}".to_string()))
        );
    }

    #[test]
    fn parse_http_response_はボディ無しも扱う() {
        assert_eq!(
            parse_http_response("HTTP/1.1 403 Forbidden\r\n\r\n"),
            Some((403, String::new()))
        );
    }

    #[test]
    fn parse_http_response_はhttpでないものを拒否する() {
        assert_eq!(parse_http_response("garbage"), None);
        assert_eq!(parse_http_response(""), None);
    }

    #[test]
    fn response_complete_はcontent_length到達で真() {
        assert!(response_complete(
            b"HTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\nhello"
        ));
        assert!(!response_complete(
            b"HTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\nhel"
        ));
        assert!(!response_complete(b"HTTP/1.1 200 OK\r\n")); // headers incomplete
        assert!(!response_complete(
            b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n0\r\n\r\n"
        )); // without content-length, defer to EOF/deadline
    }

    #[test]
    fn is_healthy_response_は200かつステータスokのみ真() {
        assert!(is_healthy_response(200, "{\"status\":\"ok\"}"));
        assert!(!is_healthy_response(200, "hello")); // another process occupying the port
        assert!(!is_healthy_response(403, "{\"status\":\"ok\"}"));
        assert!(!is_healthy_response(500, ""));
    }

    const CURRENT_BUILD: &str =
        r#"{"status":"ok","version":"0.0.0","git_sha":"abc123","pid":4242}"#;
    const OTHER_BUILD: &str =
        r#"{"status":"ok","version":"0.0.0","git_sha":"def456","pid":4242}"#;
    const LEGACY_BUILD: &str = r#"{"status":"ok"}"#; // an old server that doesn't support the build ID

    #[test]
    fn classify_reuse_は現行ビルドにのみ相乗りしstaleを掴み直す() {
        // release: git_sha matches -> ride along; mismatch/missing -> stale (re-acquire).
        assert_eq!(
            classify_reuse(false, "abc123", CURRENT_BUILD),
            ReuseDecision::Reuse
        );
        assert_eq!(
            classify_reuse(false, "abc123", OTHER_BUILD),
            ReuseDecision::Stale
        );
        assert_eq!(
            classify_reuse(false, "abc123", LEGACY_BUILD),
            ReuseDecision::Stale
        );
    }

    #[test]
    fn classify_reuse_はdevと不明ビルドでは常に相乗りする() {
        // dev(debug) changes git_sha on every rebuild = no comparison, to avoid dragging it down.
        assert_eq!(
            classify_reuse(true, "abc123", OTHER_BUILD),
            ReuseDecision::Reuse
        );
        // If this build's git_sha is unknown (embedding not possible), there is no basis to decide, so ride along.
        assert_eq!(
            classify_reuse(false, "unknown", OTHER_BUILD),
            ReuseDecision::Reuse
        );
    }

    #[test]
    fn healthz_pid_は数値pidのみ取り出す() {
        assert_eq!(healthz_pid(CURRENT_BUILD), Some(4242));
        assert_eq!(healthz_pid(LEGACY_BUILD), None); // no pid field
        assert_eq!(healthz_pid("not json"), None);
    }

    #[test]
    fn healthz_pid_は非正値や型違いを拒否する() {
        // pid <= 0 is not accepted, since it triggers a runaway kill (-1 = all processes, 0 = caller's pgrp).
        assert_eq!(healthz_pid(r#"{"status":"ok","pid":-1}"#), None);
        assert_eq!(healthz_pid(r#"{"status":"ok","pid":0}"#), None);
        // A type mismatch (string pid) yields None from as_i64.
        assert_eq!(healthz_pid(r#"{"status":"ok","pid":"4242"}"#), None);
        // A huge value exceeding i32 is rejected by try_from.
        assert_eq!(healthz_pid(r#"{"status":"ok","pid":9999999999}"#), None);
        // The valid minimum is accepted.
        assert_eq!(healthz_pid(r#"{"status":"ok","pid":1}"#), Some(1));
    }

    #[test]
    fn parse_activity_reads_camelcase_counts() {
        let a = parse_activity(
            r#"{"activeSessions":2,"runningSubagents":1,"backgroundShells":3}"#,
        )
        .unwrap();
        assert_eq!(a.active_sessions, 2);
        assert_eq!(a.running_subagents, 1);
        assert_eq!(a.background_shells, 3);
        assert!(a.is_busy());
    }

    #[test]
    fn parse_activity_all_zero_is_not_busy() {
        let a = parse_activity(
            r#"{"activeSessions":0,"runningSubagents":0,"backgroundShells":0}"#,
        )
        .unwrap();
        assert!(!a.is_busy());
    }

    #[test]
    fn parse_activity_rejects_malformed_or_missing_field() {
        assert_eq!(parse_activity("not json"), None);
        assert_eq!(parse_activity(r#"{"activeSessions":1}"#), None);
    }

    #[test]
    fn activity_summary_lists_only_nonzero_parts_with_plurals() {
        assert_eq!(
            Activity { active_sessions: 2, running_subagents: 1, background_shells: 0 }.summary(),
            "2 sessions, 1 background agent still running"
        );
        assert_eq!(
            Activity { active_sessions: 0, running_subagents: 0, background_shells: 1 }.summary(),
            "1 background shell still running"
        );
    }

    #[test]
    fn parse_lsof_pid_は単一pidのみ受理し複数や空は諦める() {
        assert_eq!(parse_lsof_pid("12345\n"), Some(12345));
        assert_eq!(parse_lsof_pid("  678  "), Some(678));
        assert_eq!(parse_lsof_pid("111\n222\n"), None); // multiple is ambiguous = avoid collateral damage
        assert_eq!(parse_lsof_pid(""), None);
        assert_eq!(parse_lsof_pid("garbage"), None);
    }

    #[test]
    fn parse_lsof_pid_は非正値を除外してから単一判定する() {
        // Non-positive values are a source of runaway kills, so they are excluded. Accepted if a single one remains after exclusion.
        assert_eq!(parse_lsof_pid("-1\n"), None);
        assert_eq!(parse_lsof_pid("0\n"), None);
        // Accepted if what remains after removing 0/negatives is a single pid (a case where lsof occasionally emits a stray line).
        assert_eq!(parse_lsof_pid("0\n12345\n"), Some(12345));
        // If multiple valid pids remain, it is ambiguous = give up.
        assert_eq!(parse_lsof_pid("0\n111\n222\n"), None);
    }

    #[test]
    fn check_health_は実サーバ応答で判定する() {
        let healthy = serve_once(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 15\r\n\r\n{\"status\":\"ok\"}",
        );
        assert!(check_health(healthy));

        let forbidden = serve_once("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n");
        assert!(!check_health(forbidden));

        assert!(!check_health(closed_port()));
    }

    #[test]
    fn check_health_は接続を閉じないピアでも応答完了で即返る() {
        // The read timeout is per-read, so against a peer that never closes, read_to_end was
        // unbounded. Verify it returns without waiting for the deadline via content-length completion detection.
        let port = serve_once_opts(
            "HTTP/1.1 200 OK\r\ncontent-length: 15\r\n\r\n{\"status\":\"ok\"}",
            false,
        );
        let started = Instant::now();
        assert!(check_health(port));
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "完了検知で即返るべき（elapsed={:?}）",
            started.elapsed()
        );
    }

    #[test]
    fn http_get_は応答しないピアでもdeadlineで必ず返る() {
        // A peer that holds the connection with incomplete headers (neither response completion nor EOF arrives).
        let port = serve_once_opts("HTTP/1.1 200 OK\r\n", false);
        let started = Instant::now();
        // The return value's contents don't matter (lenient parsing may yield Ok). Only verify boundedness.
        let _ = http_get(port, "/healthz", &[]);
        assert!(
            started.elapsed() < RESPONSE_DEADLINE + Duration::from_secs(1),
            "deadline 超過（elapsed={:?}）",
            started.elapsed()
        );
    }

    #[test]
    fn wait_port_released_はhealthzが消えていれば即真を返す() {
        // Connection refused = port already released (after a stale server withdrew) -> spawn immediately, before SIGKILL.
        let started = Instant::now();
        assert!(wait_port_released(closed_port(), Duration::from_secs(5)));
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "解放済みなら猶予を待たず即返るべき（elapsed={:?}）",
            started.elapsed()
        );
    }

    #[test]
    fn wait_port_released_は居座るserverには猶予いっぱいで偽を返す() {
        // A server that keeps returning healthz (a stale server ignoring SIGTERM / with a long save) -> false on grace timeout
        // = the path where reclaim_stale_server escalates to SIGKILL.
        let port = serve_healthy_forever();
        let timeout = Duration::from_millis(500);
        let started = Instant::now();
        assert!(!wait_port_released(port, timeout));
        // Return false only after waiting for the deadline (don't kill the save by cutting off too early).
        assert!(
            started.elapsed() >= timeout,
            "猶予を使い切ってから false を返すべき（elapsed={:?}）",
            started.elapsed()
        );
        // An upper bound so it doesn't run away at POLL_INTERVAL granularity (detecting excessive waiting).
        assert!(
            started.elapsed() < timeout + Duration::from_secs(2),
            "猶予を大きく超過しないべき（elapsed={:?}）",
            started.elapsed()
        );
    }

    #[test]
    fn verify_token_は200のみ受理する() {
        // The dedicated token-probe endpoint (a strict contract).
        // Only when the token is accepted does it return 200 + {"ok":true}.
        let port = serve_once_expecting("x-zashiki-token: goodtoken");
        assert!(verify_token(port, "goodtoken"));

        let port = serve_once_expecting("x-zashiki-token: goodtoken");
        assert!(!verify_token(port, "wrongtoken"));
    }

    #[test]
    fn verify_token_はprobeパス404を受理しない() {
        // Migrated to a strict contract. Cases where the dedicated endpoint does not return 200
        // (404 = route not implemented / merge regression) are not accepted.
        let port = serve_once("HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n");
        assert!(!verify_token(port, "sometoken"));
    }

    #[test]
    fn verify_token_は200でもcatch_allのhelloボディは受理しない() {
        // The crux: don't mistake a case where the dedicated branch breaks and falls back to the
        // catch-all's (res.end("hello")) implicit 200 for "token accepted". By checking not just
        // status but also the body {"ok":true}, the regression is detected.
        let port = serve_once("HTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\nhello");
        assert!(!verify_token(port, "sometoken"));
    }

    #[test]
    fn read_token_は前後の空白改行を除去する() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("token");
        std::fs::write(&path, "abc123DEF\n").unwrap();
        assert_eq!(read_token(&path).unwrap(), "abc123DEF");
    }

    #[test]
    fn read_token_は不在_空_不正文字でエラー() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope");
        assert!(read_token(&missing).unwrap_err().contains("読めません"));

        let empty = dir.path().join("empty");
        std::fs::write(&empty, "\n").unwrap();
        assert!(read_token(&empty).unwrap_err().contains("空"));

        let bad = dir.path().join("bad");
        std::fs::write(&bad, "abc/../def\n").unwrap();
        assert!(read_token(&bad).unwrap_err().contains("不正"));
    }

    #[test]
    fn initial_url_はtokenクエリを付与する() {
        assert_eq!(
            initial_url("http://127.0.0.1:8790", "abc123"),
            "http://127.0.0.1:8790/?token=abc123"
        );
        assert_eq!(
            initial_url("http://localhost:5173", "abc123"),
            "http://localhost:5173/?token=abc123"
        );
    }

    #[test]
    fn ensure_server_はバイナリ不在で対処つきエラーを返す() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = Config {
            port: closed_port(),
            token_path: dir.path().join("token"),
            server_bin: dir.path().join("no-such-bin"),
            client_dist: dir.path().join("client-dist"),
            app_version: String::new(),
        };
        let err = ensure_server(&cfg, &StepLog::new()).unwrap_err();
        assert!(err.contains("cargo build"), "err = {err}");
    }

    /// Writes an executable shell script as an instantly-dying binary (no node dependency).
    fn write_exec(path: &Path, script: &str) {
        std::fs::write(path, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    #[test]
    fn ensure_server_は即死する子プロセスのstderr末尾をエラーに含める() {
        let dir = tempfile::tempdir().unwrap();
        let entry = dir.path().join("boom");
        write_exec(&entry, "#!/bin/sh\necho 'BOOM: 依存が壊れています' >&2\nexit 1\n");
        let cfg = Config {
            port: closed_port(),
            token_path: dir.path().join("token"),
            server_bin: entry,
            client_dist: dir.path().join("client-dist"),
            app_version: String::new(),
        };
        let err = ensure_server(&cfg, &StepLog::new()).unwrap_err();
        assert!(err.contains("起動前に終了"), "err = {err}");
        assert!(err.contains("BOOM"), "stderr 末尾を含むべき: err = {err}");
        assert!(err.contains("lsof"), "対処を含むべき: err = {err}");
    }

    #[test]
    fn resolve_server_bin_はbundledで同梱兄弟を最優先する() {
        // Distributed .app: use the zashiki-server next to the executable (Contents/MacOS/Zashiki).
        let dir = tempfile::tempdir().unwrap();
        let exe_dir = dir.path().join("MacOS");
        std::fs::create_dir(&exe_dir).unwrap();
        let sibling = exe_dir.join("zashiki-server");
        std::fs::write(&sibling, "REAL").unwrap();
        // Even if cargo output exists, the sibling (bundled resource) wins.
        let cargo = dir.path().join("target");
        std::fs::create_dir_all(cargo.join("release")).unwrap();
        std::fs::write(cargo.join("release/zashiki-server"), "bin").unwrap();
        assert_eq!(resolve_server_bin(true, Some(&exe_dir), &cargo), sibling);
    }

    #[test]
    fn resolve_server_bin_はbundledで兄弟不在時にrelease出力へ落ちる() {
        let dir = tempfile::tempdir().unwrap();
        let exe_dir = dir.path().join("MacOS");
        std::fs::create_dir(&exe_dir).unwrap(); // no sibling
        let cargo = dir.path().join("target");
        std::fs::create_dir_all(cargo.join("release")).unwrap();
        let release = cargo.join("release/zashiki-server");
        std::fs::write(&release, "bin").unwrap();
        assert_eq!(resolve_server_bin(true, Some(&exe_dir), &cargo), release);
    }

    #[test]
    fn resolve_server_bin_はdevで兄弟スタブを無視しcargo_debugを使う() {
        // Grabbing the #!/bin/sh stub (which exits 0 immediately) that appears in tauri's target/debug
        // as the sibling causes "server exited before startup (exit status: 0)". In dev it does not
        // look at the sibling and uses the cargo debug output (built by beforeDevCommand).
        let dir = tempfile::tempdir().unwrap();
        let exe_dir = dir.path().join("target/debug");
        std::fs::create_dir_all(&exe_dir).unwrap();
        let stub = exe_dir.join("zashiki-server");
        std::fs::write(&stub, "#!/bin/sh\n").unwrap(); // sibling stub
        let cargo = dir.path().join("crates-target");
        std::fs::create_dir_all(cargo.join("debug")).unwrap();
        let real = cargo.join("debug/zashiki-server");
        std::fs::write(&real, "REAL").unwrap();
        let got = resolve_server_bin(false, Some(&exe_dir), &cargo);
        assert_eq!(got, real, "dev は兄弟スタブではなく cargo debug 出力を使うべき");
        assert_ne!(got, stub);
    }

    #[test]
    fn resolve_server_bin_はdevでdebug不在時にrelease出力へ落ちる() {
        let dir = tempfile::tempdir().unwrap();
        let cargo = dir.path().join("target");
        std::fs::create_dir_all(cargo.join("release")).unwrap();
        let release = cargo.join("release/zashiki-server");
        std::fs::write(&release, "bin").unwrap();
        // No debug output -> fall back to release.
        assert_eq!(resolve_server_bin(false, None, &cargo), release);
    }

    #[test]
    fn bundled_client_dist_は実行体ディレクトリからresources配下を指す() {
        // Distributed .app: the executable is Contents/MacOS/Zashiki, the client dist is Contents/Resources/client-dist.
        // Pins the contract corresponding to the bundle.resources placement (client-dist) in tauri.conf.json.
        let exe_dir = Path::new("/Applications/Zashiki.app/Contents/MacOS");
        assert_eq!(
            bundled_client_dist(exe_dir),
            PathBuf::from("/Applications/Zashiki.app/Contents/MacOS/../Resources/client-dist")
        );
    }

    #[test]
    fn spawn_env_は常にport_tokenを含む() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = Config {
            port: 8790,
            token_path: dir.path().join("token"),
            server_bin: dir.path().join("zashiki-server"),
            client_dist: dir.path().join("nope"),
            app_version: "1.2.3".to_string(),
        };
        let env = spawn_env(&cfg);
        assert!(env.iter().any(|(k, v)| *k == "ZK_PORT" && v == "8790"));
        assert!(env.iter().any(|(k, _)| *k == "ZK_TOKEN_FILE"));
        assert!(env.iter().any(|(k, v)| *k == "ZK_APP_VERSION" && v == "1.2.3"));
    }

    #[test]
    fn spawn_env_はclient_dist実在時のみZK_CLIENT_DISTを渡す() {
        let dir = tempfile::tempdir().unwrap();
        // Absent (the dev case where the dist is not generated) -> not passed = preserve current behavior (no static serving).
        let cfg_missing = Config {
            port: 8790,
            token_path: dir.path().join("token"),
            server_bin: dir.path().join("zashiki-server"),
            client_dist: dir.path().join("no-such-dist"),
            app_version: String::new(),
        };
        assert!(!spawn_env(&cfg_missing)
            .iter()
            .any(|(k, _)| *k == "ZK_CLIENT_DIST"));

        // Existing (the distributed .app's bundled-resource case) -> pass that path.
        let dist = dir.path().join("client-dist");
        std::fs::create_dir(&dist).unwrap();
        let cfg_present = Config {
            port: 8790,
            token_path: dir.path().join("token"),
            server_bin: dir.path().join("zashiki-server"),
            client_dist: dist.clone(),
            app_version: String::new(),
        };
        let value = spawn_env(&cfg_present)
            .into_iter()
            .find(|(k, _)| *k == "ZK_CLIENT_DIST")
            .map(|(_, v)| v);
        assert_eq!(value, Some(dist.to_string_lossy().into_owned()));
    }

    #[test]
    fn is_html_document_は先頭がdoctype_htmlのみ真() {
        assert!(is_html_document("<!doctype html>\n<html></html>"));
        assert!(is_html_document("  \n<!DOCTYPE HTML>")); // whitespace + uppercase
        assert!(is_html_document("<html lang=\"ja\">"));
        assert!(!is_html_document("hello")); // the catch-all's implicit 200
        assert!(!is_html_document("{\"ok\":true}"));
        assert!(!is_html_document("")); // the empty body of 401/404
    }

    #[test]
    fn serves_client_ui_は200かつhtmlのみ真() {
        // A server that serves the client dist (returns index.html).
        let served = serve_once(
            "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: 15\r\n\r\n<!doctype html>",
        );
        assert!(serves_client_ui(served));

        // A server occupying the port without a client dist (`/` returns 401 via require_token).
        let unauthorized = serve_once("HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n");
        assert!(!serves_client_ui(unauthorized));

        // Even a 200 that is not HTML (such as the catch-all's hello) is treated as UI not served.
        let hello = serve_once("HTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\nhello");
        assert!(!serves_client_ui(hello));

        assert!(!serves_client_ui(closed_port()));
    }

    #[test]
    fn parse_debug_flag_はdebug_trueのみ真() {
        // The same lenient read as the server's config.json (~/.zashiki/config.json).
        assert!(parse_debug_flag(r#"{"debug":true}"#));
        assert!(!parse_debug_flag(r#"{"debug":false}"#));
        assert!(!parse_debug_flag(r#"{"notifySound":true}"#)); // debug missing -> default false
        assert!(!parse_debug_flag(r#"{"debug":"true"}"#)); // type mismatch (string) -> default false
        assert!(!parse_debug_flag(r#"{"debug":1}"#)); // type mismatch (number) -> default false
        assert!(!parse_debug_flag("not json")); // corrupt -> false
        assert!(!parse_debug_flag("")); // empty -> false
        assert!(!parse_debug_flag("[]")); // non-object -> false
    }

    #[test]
    fn read_debug_flag_は不在で偽_true設定で真() {
        let dir = tempfile::tempdir().unwrap();
        // Absent (config.json not created) -> false (debug is disabled by default).
        assert!(!read_debug_flag(&dir.path().join("no-such-config.json")));

        let path = dir.path().join("config.json");
        std::fs::write(&path, r#"{"notifySound":true,"debug":true}"#).unwrap();
        assert!(read_debug_flag(&path));

        std::fs::write(&path, r#"{"debug":false}"#).unwrap();
        assert!(!read_debug_flag(&path));
    }

    #[test]
    fn devtools_enabled_はdevは常時_releaseはconfig依存() {
        // dev (debug build) enables devtools regardless of config (so as not to degrade the developer experience).
        assert!(devtools_enabled(false, true));
        assert!(devtools_enabled(true, true));
        // The distributed (release) build only when debug in config.json is true.
        assert!(!devtools_enabled(false, false));
        assert!(devtools_enabled(true, false));
    }

    #[test]
    fn ui_served_from_server_はサーバoriginと一致する時のみ真() {
        // Distributed .app: base_url = the server origin.
        assert!(ui_served_from_server("http://127.0.0.1:8790", 8790));
        // dev: opens Vite:5173 (separate from the server) -> not a probe target.
        assert!(!ui_served_from_server("http://localhost:5173", 8790));
        // Port mismatch.
        assert!(!ui_served_from_server("http://127.0.0.1:8799", 8790));
    }

    #[test]
    fn client_ui_unavailable_message_は原因別に対処を出し分ける() {
        let dist = Path::new("/Applications/Zashiki.app/Contents/Resources/client-dist");
        let rode = client_ui_unavailable_message(8790, true, dist);
        assert!(rode.contains("相乗り") || rode.contains("既に稼働中"), "msg = {rode}");
        assert!(rode.contains("tauri dev"), "対処を含むべき: msg = {rode}");
        assert!(rode.contains("lsof"), "占有確認手順を含むべき: msg = {rode}");

        let broken = client_ui_unavailable_message(8790, false, dist);
        assert!(broken.contains("build:app"), "再ビルド手順を含むべき: msg = {broken}");
        assert!(
            broken.contains("client-dist"),
            "期待パスを含むべき: msg = {broken}"
        );
    }
}
