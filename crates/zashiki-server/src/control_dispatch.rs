use axum::extract::ws::WebSocket;
use tokio::sync::oneshot;
use zashiki_core::terminal_size::clamp_terminal_size;

use crate::control::{to_text, ControlServices, RefreshRequest};
use crate::control_hub::{state_sync_of, ControlHub};
use crate::control_session::handle_session_new;
use crate::control_term::handle_term_open;
use crate::protocol::{ClientMessage, ServerMessage};
use crate::status_poller::StateSnapshot;

/// Parses received text as a ClientMessage and dispatches it. Return value = whether the
/// connection should continue. session.new/close and term.* come later (valid but
/// unhandled ones are no-ops).
pub(crate) async fn handle_client_message(
    socket: &mut WebSocket,
    services: &ControlServices,
    text: &str,
) -> bool {
    let msg = match serde_json::from_str::<ClientMessage>(text) {
        Ok(msg) => msg,
        Err(_) => {
            return report_error(socket, &services.hub, "invalid_message", "invalid client message")
                .await;
        }
    };
    match msg {
        // Manual refresh: re-evaluate immediately and always return state.sync to the requester, even if nothing changed.
        ClientMessage::StateRefresh => {
            let snapshot = request_refresh(services).await;
            let reply = snapshot
                .map(|s| state_sync_of(&s))
                .unwrap_or_else(|| services.hub.current_state_sync());
            socket.send(to_text(&reply)).await.is_ok()
        }
        // Remove only dismissible notifications, and broadcast notifications.sync to all connections if anything changed.
        ClientMessage::NotificationDismiss { id } => {
            services.hub.dismiss_notification(&id);
            true
        }
        // Persist the SETTINGS language change to config.json. Rather than trusting the client's
        // zod validation, the server side also allow-list validates ja/en (defense in depth).
        // After writing, deliver to all connections immediately and reliably via publish_config,
        // without depending on the watch's mtime lag or dropped events.
        ClientMessage::ConfigUpdate { language } => {
            if language != "ja" && language != "en" {
                return report_error(
                    socket,
                    &services.hub,
                    "invalid_language",
                    &format!("未対応の言語です: {language}"),
                )
                .await;
            }
            if let Some(path) = &services.config_path {
                if let Err(e) = crate::config::write_config_language(path, &language) {
                    return report_error(
                        socket,
                        &services.hub,
                        "config_write_failed",
                        &format!("config の書き込みに失敗しました: {e}"),
                    )
                    .await;
                }
                services.hub.publish_config(crate::config::read_config(path));
            }
            true
        }
        // Persist the account-usage opt-in and broadcast config.sync (like the language change). Takes
        // effect on the next launched claude via the launch-time --settings injection.
        ClientMessage::ConfigSetAccountUsage { enabled } => {
            if let Some(path) = &services.config_path {
                if let Err(e) = crate::config::write_config_account_usage(path, enabled) {
                    return report_error(
                        socket,
                        &services.hub,
                        "config_write_failed",
                        &format!("config の書き込みに失敗しました: {e}"),
                    )
                    .await;
                }
                services.hub.publish_config(crate::config::read_config(path));
            }
            true
        }
        // Persist the external editor command and broadcast config.sync (like the language change).
        // Not allow-listed: the value reaches Command::new as ZK_EDITOR already does. A blank clears it.
        ClientMessage::ConfigSetEditor { editor } => {
            if let Some(path) = &services.config_path {
                if let Err(e) = crate::config::write_config_editor(path, editor.trim()) {
                    return report_error(
                        socket,
                        &services.hub,
                        "config_write_failed",
                        &format!("config の書き込みに失敗しました: {e}"),
                    )
                    .await;
                }
                services.hub.publish_config(crate::config::read_config(path));
            }
            true
        }
        // Persist the status-footer severity thresholds and broadcast config.sync (like the language
        // change). The written value is re-read, so read_config's clamp is the authoritative sanitizer.
        ClientMessage::ConfigSetFooterThresholds { footer_thresholds } => {
            if let Some(path) = &services.config_path {
                if let Err(e) =
                    crate::config::write_config_footer_thresholds(path, &footer_thresholds)
                {
                    return report_error(
                        socket,
                        &services.hub,
                        "config_write_failed",
                        &format!("config の書き込みに失敗しました: {e}"),
                    )
                    .await;
                }
                services.hub.publish_config(crate::config::read_config(path));
            }
            true
        }
        // Install/remove zashiki's Claude Code integration in ~/.claude/settings.json, then broadcast
        // the fresh status to every connection.
        ClientMessage::HooksRegister => apply_hooks_change(socket, services, true).await,
        ClientMessage::HooksUnregister => apply_hooks_change(socket, services, false).await,
        // On-demand "Check for updates" (SETTINGS): run the check now (ignoring the background egress
        // flag — explicit user intent) and reply with the outcome so the UI can show feedback. A newer
        // version also flows to all clients as a notification via run_manual_check.
        ClientMessage::UpdateCheck => {
            use crate::protocol::UpdateCheckStatus;
            use crate::update_checker::CheckOutcome;
            let result = match &services.app_version {
                Some(current) => {
                    match crate::update_checker::run_manual_check(&services.hub, current).await {
                        CheckOutcome::Newer { version, .. } => ServerMessage::UpdateCheckResult {
                            status: UpdateCheckStatus::Available,
                            version: Some(version),
                        },
                        CheckOutcome::UpToDate => ServerMessage::UpdateCheckResult {
                            status: UpdateCheckStatus::UpToDate,
                            version: None,
                        },
                        CheckOutcome::Failed => ServerMessage::UpdateCheckResult {
                            status: UpdateCheckStatus::Error,
                            version: None,
                        },
                    }
                }
                None => ServerMessage::UpdateCheckResult {
                    status: UpdateCheckStatus::Error,
                    version: None,
                },
            };
            socket.send(to_text(&result)).await.is_ok()
        }
        // Long-running: run brew + relaunch off the WS loop, reporting progress via update.status
        // broadcasts. app_version being set marks the desktop-shell context (gates brew vs open-page).
        ClientMessage::UpdatePerform => {
            let hub = services.hub.clone();
            let present = services.app_version.is_some();
            tokio::spawn(async move { crate::self_update::perform_update(hub, present).await });
            true
        }
        ClientMessage::CockpitTerminalNew { org, resume_sid } => {
            handle_session_new(socket, services, &org, resume_sid.as_deref()).await
        }
        // For owned, the actual entity lives in SessionRegistry, so remove it from the registry.
        // remove aggregates killpg + reap + deregistration and is idempotent even when absent (the bool is discarded).
        ClientMessage::CockpitTerminalClose { cockpit_terminal_id } => {
            services.sessions.remove(&cockpit_terminal_id).await;
            trigger_refresh(services).await;
            true
        }
        ClientMessage::TermOpen {
            term_id,
            cockpit_terminal_id,
            cols,
            rows,
        } => handle_term_open(socket, services, term_id, cockpit_terminal_id, cols, rows).await,
        // Hold the finalized size and, if currently attached, propagate it to the PTY as well (no-op if not attached).
        ClientMessage::TermResize {
            term_id,
            cols,
            rows,
        } => {
            let (cols, rows, _) = clamp_terminal_size(cols, rows);
            if services
                .terms
                .lock()
                .unwrap()
                .set_size(&term_id, cols, rows)
            {
                crate::term_attach_pty::resize_owned_term(
                    services,
                    &term_id,
                    cols as u16,
                    rows as u16,
                )
                .await;
                true
            } else {
                send_unknown_term(socket, &services.hub, &term_id).await
            }
        }
        // Since switching the view changes the window size and visible content, re-evaluate immediately after select.
        // For owned, 1 PTY = 1 window. cockpitTerminalId is the session_id of the switch-target PTY, so
        // rebind that term's registry session_id so that subsequent resize/attach look up the new PTY.
        ClientMessage::TermSelect { term_id, cockpit_terminal_id } => {
            if services
                .terms
                .lock()
                .unwrap()
                .rebind_session(&term_id, &cockpit_terminal_id)
            {
                trigger_refresh(services).await;
                true
            } else {
                send_unknown_term(socket, &services.hub, &term_id).await
            }
        }
        ClientMessage::TermClose { term_id } => {
            let entry = services.terms.lock().unwrap().take_for_teardown(&term_id);
            match entry {
                // The PTY lifecycle is owned by the SessionRegistry on the CockpitTerminalClose side, so
                // here we only tear down the term registry (no double-free).
                Some(_) => true,
                None => send_unknown_term(socket, &services.hub, &term_id).await,
            }
        }
        // An ack to an already-closed term is a normal case (no-op). If present, update the flow state.
        ClientMessage::TermAck { term_id, bytes } => {
            services.terms.lock().unwrap().apply_ack(&term_id, bytes);
            true
        }
    }
}

/// Registers or unregisters zashiki's integration in ~/.claude/settings.json and broadcasts the
/// resulting hooks.status. A write failure returns an error dialog and leaves the file untouched.
async fn apply_hooks_change(socket: &mut WebSocket, services: &ControlServices, register: bool) -> bool {
    let Some(paths) = services.claude_settings.as_ref() else {
        return report_error(socket, &services.hub, "hooks_unavailable", "settings path is not available").await;
    };
    let result = if register {
        crate::claude_settings_io::apply_register(paths)
    } else {
        crate::claude_settings_io::apply_unregister(paths)
    };
    match result {
        Ok(status) => {
            services.hub.publish_hooks_status(status);
            true
        }
        Err(e) => {
            report_error(
                socket,
                &services.hub,
                "hooks_write_failed",
                &format!("~/.claude/settings.json の書き込みに失敗しました: {e}"),
            )
            .await
        }
    }
}

/// An immediate re-evaluation after a mutation (fire-and-forget; reflected to all connections via broadcast).
pub(crate) async fn trigger_refresh(services: &ControlServices) {
    let _ = services.refresh.send(RefreshRequest { reply: None }).await;
}

/// Returns `{t:"error"}` (for the ErrorDialog) to the requester while also enqueuing the error
/// notification globally and delivering it to all connections. The id is
/// unique per occurrence (randomUUID).
pub(crate) async fn report_error(socket: &mut WebSocket, hub: &ControlHub, code: &str, message: &str) -> bool {
    hub.record_error(uuid::Uuid::new_v4().to_string(), code, message, crate::now_ms());
    let msg = ServerMessage::Error {
        code: code.to_string(),
        message: message.to_string(),
    };
    socket.send(to_text(&msg)).await.is_ok()
}

async fn send_internal_error(
    socket: &mut WebSocket,
    hub: &ControlHub,
    err: &impl std::fmt::Display,
) -> bool {
    report_error(socket, hub, "internal", &err.to_string()).await
}

pub(crate) async fn send_unknown_term(socket: &mut WebSocket, hub: &ControlHub, term_id: &str) -> bool {
    report_error(socket, hub, "unknown_term", &format!("termId {term_id} is not open")).await
}

/// Returns a creation failure to the requester. If it stems from PTY exhaustion, enqueue a single
/// dedicated sticky warning that prompts action rather than a generic error notification
/// (record_pty_exhaustion aggregates via a fixed id). The dialog is always returned.
pub(crate) async fn fail_session_create(
    socket: &mut WebSocket,
    services: &ControlServices,
    err: &impl std::fmt::Display,
) -> bool {
    let message = err.to_string();
    if crate::notifications::is_pty_exhaustion(&message) {
        services.hub.record_pty_exhaustion(crate::now_ms());
        let msg = ServerMessage::Error {
            code: "internal".to_string(),
            message,
        };
        return socket.send(to_text(&msg)).await.is_ok();
    }
    send_internal_error(socket, &services.hub, err).await
}

/// Requests an immediate re-evaluation from the poller and receives the post-evaluation snapshot (None if the path is down).
pub(crate) async fn request_refresh(services: &ControlServices) -> Option<StateSnapshot> {
    let (tx, rx) = oneshot::channel();
    services
        .refresh
        .send(RefreshRequest { reply: Some(tx) })
        .await
        .ok()?;
    rx.await.ok()
}
