//! Restart every running Cockpit Terminal so its `claude` re-reads the switched account.
//!
//! Claude Code auth is global per OS user, so a switch reaches new sessions automatically but an
//! already-running `claude` keeps the account it started with. Resuming each session by its own sid
//! (history preserved, id unchanged) is the reliable way to apply the switch to the running ones.

use zashiki_core::save_file::{is_uuid_sid, SaveEntry};

use crate::control::ControlServices;
use crate::control_dispatch::trigger_refresh;
use crate::session_registry::SessionMeta;

/// Restarts every registered Cockpit Terminal in place (same id) via `claude --resume <sid>`. Runs
/// sequentially so each teardown finishes before its respawn (they share the registry). Sessions with
/// a non-UUID id are skipped, and the whole pass is a no-op when claude isn't launched (nothing is
/// bound to an account). A single respawn failure just leaves that terminal closed; the rest still get
/// the fresh account, as do new sessions.
pub(crate) async fn restart_all_for_account(services: &ControlServices) {
    if !services.launch_claude {
        return;
    }
    let shell = crate::session_restore::login_shell();
    let claude = crate::session_launch::resolve_claude_program();
    let settings =
        crate::session_launch::account_usage_settings(services.hub.account_usage_enabled());

    let mut restarted = false;
    for (id, _session, meta) in services.sessions.entries().await {
        if !is_uuid_sid(&id) {
            continue;
        }
        let cwd = crate::session_launch::resolve_cwd(&meta.cwd);
        let entry = SaveEntry {
            widx: String::new(),
            wname: meta.wname.clone(),
            cwd: cwd.clone(),
            sid: id.clone(),
        };
        let Some(plan) =
            crate::session_restore::plan_resume(&entry, &shell, &claude, settings.as_deref())
        else {
            continue;
        };
        // Only respawn what we actually tore down: a false return means the terminal was closed
        // concurrently, and recreating it would resurrect a session the user just dismissed.
        if !services.sessions.remove(&id).await {
            continue;
        }
        let _ = services
            .sessions
            .create_with_meta(
                id,
                crate::session_restore::plan_to_config(&plan),
                SessionMeta { cwd, wname: meta.wname },
            )
            .await;
        restarted = true;
    }

    if restarted {
        trigger_refresh(services).await;
    }
}
