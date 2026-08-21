//! sidecar server management (the shell starts and monitors the server, and on
//! exit performs a graceful shutdown only if it started the server itself. The
//! tmux session is left running).
//!
//! The decision logic is split into small, cargo-test-able functions.
//! Every stage is emitted to stderr as a progress log (for diagnosability on crash).

use std::collections::VecDeque;
use std::io::{BufRead as _, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[path = "sidecar_config.rs"]
mod sidecar_config;
#[path = "sidecar_http.rs"]
mod sidecar_http;
#[path = "sidecar_version.rs"]
mod sidecar_version;

pub use sidecar_config::Config;

use sidecar_http::{check_health, http_get, is_healthy_response, serves_client_ui};
use sidecar_version::{classify_reuse, healthz_pid, ReuseDecision, EXPECTED_GIT_SHA};

pub const DEFAULT_PORT: u16 = 8790;
const SPAWN_HEALTH_TIMEOUT: Duration = Duration::from_secs(15);
const TOKEN_VERIFY_TIMEOUT: Duration = Duration::from_secs(3);
const POLL_INTERVAL: Duration = Duration::from_millis(200);
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);
/// Number of trailing stderr lines to retain for diagnostics when the server dies.
const STDERR_TAIL_LINES: usize = 20;


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

/// Grace period to wait after sending SIGTERM to a stale server until the port is released (healthz
/// disappears). On SIGTERM the server does a "save session -> withdraw" (graceful). Since healthz
/// keeps responding during the save, this is set longer than the server-side total withdrawal limit
/// (main.rs `SHUTDOWN_BUDGET` = 10s) so as **not to interrupt the save**. Exceeding it means "it hung
/// beyond its own budget" = last-resort SIGKILL.
const STALE_RELEASE_TIMEOUT: Duration = Duration::from_secs(12);

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
    use std::io::{Read as _, Write as _};
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
