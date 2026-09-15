//! Account actions from the header account menu: sign in / out via `claude auth`, and restart every
//! running Cockpit Terminal so its `claude` re-reads the switched account.
//!
//! Claude Code auth is global per OS user, so a switch reaches new sessions automatically but an
//! already-running `claude` keeps the account it started with. Resuming each session by its own sid
//! (history preserved, id unchanged) is the reliable way to apply the switch to the running ones.

use std::process::Stdio;
use std::sync::Arc;

use crate::control::ControlServices;
use crate::control_dispatch::trigger_refresh;
use crate::control_hub::ControlHub;

/// Runs the interactive `claude auth login` (browser OAuth) to completion, then re-reads and broadcasts
/// the account. `claude auth` has no silent switch, so re-authenticating is how the account changes.
/// Login is detached from any terminal: `claude` opens the browser itself and finishes via its
/// localhost callback, so no stdin is attached and no in-app terminal is shown. Choosing a different
/// account switches; cancelling in the browser leaves the current one. Already-running Cockpit Terminals
/// keep their launch-time account until an `account.refresh` restarts them.
pub(crate) async fn run_account_login(hub: Arc<ControlHub>) {
    run_auth_and_publish(hub, "login").await;
}

/// Signs out via `claude auth logout`, then re-reads and broadcasts the (now signed-out) account.
pub(crate) async fn run_account_logout(hub: Arc<ControlHub>) {
    run_auth_and_publish(hub, "logout").await;
}

/// Runs `claude auth <subcommand>` detached (no inherited stdio) and, once it exits, broadcasts a fresh
/// `account.status`. A spawn/exit failure is ignored: the re-read then reports the unchanged account.
async fn run_auth_and_publish(hub: Arc<ControlHub>, subcommand: &str) {
    let claude = crate::session_launch::resolve_claude_program();
    let _ = tokio::process::Command::new(&claude)
        .args(["auth", subcommand])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await;
    hub.publish_account_status(crate::account_status::read_account_status(&claude).await);
}

/// How long the whole pass may spend **waiting** on terminals whose restart claim is held, and how
/// long to wait between attempts. Only the waiting counts against the budget — the pass's own
/// teardown-and-spawn time must not consume it, or the terminals at the tail of a long list would be
/// abandoned without ever being retried. Shared across the pass, so a list of held terminals cannot
/// stretch it by the full budget each.
const BUSY_RETRY_BUDGET: std::time::Duration = std::time::Duration::from_secs(3);
const BUSY_RETRY_INTERVAL: std::time::Duration = std::time::Duration::from_millis(200);

/// Restarts every registered Cockpit Terminal in place (same id) via `claude --resume <sid>`. Runs
/// sequentially so each teardown finishes before its respawn (they share the registry). Sessions with
/// a non-UUID id are skipped, and the whole pass is a no-op when claude isn't launched (nothing is
/// bound to an account). A terminal whose relaunch fails stays in the list on its stopped session and
/// can be restarted by hand; the rest still get the fresh account, as do new sessions.
pub(crate) async fn restart_all_for_account(services: &ControlServices) {
    if !services.launch_claude {
        return;
    }
    let shell = crate::session_restore::login_shell();
    let claude = crate::session_launch::resolve_claude_program();
    let settings =
        crate::session_launch::account_usage_settings(services.hub.account_usage_enabled());

    let mut restarted = false;
    let mut busy_wait_left = BUSY_RETRY_BUDGET;
    for (id, _session, meta) in services.sessions.entries().await {
        let mut outcome = crate::control_session::restart_in_place(
            services,
            &id,
            &meta,
            &shell,
            &claude,
            settings.as_deref(),
        )
        .await;
        // A restart the user started moments ago holds this id; skipping it would leave that terminal
        // on the account we are switching away from, so wait for the claim and take it.
        while outcome == crate::control_session::RestartOutcome::Busy
            && !busy_wait_left.is_zero()
        {
            let wait = BUSY_RETRY_INTERVAL.min(busy_wait_left);
            tokio::time::sleep(wait).await;
            busy_wait_left -= wait;
            outcome = crate::control_session::restart_in_place(
                services,
                &id,
                &meta,
                &shell,
                &claude,
                settings.as_deref(),
            )
            .await;
        }
        // Left on the account being switched away from, and only this terminal is affected — the user
        // has to be told which one, or they have no way to know the switch was partial.
        if outcome == crate::control_session::RestartOutcome::NotStarted {
            services.hub.record_error(
                format!("account-switch-failed:{id}"),
                "account_switch_incomplete",
                &format!(
                    "{} を再起動できず、停止したままです。もう一度再起動すると会話を再開できます。",
                    meta.wname
                ),
                crate::now_ms(),
            );
        }
        // Refused before the process was touched, so this one is still running claude on the account
        // being switched away from — the same partial switch as the cases above.
        if outcome == crate::control_session::RestartOutcome::CwdMissing {
            services.hub.record_error(
                format!("account-switch-cwd:{id}"),
                "account_switch_incomplete",
                &format!(
                    "{} は作業ディレクトリが見つからず再起動できないため、切り替え前のアカウントのままです。",
                    meta.wname
                ),
                crate::now_ms(),
            );
        }
        if outcome == crate::control_session::RestartOutcome::Busy {
            services.hub.record_error(
                format!("account-switch-busy:{id}"),
                "account_switch_incomplete",
                &format!(
                    "{} は再起動中だったため、切り替え前のアカウントのままです。",
                    meta.wname
                ),
                crate::now_ms(),
            );
        }
        // A relaunch that failed still tore the old process down, so the list is stale either way.
        if matches!(
            outcome,
            crate::control_session::RestartOutcome::Restarted
                | crate::control_session::RestartOutcome::NotStarted
        ) {
            restarted = true;
        }
    }

    if restarted {
        trigger_refresh(services).await;
    }
}
