use axum::extract::ws::WebSocket;
use zashiki_core::save_file::{is_uuid_sid, SaveEntry};

use crate::control::{fail_session_create, report_error, trigger_refresh, ControlServices};
use crate::session_registry::{ReplaceOutcome, SessionMeta};

/// Validates the org and creates a new session. Spawns an owned PTY and registers it. A `resume_sid` forks
/// that Claude session into the new terminal (duplicate); it is ignored unless it is a valid UUID.
pub(crate) async fn handle_session_new(
    socket: &mut WebSocket,
    services: &ControlServices,
    org: &str,
    resume_sid: Option<&str>,
) -> bool {
    // Resolve to an owned String before any await: the read guard must not be held across await points.
    let root = {
        let guard = services.repos.read().unwrap();
        let roots: Vec<&str> = guard.roots.iter().map(String::as_str).collect();
        zashiki_core::repos::org_root(org, &roots).map(str::to_string)
    };
    let Some(root) = root else {
        let message = format!("org {org} is not in repos.conf");
        return report_error(socket, &services.hub, "unknown_org", &message).await;
    };
    let name = basename(&root);
    let resume_sid = resume_sid.filter(|s| zashiki_core::save_file::is_uuid_sid(s));
    new_owned_session(socket, services, &root, &name, resume_sid).await
}

/// Spawns an owned PTY and registers it in `SessionRegistry` (owned mode). Since the PTY's command
/// itself is set to launch claude, no key injection is needed (the
/// canonical spec is `session_launch`'s tests).
async fn new_owned_session(
    socket: &mut WebSocket,
    services: &ControlServices,
    root: &str,
    name: &str,
    resume_sid: Option<&str>,
) -> bool {
    let sid = uuid::Uuid::new_v4().to_string();
    let shell = crate::session_restore::login_shell();
    // A missing cwd falls back to $HOME, and claude is resolved to an absolute path before launch to guard against a thin PATH.
    let cwd = crate::session_launch::resolve_cwd(root);
    let claude = crate::session_launch::resolve_program_path("claude");
    if services.launch_claude && claude.is_none() {
        services.hub.record_boundary_failure(
            crate::notifications::BoundaryFailure::ClaudeMissing,
            crate::now_ms(),
        );
    }
    let claude = claude.unwrap_or_else(|| "claude".to_string());
    let settings =
        crate::session_launch::account_usage_settings(services.hub.account_usage_enabled());
    let plan = crate::session_launch::plan_new_session(
        &sid,
        &cwd,
        name,
        services.launch_claude,
        resume_sid,
        &shell,
        &claude,
        settings.as_deref(),
    );
    match services
        .sessions
        .create_with_meta(
            plan.sid.clone(),
            crate::session_launch::plan_to_config(&plan),
            crate::session_launch::plan_to_meta(&plan),
        )
        .await
    {
        Ok(_) => {
            trigger_refresh(services).await;
            true
        }
        Err(err) => fail_session_create(socket, services, &err).await,
    }
}

/// Restarts one registered Cockpit Terminal in response to the user asking for it. The terminal keeps
/// its id, so `claude --resume <sid>` picks the conversation back up.
pub(crate) async fn handle_session_restart(
    socket: &mut WebSocket,
    services: &ControlServices,
    cockpit_terminal_id: &str,
) -> bool {
    let Some(meta) = services.sessions.meta(cockpit_terminal_id).await else {
        // Closed from another window, or dropped by the account-switch pass. An answer to this one
        // request, like the other refusals below.
        let message = format!("cockpit terminal {cockpit_terminal_id} is no longer open");
        return crate::control_dispatch::reply_refusal(socket, "restart_gone", &message).await;
    };
    // The rule the client gates the menu item on, enforced here too so anything speaking the protocol
    // directly gets the same answer, and read against the terminal's own age: the published state is
    // the same one the client saw, and a terminal that has not outlived the startup grace has not
    // earned its `no_claude`. What keeps a restart off a `no_claude` terminal whose shell is mid-command is the
    // two-click confirm in the menu, not this.
    let Some(session) = services.sessions.get(cockpit_terminal_id).await else {
        // Closed between the two lookups. Saying anything about its state would describe a terminal
        // that is no longer there.
        let message = format!("cockpit terminal {cockpit_terminal_id} is no longer open");
        return crate::control_dispatch::reply_refusal(socket, "restart_gone", &message).await;
    };
    let has_no_process = session.has_exited();
    let reported = services.hub.reported_state(cockpit_terminal_id);
    let starting_up = session.uptime() < crate::control_hub::CLAUDE_SETTLE_GRACE;
    if !restartable(has_no_process, reported.as_deref(), starting_up) {
        let (code, message) = match reported.as_deref() {
            // The published state still says it is down, but its process is up — it came back without
            // this request. Citing `exited` would name the one state a restart is offered for.
            Some("exited") => (
                "restart_already_running",
                format!("cockpit terminal {cockpit_terminal_id} is running again"),
            ),
            // Up too briefly for the missing claude to mean anything yet: a login shell's profile can
            // take longer to reach the `claude` exec than the poller's startup grace allows.
            Some("no_claude") => (
                "restart_starting_up",
                format!("cockpit terminal {cockpit_terminal_id} is still starting up"),
            ),
            // The relaunch this request would duplicate is still coming up: the hub answers `starting`
            // for a terminal it has marked, and saying claude is running there would be backwards.
            Some("starting") => (
                "restart_in_progress",
                format!("cockpit terminal {cockpit_terminal_id} is still being relaunched"),
            ),
            // Its screen could not be read this round, so what is running in it is as unknown as it is
            // for a terminal no poll has reached yet - and claiming claude is running would be a guess.
            Some("unknown") | None => (
                "restart_unreported",
                format!("cockpit terminal {cockpit_terminal_id} has not been reported on yet"),
            ),
            Some(state) => (
                "restart_busy",
                format!(
                    "cockpit terminal {cockpit_terminal_id} is {state}; a restart is only offered where claude is not running"
                ),
            ),
        };
        return crate::control_dispatch::reply_refusal(socket, code, &message).await;
    }
    let shell = crate::session_restore::login_shell();
    let claude = crate::session_launch::resolve_claude_program();
    let settings =
        crate::session_launch::account_usage_settings(services.hub.account_usage_enabled());
    let outcome = restart_in_place(
        services,
        cockpit_terminal_id,
        &meta,
        &shell,
        &claude,
        settings.as_deref(),
    )
    .await;
    match outcome {
        RestartOutcome::Restarted => {
            trigger_refresh(services).await;
            true
        }
        RestartOutcome::Skipped => {
            let message = format!(
                "cockpit terminal {cockpit_terminal_id} does not carry a Claude session id to resume from"
            );
            crate::control_dispatch::reply_refusal(socket, "restart_not_resumable", &message).await
        }
        RestartOutcome::CwdMissing => {
            let message = format!(
                "cockpit terminal {cockpit_terminal_id} cannot be restarted: its working directory no longer exists"
            );
            crate::control_dispatch::reply_refusal(socket, "restart_cwd_missing", &message).await
        }
        // Launching claude is switched off (a development / e2e mode), so every terminal is a bare
        // shell and the client offers a restart that cannot mean anything. Answering the requester says
        // why, without leaving a notification behind for a configuration that is never production.
        RestartOutcome::ClaudeDisabled => {
            let message =
                "this server does not launch claude, so terminals cannot be restarted".to_string();
            crate::control_dispatch::reply_refusal(socket, "restart_claude_disabled", &message).await
        }
        // Another restart is already doing this work, and its result goes to whoever started it — so
        // this requester gets told directly, rather than watching a confirmed click do nothing. It is
        // about this request alone, so it leaves no notification behind.
        RestartOutcome::Busy => {
            let message =
                format!("cockpit terminal {cockpit_terminal_id} is already being restarted");
            crate::control_dispatch::reply_refusal(socket, "restart_in_progress", &message).await
        }
        // The row is gone, so the list the client is holding is out of date either way.
        RestartOutcome::Gone => {
            trigger_refresh(services).await;
            true
        }
        // The terminal is stopped rather than unchanged, so the list has to catch up either way.
        RestartOutcome::NotStarted => {
            // Keyed by terminal, the way the account-switch pass records the same failure: retrying a
            // spawn that keeps failing updates the one row instead of stacking another per click.
            services.hub.record_terminal_error(
                relaunch_failed_notification_id(cockpit_terminal_id),
                "restart_failed",
                &relaunch_failed_body(&meta.wname),
                cockpit_terminal_id,
                crate::now_ms(),
            );
            let message = format!(
                "cockpit terminal {cockpit_terminal_id} could not be relaunched and is now stopped"
            );
            let ok =
                crate::control_dispatch::reply_refusal(socket, "restart_failed", &message).await;
            trigger_refresh(services).await;
            ok
        }
    }
}

/// The notification a terminal left stopped by a failed relaunch carries. Shared with the
/// account-switch pass, which reports the same failure with its own code.
pub(crate) fn relaunch_failed_body(wname: &str) -> String {
    format!("{wname} を再起動できず、停止したままです。もう一度再起動すると会話を再開できます。")
}

/// Its id, which is also how a later success retracts it.
pub(crate) fn relaunch_failed_notification_id(cockpit_terminal_id: &str) -> String {
    format!("restart-failed:{cockpit_terminal_id}")
}

/// What a restart attempt did, which the caller needs because the failures differ: one leaves the
/// terminal untouched, the other has already torn it down.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RestartOutcome {
    /// Relaunched under the same id.
    Restarted,
    /// The id is not a Claude session id (a restored terminal with no sid carries a synthetic one),
    /// so there is nothing to resume from.
    Skipped,
    /// This server does not launch claude at all, so every terminal is a plain shell.
    ClaudeDisabled,
    /// The directory the conversation belongs to is gone, so there is nowhere to resume it from.
    CwdMissing,
    /// Another restart of this terminal is already running.
    Busy,
    /// The terminal was closed while the restart was being prepared. Recreating it would resurrect a
    /// session the user just dismissed.
    Gone,
    /// The replacement could not be started, so the terminal is left exactly as it was.
    NotStarted,
}

/// Whether a terminal may be restarted: only one with no claude running in it. `has_no_process` comes
/// from the session itself and covers a terminal that has ended — enough on its own, whatever the
/// snapshot says. `reported` is the published state, and the only way to see a terminal that fell
/// through to a bare shell; a terminal with a live process that no snapshot has reported on is refused,
/// since the client has no state to offer a restart from either and it may well be mid-turn.
/// `starting_up` holds while the terminal is too young for a missing claude to be meaningful, and keeps
/// a restart from killing a launch that is still on its way.
fn restartable(has_no_process: bool, reported: Option<&str>, starting_up: bool) -> bool {
    has_no_process || (reported == Some("no_claude") && !starting_up)
}

/// Swaps in a fresh PTY for a registered Cockpit Terminal, launched with `claude --resume <sid>` so
/// the conversation continues under the same id, and points attached terms at it. The caller reports
/// the refresh.
pub(crate) async fn restart_in_place(
    services: &ControlServices,
    id: &str,
    meta: &SessionMeta,
    shell: &str,
    claude: &str,
    settings: Option<&str>,
) -> RestartOutcome {
    if !services.launch_claude {
        return RestartOutcome::ClaudeDisabled;
    }
    if !is_uuid_sid(id) {
        return RestartOutcome::Skipped;
    }
    // No `resolve_cwd` here, unlike a new session or a restore: those have no conversation to lose, so
    // falling back to $HOME is a reasonable last resort for them. A resume does — and claude scopes
    // session ids per project directory, so resuming from $HOME would not find it and would quietly
    // start a new, empty conversation there instead. Refusing keeps the id pointing at the real one.
    if !std::path::Path::new(&meta.cwd).is_dir() {
        return RestartOutcome::CwdMissing;
    }
    let cwd = meta.cwd.clone();
    let entry = SaveEntry {
        widx: String::new(),
        wname: meta.wname.clone(),
        cwd: cwd.clone(),
        sid: id.to_string(),
    };
    // `plan_resume` declines only a non-UUID sid, which the check above already refused.
    let plan = crate::session_restore::plan_resume(&entry, shell, claude, settings)
        .expect("a uuid sid always plans a resume");
    // Marked before the swap, not after: `replace` releases its per-id claim as it returns, and marking
    // afterwards would leave a moment where the id is neither claimed nor marked — long enough for a
    // second confirmed click to tear down the claude this one is starting. A mark set for a relaunch
    // that then fails costs nothing; the next poll overwrites it with what it observes.
    services.hub.mark_restarted(id);
    let outcome = services
        .sessions
        .replace(
            id,
            crate::session_restore::plan_to_config(&plan),
            // The same directory as before, which the check above confirmed still exists: the poller
            // keys the transcript reads — title, usage, background tasks — off this path.
            SessionMeta {
                cwd,
                wname: meta.wname.clone(),
            },
        )
        .await;
    match &outcome {
        Ok(ReplaceOutcome::Gone) => return RestartOutcome::Gone,
        Ok(ReplaceOutcome::Busy) => return RestartOutcome::Busy,
        // Restamped now that the swap has happened: the mark above may belong to an earlier relaunch
        // of this terminal, and this process is the one that has to reach claude.
        Ok(ReplaceOutcome::Replaced) => services.hub.restamp_restarted(id),
        // A bad login shell, fd exhaustion and ptmx exhaustion all reach the user as the same
        // sentence, so the distinguishing detail has to land somewhere.
        Err(e) => tracing::warn!("zashiki-server: {id} の再起動に失敗しました: {e}"),
    }
    if outcome.is_err() {
        // The old PTY is down and nothing replaced it. The registration stays — its id is the only
        // handle on the conversation — and attached terms hold their last screen rather than looping
        // on reconnects, so the user can read the error and try again from the row.
        return RestartOutcome::NotStarted;
    }
    // Read after the swap, not before: a term that binds during the teardown — the user clicking the
    // row to watch it come back — would otherwise be missing from the list and sit on the dying PTY
    // until a heartbeat noticed. Terms stay registered across a teardown, so nobody is lost this way.
    //
    // Terms hold the PTY they attached to, and the session id they are bound to has not changed, so
    // nothing wakes them: without this they would wait out the client's reconnect backoff instead of
    // re-attaching to the new PTY straight away.
    let term_ids = services.terms.lock().unwrap().term_ids_for_session(id);
    if !term_ids.is_empty() {
        // Woken directly as well as told to reconnect: the notice only reaches clients whose control
        // socket is up at that moment, and a bridge that misses it stays on the dead PTY — silently
        // dropping what is typed into it — until a heartbeat comes round. A client that does get the
        // notice reopens the term and discards this rebind, which is the redundancy being paid for.
        {
            let terms = services.terms.lock().unwrap();
            for term_id in &term_ids {
                if let Some(notify) = terms.bind_notify(term_id) {
                    notify.notify_one();
                }
            }
        }
        services
            .hub
            .broadcast(crate::protocol::ServerMessage::TermReconnect { term_ids });
    }
    // An earlier failure on this terminal is no longer true, whichever pass recorded it. Left standing
    // it would tell the user a terminal they are looking at is stopped.
    for stale in std::iter::once(relaunch_failed_notification_id(id))
        .chain(crate::control_account::switch_notification_ids(id))
    {
        services.hub.dismiss_notification(&stale);
    }
    RestartOutcome::Restarted
}

/// The last segment of a path (org name / window name).
fn basename(path: &str) -> String {
    path.split('/')
        .rfind(|s| !s.is_empty())
        .unwrap_or(path)
        .to_string()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use portable_pty::CommandBuilder;

    use super::*;
    use crate::control::{ConfigView, ControlHub, ControlServices};
    use crate::poller_types::StateSnapshot;
    use crate::pty_host::PtyConfig;
    use crate::session_registry::SessionRegistry;
    use crate::term_registry::TermRegistry;

    const SID: &str = "579fa8cf-4901-45cb-b9ec-17e229231a37";

    fn sleep_cfg() -> PtyConfig {
        let mut cmd = CommandBuilder::new("sleep");
        cmd.arg("30");
        PtyConfig::new(cmd)
    }

    fn empty_snapshot() -> StateSnapshot {
        StateSnapshot {
            sessions: vec![],
            orgs: vec![],
            org_colors: std::collections::BTreeMap::new(),
            org_aliases: std::collections::BTreeMap::new(),
        }
    }

    fn meta() -> SessionMeta {
        SessionMeta {
            cwd: "/tmp".to_string(),
            wname: "work".to_string(),
        }
    }

    /// Services wired only far enough for the restart path (it reads sessions and the account-usage flag).
    fn services(sessions: Arc<SessionRegistry>) -> ControlServices {
        let (refresh, rx) = tokio::sync::mpsc::channel(8);
        drop(rx);
        ControlServices {
            hub: ControlHub::new(ConfigView::default(), vec![], empty_snapshot()),
            refresh,
            repos: crate::repos::shared_repos(vec![], Default::default(), Default::default()),
            launch_claude: true,
            terms: Arc::new(std::sync::Mutex::new(TermRegistry::new())),
            sessions,
            hook_events: Arc::new(crate::hook_event_store::HookEventStore::new()),
            session_models: Arc::new(crate::session_model_store::SessionModelStore::new()),
            heartbeat: crate::control::HEARTBEAT_INTERVAL,
            notify_mode: crate::hooks::NotifyMode::Web,
            notify_history: true,
            mac_notify: Arc::new(|_| {}),
            config_path: None,
            claude_settings: None,
            app_version: None,
        }
    }

    /// A restart replaces the process while the registration keeps its id, which is what lets the
    /// conversation resume instead of a new one starting.
    #[cfg(unix)]
    #[tokio::test]
    async fn restart_in_place_respawns_under_the_same_id() {
        let sessions = Arc::new(SessionRegistry::new());
        sessions
            .create_with_meta(SID.to_string(), sleep_cfg(), meta())
            .await
            .unwrap();
        let before = sessions.get(SID).await.unwrap().pid();
        let services = services(sessions.clone());

        assert_eq!(
            restart_in_place(&services, SID, &meta(), "/bin/sh", "/bin/echo", None).await,
            RestartOutcome::Restarted
        );

        let after = sessions.get(SID).await.unwrap().pid();
        assert_ne!(before, after, "restart should replace the process");
        assert_eq!(sessions.len().await, 1);
    }

    /// The gate matches what the client offers, and leans on the process rather than the snapshot: a
    /// terminal whose replacement has just started still reads `exited` for a poll, and a second
    /// confirmed click must not take that new claude down.
    #[test]
    fn a_restart_needs_a_terminal_with_no_claude_in_it() {
        // Ended: the session itself says so, whatever the last snapshot said.
        assert!(restartable(true, Some("exited"), false));
        assert!(restartable(true, None, false));
        // Fell through to a bare shell: only the reported state shows this.
        assert!(restartable(false, Some("no_claude"), false));
        // The same terminal moments after launch, where claude may still be on its way: a login shell's
        // profile can outlast the poller's startup grace, and restarting would kill the launch.
        assert!(!restartable(false, Some("no_claude"), true));
        // An ended terminal is restartable however young it is - nothing is coming up in it.
        assert!(restartable(true, Some("exited"), true));
        // Just restarted — the snapshot has not caught up, but the process is live.
        assert!(!restartable(false, Some("exited"), false));
        // Never polled, and running.
        assert!(!restartable(false, None, false));
        for busy in ["running", "running_bg_agent", "waiting_input", "idle", "watching"] {
            assert!(!restartable(false, Some(busy), false), "{busy} is not restartable");
        }
    }

    /// The ids in the most recent notification sync seen on `rx`, or `None` if none arrived — which is
    /// not the same as an empty list, and is what tells a missing retraction from a completed one.
    async fn synced_notification_ids(
        rx: &mut tokio::sync::broadcast::Receiver<crate::protocol::ServerMessage>,
    ) -> Option<Vec<String>> {
        let mut ids = None;
        while let Ok(msg) = rx.try_recv() {
            if let crate::protocol::ServerMessage::NotificationsSync { items } = msg {
                ids = Some(items.into_iter().map(|n| n.id).collect());
            }
        }
        ids
    }

    /// A relaunch that works takes back the notifications an earlier failure left — from either pass,
    /// since both say the same thing: the row they call stopped is the one the user is looking at,
    /// running.
    #[tokio::test]
    async fn a_successful_restart_retracts_the_failure_it_had_left() {
        let sessions = Arc::new(SessionRegistry::new());
        sessions
            .create_with_meta(SID.to_string(), sleep_cfg(), meta())
            .await
            .unwrap();
        let services = services(sessions);
        let mut rx = services.hub.subscribe();
        let failure = relaunch_failed_notification_id(SID);
        let from_switch = crate::control_account::switch_notification_ids(SID);
        let stale: Vec<String> = std::iter::once(failure)
            .chain(from_switch)
            .collect();
        for id in &stale {
            services.hub.record_terminal_error(
                id.clone(),
                "restart_failed",
                &relaunch_failed_body("repo"),
                SID,
                1,
            );
        }
        let recorded = synced_notification_ids(&mut rx)
            .await
            .expect("recording should have synced");
        assert!(stale.iter().all(|id| recorded.contains(id)), "{recorded:?}");

        assert_eq!(
            restart_in_place(&services, SID, &meta(), "/bin/sh", "/bin/echo", None).await,
            RestartOutcome::Restarted
        );

        let left = synced_notification_ids(&mut rx)
            .await
            .expect("the retraction should have synced");
        assert!(stale.iter().all(|id| !left.contains(id)), "{left:?}");
    }

    /// Terms bound to the restarted terminal are woken as well as told to reconnect: the notice only
    /// reaches clients whose control socket is up right then, and a bridge that misses it keeps
    /// rendering the dead PTY until a heartbeat comes round.
    #[tokio::test]
    async fn a_restart_wakes_the_terms_bound_to_it() {
        let sessions = Arc::new(SessionRegistry::new());
        sessions
            .create_with_meta(SID.to_string(), sleep_cfg(), meta())
            .await
            .unwrap();
        let services = services(sessions);
        services.terms.lock().unwrap().commit(
            crate::term_registry::TermEntry::new("t1".to_string(), SID.to_string(), 80, 24),
        );
        let notify = services.terms.lock().unwrap().bind_notify("t1").unwrap();

        assert_eq!(
            restart_in_place(&services, SID, &meta(), "/bin/sh", "/bin/echo", None).await,
            RestartOutcome::Restarted
        );

        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(500), notify.notified())
                .await
                .is_ok(),
            "the bridge on this term should have been woken"
        );
    }

    /// A restart keeps the terminal where the user put it in the SESSION LIST, because the
    /// registration is never removed — only the PTY behind it is swapped.
    #[cfg(unix)]
    #[tokio::test]
    async fn restart_in_place_keeps_its_position_in_the_list() {
        let sessions = Arc::new(SessionRegistry::new());
        let other = "11111111-2222-4333-8444-555555555555";
        sessions
            .create_with_meta(SID.to_string(), sleep_cfg(), meta())
            .await
            .unwrap();
        sessions
            .create_with_meta(other.to_string(), sleep_cfg(), meta())
            .await
            .unwrap();
        sessions
            .set_order(vec![SID.to_string(), other.to_string()])
            .await;
        let services = services(sessions.clone());

        assert_eq!(
            restart_in_place(&services, SID, &meta(), "/bin/sh", "/bin/echo", None).await,
            RestartOutcome::Restarted
        );

        let order: Vec<String> = sessions
            .entries()
            .await
            .into_iter()
            .map(|(id, _, _)| id)
            .collect();
        assert_eq!(order, vec![SID.to_string(), other.to_string()]);
    }

    /// A replacement that cannot start leaves the row registered: its id is the only handle on the
    /// conversation, and attached terms hold their last screen rather than looping on reconnects.
    #[cfg(unix)]
    #[tokio::test]
    async fn restart_in_place_keeps_the_row_when_the_replacement_cannot_start() {
        let sessions = Arc::new(SessionRegistry::new());
        sessions
            .create_with_meta(SID.to_string(), sleep_cfg(), meta())
            .await
            .unwrap();
        let services = services(sessions.clone());

        // The resume runs under a shell that cannot be executed, so the spawn itself fails.
        assert_eq!(
            restart_in_place(
                &services,
                SID,
                &meta(),
                "/nonexistent/shell",
                "/bin/echo",
                None
            )
            .await,
            RestartOutcome::NotStarted
        );

        assert!(
            sessions.get(SID).await.is_some(),
            "the row must survive a failed relaunch"
        );
    }

    /// With claude not being launched at all, every terminal is a plain login shell with nothing to
    /// resume, so a restart reports that rather than relaunching anything.
    #[cfg(unix)]
    #[tokio::test]
    async fn restart_in_place_reports_claude_being_disabled() {
        let sessions = Arc::new(SessionRegistry::new());
        sessions
            .create_with_meta(SID.to_string(), sleep_cfg(), meta())
            .await
            .unwrap();
        let before = sessions.get(SID).await.unwrap().pid();
        let mut services = services(sessions.clone());
        services.launch_claude = false;

        assert_eq!(
            restart_in_place(&services, SID, &meta(), "/bin/sh", "/bin/echo", None).await,
            RestartOutcome::ClaudeDisabled
        );

        assert_eq!(sessions.get(SID).await.unwrap().pid(), before);
    }

    /// A conversation belongs to its project directory. With that directory gone there is nowhere to
    /// resume from, and starting somewhere else would quietly create a different, empty conversation —
    /// so the restart is refused and the row keeps pointing at the real one.
    #[cfg(unix)]
    #[tokio::test]
    async fn restart_in_place_refuses_when_the_directory_is_gone() {
        let sessions = Arc::new(SessionRegistry::new());
        let gone = SessionMeta {
            cwd: "/nonexistent/worktree".to_string(),
            wname: "work".to_string(),
        };
        sessions
            .create_with_meta(SID.to_string(), sleep_cfg(), gone.clone())
            .await
            .unwrap();
        let before = sessions.get(SID).await.unwrap().pid();
        let services = services(sessions.clone());

        assert_eq!(
            restart_in_place(&services, SID, &gone, "/bin/sh", "/bin/echo", None).await,
            RestartOutcome::CwdMissing
        );

        assert_eq!(sessions.get(SID).await.unwrap().pid(), before);
    }

    /// An id that is not a Claude session id has no conversation to resume, so it is left alone
    /// rather than being torn down.
    #[cfg(unix)]
    #[tokio::test]
    async fn restart_in_place_leaves_a_non_sid_terminal_alone() {
        let sessions = Arc::new(SessionRegistry::new());
        sessions
            .create_with_meta("shell:0:work".to_string(), sleep_cfg(), meta())
            .await
            .unwrap();
        let before = sessions.get("shell:0:work").await.unwrap().pid();
        let services = services(sessions.clone());

        assert_eq!(
            restart_in_place(&services, "shell:0:work", &meta(), "/bin/sh", "/bin/echo", None).await,
            RestartOutcome::Skipped
        );

        assert_eq!(sessions.get("shell:0:work").await.unwrap().pid(), before);
    }
}
