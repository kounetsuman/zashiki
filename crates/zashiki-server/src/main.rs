//! Startup entry point for zashiki-server. Launches the REST endpoints (healthz/token-probe/fs/git/search/sessions/hooks),
//! the control runtime (a resident state poller + state.sync delivery over `/ws/control`), and `/ws/term`.
//! The default is the owned PTY backend. It generates a token at startup and writes it to ZK_TOKEN_FILE,
//! so the Tauri sidecar (`sidecar.rs`) can launch this binary instead of the Node server.

use std::net::SocketAddr;
use std::path::PathBuf;

use zashiki_server::runtime::{spawn_control_runtime, ControlRuntimeConfig};

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
}

/// `zashiki-server print-plist` writes the launchd LaunchAgent plist to stdout and exits
/// (install-daemon.sh calls this to generate the plist; the source of truth for the plist is launchd.rs).
fn maybe_print_plist() -> bool {
    if std::env::args().nth(1).as_deref() != Some("print-plist") {
        return false;
    }
    let program = std::env::var("ZK_SERVER_BIN").unwrap_or_else(|_| {
        std::env::current_exe()
            .ok()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| "zashiki-server".to_string())
    });
    let port = std::env::var("ZK_PORT").unwrap_or_else(|_| "8790".to_string());
    let logs = home().join("Library/Logs");
    let params = zashiki_server::launchd::PlistParams {
        label: "io.github.kounetsuman.zashiki".to_string(),
        program,
        env: vec![("ZK_PORT".to_string(), port)],
        stdout_path: logs.join("zashiki-server.out.log").to_string_lossy().into_owned(),
        stderr_path: logs.join("zashiki-server.err.log").to_string_lossy().into_owned(),
        // Decision: resident (KeepAlive) but not auto-loaded at boot (the app starts it lazily).
        keep_alive: true,
        run_at_load: false,
    };
    print!("{}", zashiki_server::launchd::plist_xml(&params));
    true
}

#[tokio::main]
async fn main() {
    if maybe_print_plist() {
        return;
    }
    let port: u16 = std::env::var("ZK_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8790);
    // Drop-in for Node's index.ts: if ZK_TOKEN is not explicitly set, generate a random token at startup and,
    // for CLI/sidecar integration, write it with mode 0600 to ZK_TOKEN_FILE (default ~/.zashiki/token; the write happens after listen succeeds).
    let token = std::env::var("ZK_TOKEN")
        .ok()
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| {
            zashiki_server::token::generate_token().expect("generate token from /dev/urandom")
        });
    let token_file = std::env::var_os("ZK_TOKEN_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".zashiki/token"));

    // Read the stderr tail before this boot appends its own lines. ZK_SERVER_ERR_LOG overrides the path.
    let err_log = std::env::var_os("ZK_SERVER_ERR_LOG")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join("Library/Logs/zashiki-server.err.log"));
    let prior_log_tail = zashiki_server::crash_report::read_tail(&err_log);
    let client_dist = std::env::var_os("ZK_CLIENT_DIST").map(PathBuf::from);
    // repos.conf comes from ZK_REPOS_CONF, or ~/.zashiki/repos.conf if unset (per index.ts).
    let repos_conf = std::env::var_os("ZK_REPOS_CONF")
        .map(PathBuf::from)
        .or_else(|| Some(home().join(".zashiki/repos.conf")));

    // Read the roots and org colors from repos.conf in one pass.
    let repos = repos_conf
        .as_deref()
        .map(zashiki_server::repos::read_repos_conf)
        .unwrap_or_default();
    let repos_roots: Vec<String> = repos
        .roots
        .into_iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();

    let poll_sec = std::env::var("ZK_POLL")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(2.0);

    // Destination for session save/restore (ZK_SAVES_DIR; default ~/.zashiki/saves). The startup restore,
    // the shutdown save, and the REST handlers all share this same path.
    let saves_dir = std::env::var_os("ZK_SAVES_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(zashiki_server::default_saves_dir);
    // ZK_NO_CLAUDE=1 suppresses claude auto-launch (the resume launch in save/restore also follows this).
    let launch_claude = std::env::var_os("ZK_NO_CLAUDE").is_none();

    // The live-reload config comes from ZK_CONFIG, or ~/.zashiki/config.json if unset (per index.ts). It is read
    // once at startup, and a resident watch task immediately reflects later changes as config.sync.
    let config_path = std::env::var_os("ZK_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".zashiki/config.json"));
    let config = zashiki_server::config::read_config(&config_path);

    // Defaults to ~/.claude/projects. Can be isolated via ZK_PROJECTS_ROOT so e2e / verification / sandbox runs don't read real transcripts.
    let projects_root = std::env::var_os("ZK_PROJECTS_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".claude/projects"));

    // Control runtime (resident poller + state.sync delivery). Owned PTY backend.
    let control = spawn_control_runtime(ControlRuntimeConfig {
        projects_root: projects_root.clone(),
        repos_roots,
        org_colors: repos.color_by_org,
        repos_conf: repos_conf.clone(),
        poll_sec,
        run_marker: std::env::var("ZK_RUN_MARKER").ok(),
        bg_agent_marker: std::env::var("ZK_BG_AGENT_MARKER").ok(),
        limit_marker: std::env::var("ZK_LIMIT_MARKER").ok(),
        // ZK_NO_CLAUDE=1 suppresses claude auto-launch (launches by default).
        launch_claude,
        config,
        config_path: Some(config_path),
        // ZK_NOTIFY switches the notification destination (web if unset). macOS notifications use terminal-notifier.
        notify_mode: zashiki_server::hooks::NotifyMode::from_str_or_default(
            &std::env::var("ZK_NOTIFY").unwrap_or_default(),
        ),
        mac_notify: zashiki_server::mac_notifier::terminal_notifier(),
        // Real bundle version from the Tauri shell (app.package_info().version). Absent for the standalone
        // server / dev, which disables the update check (#26).
        app_version: std::env::var("ZK_APP_VERSION").ok(),
    });

    // Grab the registry of owned sessions to be torn down on graceful shutdown, before handing control to the router.
    let registry = control.sessions.clone();

    // Bind the port BEFORE restore spawns any PTYs. A double launch (port already taken) must fail
    // here, not after we have spawned owned sessions — portable-pty setsid's children away, so a later
    // panic would orphan them. Binding first makes a busy port a clean no-op exit. The token is written only
    // after a successful bind, so a failed double launch never clobbers the running instance's token.
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("bind 127.0.0.1");
    if let Err(e) = zashiki_server::token::write_token_file(&token_file, &token) {
        eprintln!("zashiki-server: token file 書き込み失敗（{}）: {e}", token_file.display());
    }

    // A marker left by the previous run means it never reached shutdown_signal. Checked after bind so a
    // busy-port double launch never touches it.
    let marker = zashiki_server::crash_report::marker_path(&token_file, port);
    let last_crash = if marker.exists() { prior_log_tail } else { None };
    if let Err(e) = std::fs::write(&marker, []) {
        eprintln!("zashiki-server: running marker の書き込みに失敗しました（{}）: {e}", marker.display());
    }

    // Startup auto-restore: rebuild owned sessions from the last.tsv saved at the previous shutdown.
    // The registry is empty right after startup, so the pre-restore backup is None (non-destructive). No-op if no restore file exists.
    // Done before listen so the first state.sync carries the restored sessions.
    {
        let shell = zashiki_server::session_restore::login_shell();
        match zashiki_server::session_persist::restore_sessions_on_startup(
            &registry,
            &saves_dir,
            launch_claude,
            &shell,
        )
        .await
        {
            Ok(0) => {}
            Ok(n) => eprintln!("zashiki-server: 前回のセッションを {n} 件復元しました"),
            Err(e) => eprintln!("zashiki-server: 起動時のセッション復元に失敗しました: {e:?}"),
        }
    }

    // Periodic session-list autosave. Keeps last.tsv fresh so a crash / SIGKILL restores to a recent state instead of
    // the last graceful shutdown (#372). Spawned after the startup restore so its first tick reflects restored sessions.
    // The handle is handed to shutdown_signal, which stops the task before the graceful save so no late tick can land
    // a stale last.tsv after it.
    let autosave = zashiki_server::session_persist::spawn_session_autosave(
        registry.clone(),
        saves_dir.clone(),
        zashiki_server::session_persist::AUTOSAVE_INTERVAL,
    );

    // Session history is retained without eviction so the first prompt stays reachable; this watches the
    // aggregate scrollback memory and raises a NOTIFICATION (rather than silently truncating) when it
    // enters the danger zone, prompting the user to close unneeded sessions.
    zashiki_server::scrollback_monitor::spawn_scrollback_monitor(
        registry.clone(),
        control.hub.clone(),
        zashiki_server::scrollback_monitor::MONITOR_INTERVAL,
    );

    let app = zashiki_server::build_router(zashiki_server::ServerConfig {
        expected_token: Some(token.clone()),
        client_dist,
        repos_conf,
        control: Some(control),
        // Editor for POST /api/git/open (ZK_EDITOR; default `cursor -g`). Spawns a real process.
        editor: std::env::var("ZK_EDITOR").ok(),
        open_file: None,
        file_max_bytes: None,
        // Destination for session save/restore (same as the startup restore and shutdown save).
        saves_dir: Some(saves_dir.clone()),
        last_crash,
    });
    eprintln!("zashiki-server listening on http://{addr}");
    eprintln!("token file: {}", token_file.display());
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(registry, saves_dir, autosave, marker))
        .await
        .expect("serve");
}

/// Fires on either SIGTERM or SIGINT and, **after saving the session list**, terminates all owned
/// sessions before returning. The save->kill order is critical: if kill ran first, the sids would
/// vanish from the registry, last.tsv would be empty, and restart could not restore
/// ([`zashiki_server::session_persist::save_then_shutdown`]).
/// The desktop shell does a killpg on the server's process group, but that does not reach the claude
/// process that portable-pty setsid'd away. Tearing the registry down here keeps claude from being orphaned.
async fn shutdown_signal(
    registry: std::sync::Arc<zashiki_server::session_registry::SessionRegistry>,
    saves_dir: PathBuf,
    autosave: tokio::task::JoinHandle<()>,
    marker: PathBuf,
) {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = signal(SignalKind::terminate()).expect("install SIGTERM handler");
        tokio::select! {
            _ = term.recv() => {}
            _ = tokio::signal::ctrl_c() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
    // Stop the periodic autosave and wait for it to fully terminate before the graceful save, so no late tick can
    // land a stale last.tsv after it (#372). abort cancels at the task's next await; awaiting the handle guarantees
    // any in-flight write has already completed, making save_then_shutdown the deterministic final writer.
    autosave.abort();
    let _ = autosave.await;
    // Cap the whole teardown so it can't hold serve hostage if it drags on (avoids the forced exit
    // becoming ineffective under many sessions x grace, or a stalled reap; anything over budget exits
    // best-effort). save is lightweight (just a TSV write) and is assumed to fit the budget. Teardown
    // runs after save (persist the sids first).
    if tokio::time::timeout(
        SHUTDOWN_BUDGET,
        zashiki_server::session_persist::save_then_shutdown(&registry, &saves_dir),
    )
    .await
    .is_err()
    {
        eprintln!(
            "zashiki-server: graceful shutdown が {SHUTDOWN_BUDGET:?} を超過。ベストエフォートで終了します"
        );
    }
    // Reaching here means the shutdown routine ran; drop the marker so the next launch counts this clean.
    let _ = std::fs::remove_file(&marker);
}

/// Upper bound allowed for the full teardown on graceful shutdown. Each session goes TERM->300ms->KILL, so it usually takes a few hundred ms.
const SHUTDOWN_BUDGET: std::time::Duration = std::time::Duration::from_secs(10);
