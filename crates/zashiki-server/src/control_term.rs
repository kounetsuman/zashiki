use axum::extract::ws::WebSocket;
use zashiki_core::terminal_size::clamp_terminal_size;

use crate::control::{report_error, request_refresh, to_text, ControlServices};
use crate::control_hub::state_sync_of;
use crate::term_registry::TermEntry;

/// Creates a view term and registers it in the registry. PTY connection happens via `/ws/term`.
pub(crate) async fn handle_term_open(
    socket: &mut WebSocket,
    services: &ControlServices,
    term_id: String,
    window_id: Option<String>,
    cols: u32,
    rows: u32,
) -> bool {
    // Synchronous reservation to exclude concurrent opens (before any await). Existing/in-progress yields term_exists.
    if !services.terms.lock().unwrap().try_reserve(&term_id) {
        let message = format!("termId {term_id} is already open");
        return report_error(socket, &services.hub, "term_exists", &message).await;
    }
    let (cols, rows, _) = clamp_terminal_size(cols, rows);
    let ok = open_owned_term(socket, services, term_id, window_id, cols, rows).await;
    let Some(()) = ok else {
        return false;
    };
    // As with manual refresh, on success return state.sync to the requester.
    let snapshot = request_refresh(services).await;
    let reply = snapshot
        .map(|s| state_sync_of(&s))
        .unwrap_or_else(|| services.hub.current_state_sync());
    socket.send(to_text(&reply)).await.is_ok()
}

/// The owned term.open. Without creating a tmux view session, it puts the windowId (UUID)
/// directly into the term registry's session_id. The PTY was already spawned into SessionRegistry
/// by session.new, and `/ws/term`'s `attach_owned_term` looks it up directly by session_id=windowId
/// (1 PTY = 1 window; there is no select-window). When windowId is unspecified (unselected right
/// after startup), it is registered unbound with an empty session_id and bound later by term.select
/// (the client always sends term.select after attaching). The reservation is already done. Always `Some(())`.
async fn open_owned_term(
    _socket: &mut WebSocket,
    services: &ControlServices,
    term_id: String,
    window_id: Option<String>,
    cols: u32,
    rows: u32,
) -> Option<()> {
    let session_id = window_id.unwrap_or_default();
    services
        .terms
        .lock()
        .unwrap()
        .commit(TermEntry::new(term_id, session_id, cols, rows));
    Some(())
}
