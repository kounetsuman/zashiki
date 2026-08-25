//! Assembly of the control runtime. It bundles the components (ControlHub / PtyPollerPorts /
//! spawn_poller), starts the resident poller, and returns the `ControlServices` passed to
//! `build_router`. Must be called within a `tokio` runtime.
//!
//! org colors (annotated in repos.conf) stay at their defaults for now (to be wired up later). For
//! config.json (notifySound/debug), ControlHub starts with the initial value `config`, and if
//! `config_path` is present a resident watch task applies changes immediately.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use crate::claude_projects::ClaudeProjectsAdapter;
use crate::config::{spawn_config_watch, CONFIG_POLL};
use crate::control::{ConfigView, ControlHub, ControlServices};
use crate::poller_driver::spawn_poller;
use crate::poller_ports_pty::PtyPollerPorts;
use crate::session_registry::SessionRegistry;
use crate::status_poller::{PollConfig, StateSnapshot};

/// Configuration for the control runtime (the caller, main.rs / Tauri, fills it from env and settings).
pub struct ControlRuntimeConfig {
    pub projects_root: PathBuf,
    /// Initial absolute org root paths from repos.conf (the live set is held in the shared handle).
    pub repos_roots: Vec<String>,
    /// org (basename) → display color (annotated in repos.conf; the orgColors of state.sync).
    pub org_colors: BTreeMap<String, String>,
    /// org (basename) → display alias (annotated in repos.conf; the orgAliases of state.sync).
    pub org_aliases: BTreeMap<String, String>,
    /// Path to repos.conf. If Some, a resident watch task applies external edits live (None disables it).
    pub repos_conf: Option<PathBuf>,
    pub poll_sec: f64,
    pub run_marker: Option<String>,
    pub bg_agent_marker: Option<String>,
    /// Text marker for the usage-limit banner (ZK_LIMIT_MARKER).
    pub limit_marker: Option<String>,
    /// Whether session.new launches claude (defaults to true).
    pub launch_claude: bool,
    /// Initial value of the live-reload settings (the result of reading config.json at startup).
    pub config: ConfigView,
    /// Path to config.json. If Some, a resident watch task is started to apply changes immediately (None disables it).
    pub config_path: Option<PathBuf>,
    /// Destination for hook notifications (ZK_NOTIFY; defaults to web).
    pub notify_mode: crate::hooks::NotifyMode,
    /// The macOS notification executor (defaults to terminal-notifier; swapped out in tests).
    pub mac_notify: crate::hooks::MacNotify,
    /// Running app version injected by the Tauri shell (ZK_APP_VERSION). None in dev / standalone server,
    /// which disables the update check (the placeholder 0.0.0 also no-ops). Feeds the update-check task (#26).
    pub app_version: Option<String>,
}

fn empty_snapshot() -> StateSnapshot {
    StateSnapshot {
        sessions: Vec::new(),
        orgs: Vec::new(),
        org_colors: BTreeMap::new(),
        org_aliases: BTreeMap::new(),
    }
}

/// Creates a ControlHub, starts a real-I/O poller as a resident task, and returns `ControlServices`.
/// Passing this to `ServerConfig.control` makes `/ws/control` distribute state.sync and enables
/// immediate re-evaluation via state.refresh.
pub fn spawn_control_runtime(config: ControlRuntimeConfig) -> ControlServices {
    let hub = ControlHub::new(config.config, Vec::new(), empty_snapshot());
    let claude_settings = crate::claude_settings_io::ClaudeSettingsPaths::resolve();
    let (hooks_status, settings_unreadable) =
        crate::claude_settings_io::current_status_with_readability(&claude_settings);
    hub.publish_hooks_status(hooks_status);
    if settings_unreadable {
        hub.record_boundary_failure(
            crate::notifications::BoundaryFailure::SettingsUnreadable,
            crate::now_ms(),
        );
    }
    // Boot-time counterpart to the session.new claude check, so a missing claude surfaces before the first launch.
    if config.launch_claude && crate::session_launch::resolve_program_path("claude").is_none() {
        hub.record_boundary_failure(
            crate::notifications::BoundaryFailure::ClaudeMissing,
            crate::now_ms(),
        );
    }
    // Probe the signed-in account off the boot path so the first connect carries a real account.status.
    {
        let hub = hub.clone();
        tokio::spawn(async move {
            let claude = crate::session_launch::resolve_claude_program();
            hub.publish_account_status(crate::account_status::read_account_status(&claude).await);
        });
    }
    let config_path = config.config_path;
    if let Some(path) = config_path.clone() {
        spawn_config_watch(path, hub.clone(), CONFIG_POLL);
    }
    crate::orphan_detector::spawn_orphan_zombie_detector(hub.clone());
    // Parse once: None (dev / placeholder / unparseable) disables both the background poll and the
    // manual "Check for updates" path, which is why they share the same parsed value.
    let app_version = config
        .app_version
        .as_deref()
        .and_then(crate::update_checker::parse_running_version);
    if let Some(version) = app_version.clone() {
        crate::update_checker::spawn_update_checker(hub.clone(), version);
    }

    // The poller (read) and session.new share the same registry (the condition for registrations to be visible to the poller).
    let sessions = Arc::new(SessionRegistry::new());
    // The hook route (write) and the poller (read) share the same store: the seam for event-authoritative state.
    let hook_events = Arc::new(crate::hook_event_store::HookEventStore::new());
    // The live repos set shared by the poller, session.new validation, and the repos watcher.
    let repos =
        crate::repos::shared_repos(config.repos_roots, config.org_colors, config.org_aliases);
    let poll_config = PollConfig {
        repos_roots: Vec::new(),
        org_colors: BTreeMap::new(),
        org_aliases: BTreeMap::new(),
        poll_sec: config.poll_sec,
        run_marker: config.run_marker,
        bg_agent_marker: config.bg_agent_marker,
        limit_marker: config.limit_marker,
    };
    // refresh path: control handler → poller. The buffer can be small (each request is processed immediately).
    let (refresh_tx, refresh_rx) = tokio::sync::mpsc::channel(16);
    let ports = PtyPollerPorts::new(
        sessions.clone(),
        ClaudeProjectsAdapter::new(config.projects_root),
        hook_events.clone(),
    );
    spawn_poller(ports, poll_config, repos.clone(), hub.clone(), refresh_rx);
    if let Some(path) = config.repos_conf {
        // Seed the hub with the per-org notes on disk (so they ride the connect handshake) and watch
        // the notes dir for external edits, both keyed off the same repos.conf location.
        let notes_dir = crate::notes::notes_dir_for_conf(&path);
        hub.publish_notes(crate::notes::read_notes(&notes_dir));
        crate::notes_watch::spawn_notes_watch(
            notes_dir,
            hub.clone(),
            crate::notes_watch::NOTES_POLL,
        );
        crate::repos_watch::spawn_repos_watch(
            path,
            repos.clone(),
            refresh_tx.clone(),
            crate::repos_watch::REPOS_POLL,
        );
    }
    ControlServices {
        hub,
        refresh: refresh_tx,
        repos,
        launch_claude: config.launch_claude,
        terms: Arc::new(std::sync::Mutex::new(
            crate::term_registry::TermRegistry::new(),
        )),
        sessions,
        hook_events,
        heartbeat: crate::control::HEARTBEAT_INTERVAL,
        notify_mode: config.notify_mode,
        mac_notify: config.mac_notify,
        config_path,
        claude_settings: Some(claude_settings),
        app_version,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::ServerMessage;
    use std::time::Duration;

    #[tokio::test]
    async fn runtime_drives_poller_and_publishes_state_sync() {
        let tmp = tempfile::tempdir().unwrap();
        // Empty registry → sessions is empty, but orgs come from repos_roots.
        let services = spawn_control_runtime(ControlRuntimeConfig {
            projects_root: tmp.path().to_path_buf(),
            repos_roots: vec!["/repos/charlie".to_string()],
            org_colors: BTreeMap::new(),
            org_aliases: BTreeMap::new(),
            repos_conf: None,
            poll_sec: 0.1,
            run_marker: None,
            bg_agent_marker: None,
            limit_marker: None,
            launch_claude: false,
            config: ConfigView::default(),
            config_path: None,
            notify_mode: crate::hooks::NotifyMode::Web,
            mac_notify: std::sync::Arc::new(|_| {}),
            app_version: None,
        });
        let mut rx = services.hub.subscribe();
        let msg = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("poller should publish within timeout")
            .expect("broadcast open");
        match msg {
            ServerMessage::StateSync { cockpit_terminals: sessions, orgs, .. } => {
                assert!(sessions.is_empty());
                assert_eq!(orgs, vec!["charlie".to_string()]);
            }
            other => panic!("expected state.sync, got {other:?}"),
        }
    }

    /// The poller sees the same registry as session.new. Having an owned PTY registered in the registry
    /// appear in state.sync guards that the owned poller (PtyPollerPorts) actually references the registry.
    #[cfg(unix)]
    #[tokio::test]
    async fn owned_backend_poller_publishes_registered_session() {
        use crate::pty_host::PtyConfig;
        use crate::session_registry::SessionMeta;
        use portable_pty::CommandBuilder;

        let tmp = tempfile::tempdir().unwrap();
        let services = spawn_control_runtime(ControlRuntimeConfig {
            projects_root: tmp.path().to_path_buf(),
            repos_roots: vec!["/repos/charlie".to_string()],
            org_colors: BTreeMap::new(),
            org_aliases: BTreeMap::new(),
            repos_conf: None,
            poll_sec: 0.1,
            run_marker: None,
            bg_agent_marker: None,
            limit_marker: None,
            launch_claude: false,
            config: ConfigView::default(),
            config_path: None,
            notify_mode: crate::hooks::NotifyMode::Web,
            mac_notify: std::sync::Arc::new(|_| {}),
            app_version: None,
        });
        // Register an owned PTY into the registry the poller references (set cwd to the org root so the org resolves).
        let mut cmd = CommandBuilder::new("sh");
        cmd.arg("-l");
        cmd.env("TERM", "xterm-256color");
        services
            .sessions
            .create_with_meta(
                "sess-owned".to_string(),
                PtyConfig::new(cmd),
                SessionMeta {
                    cwd: "/repos/charlie".to_string(),
                    wname: "charlie".to_string(),
                },
            )
            .await
            .unwrap();

        let mut rx = services.hub.subscribe();
        let seen = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match rx.recv().await {
                    Ok(ServerMessage::StateSync { cockpit_terminals: sessions, .. }) => {
                        if sessions.iter().any(|s| s.name == "charlie") {
                            return true;
                        }
                    }
                    Ok(_) => continue,
                    Err(_) => return false,
                }
            }
        })
        .await
        .unwrap_or(false);
        assert!(seen, "owned poller should publish the registered session");
    }
}
