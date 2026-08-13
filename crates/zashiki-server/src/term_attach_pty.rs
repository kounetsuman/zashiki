//! Owned-PTY bridge for `/ws/term/<termId>` (post-tmux removal).
//!
//! Built on the premise that the server is the sole PTY owner and reader (see [`crate::pty_host`]),
//! the browser **subscribes** to a [`PtySession`] in [`crate::session_registry::SessionRegistry`].
//!
//! Characteristics of an owned PTY (because it has multiple subscribers and shares the PTY with the
//! state-detection poller):
//! - **Restore on attach / tab switch uses raw ring replay (scrollback) + the redraw sequence from
//!   `contents_formatted()`**. The redraw sequence only carries the current screen (the vt100 parser
//!   keeps 0 scrollback rows), so scrollback would be empty after a restart or tab reopen. We stream
//!   the raw replay first to rebuild the history, then use the redraw sequence to overwrite the
//!   current screen precisely, including colors and cursor position. The raw replay may be corrupted
//!   at the very start if it begins mid-escape-sequence.
//! - A broadcast `Lagged` recovers automatically by re-subscribing and resending the current screen
//!   (redraw sequence only). We do not resend the raw replay here, to avoid duplicating scrollback
//!   the client already holds.
//! - **Backpressure: never propagate one subscriber's lag to the PTY itself**. The tmux-era strategy
//!   of "stop draining out_rx and let the PTY stall" is not used for an owned PTY (it would drag down
//!   the other subscribers and the poller). While paused we **drain and discard** the broadcast, and
//!   on resume we resend the current screen (`contents_formatted`) to reconcile.
//!
//! The source of truth for behavior is the `tests` at the end of this file (a real axum WS + an echo
//! PTY via `sh -c cat`; no tmux required).

use std::sync::Arc;

use axum::extract::ws::{CloseFrame, Message, WebSocket};
use tokio::sync::broadcast::error::RecvError;

use crate::control::ControlServices;
use crate::pty_host::PtySession;
use crate::term_registry::AttachOutcome;

/// UTF-16 code-unit count of an outgoing binary frame (same definition as the tmux-era
/// [`crate::term_attach`], so the unit matches the client's term.ack on both ends. ASCII borrows with
/// no allocation, and incomplete UTF-8 degrades symmetrically to the replacement character).
fn utf16_units(data: &[u8]) -> u64 {
    String::from_utf8_lossy(data).encode_utf16().count() as u64
}

async fn close(socket: &mut WebSocket, code: u16, reason: &'static str) {
    let _ = socket
        .send(Message::Close(Some(CloseFrame {
            code,
            reason: reason.into(),
        })))
        .await;
}

/// Resize the owned PTY from term.resize (on the control WS, a separate task). Resolves termId to
/// session_id via [`TermRegistry`](crate::term_registry::TermRegistry) and calls [`PtySession::resize`]
/// (syncing the master + vt100 parser; the server is the authority on size). No-op if unregistered or
/// not started. `control.rs`'s `term.resize` calls this function (the tests are the source of truth).
pub async fn resize_owned_term(services: &ControlServices, term_id: &str, cols: u16, rows: u16) {
    let session_id = services.terms.lock().unwrap().session_id(term_id);
    let Some(session_id) = session_id else {
        return;
    };
    if let Some(session) = services.sessions.get(&session_id).await {
        let _ = session.resize(cols, rows);
    }
}

/// Apply the TermEntry's confirmed size to the owned PTY. The client does not send term.resize unless
/// the window size changes after startup, so unless we reflect the real size here on attach / bind, the
/// PTY stays at its startup 80x24 and the TUI's wrapping and display go out of sync. Effectively a no-op
/// if unregistered or unchanged.
fn apply_term_size(session: &PtySession, services: &ControlServices, term_id: &str) {
    if let Some((cols, rows)) = services.terms.lock().unwrap().term_size(term_id) {
        let _ = session.resize(cols, rows);
    }
}

/// Handle one `/ws/term` connection by subscribing to the owned PTY (tmux-independent).
/// Upper bound for waiting on a term.select bind when attaching in an unbound state (term.open had no
/// windowId). The client always sends term.select immediately after attach (onOpen), so it is normally
/// bound right away.
const BIND_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

pub async fn attach_owned_term(mut socket: WebSocket, term_id: String, services: ControlServices) {
    let outcome = services.terms.lock().unwrap().try_mark_attached(&term_id);
    match outcome {
        AttachOutcome::Missing => {
            close(
                &mut socket,
                4404,
                "unknown termId (send term.open on /ws/control first)",
            )
            .await;
            return;
        }
        AttachOutcome::AlreadyAttached => {
            close(&mut socket, 4409, "termId already attached").await;
            return;
        }
        AttachOutcome::Ready { .. } => {}
    };

    // If unbound (term.open had no windowId), wait for a term.select bind. Once bound, session_id
    // becomes a real sid and `resolve_bound_session` returns Some.
    let session = match resolve_bound_session(&term_id, &services).await {
        Some(session) => session,
        None => {
            // Not bound within the deadline, or the bind target PTY is gone. Release so the termId does
            // not stay stuck, and close.
            services.terms.lock().unwrap().take_for_teardown(&term_id);
            close(&mut socket, 1011, "no owned pty for terminal").await;
            return;
        }
    };

    run_bridge(&mut socket, &term_id, session, &services).await;
    services.terms.lock().unwrap().take_for_teardown(&term_id);
}

/// Wait until the term registry's session_id is bound (becomes non-empty) and return the bound
/// PtySession. Returns immediately if already bound. None on deadline expiry or if the bind target PTY
/// is absent.
async fn resolve_bound_session(
    term_id: &str,
    services: &ControlServices,
) -> Option<Arc<PtySession>> {
    let deadline = tokio::time::Instant::now() + BIND_WAIT;
    let bind_notify = services.terms.lock().unwrap().bind_notify(term_id)?;
    loop {
        // Build notified() before reading state, so a notify_waiters that arrives in the gap between
        // read and await is not missed (tokio's recommended ordering).
        let notified = bind_notify.notified();
        let session_id = services.terms.lock().unwrap().session_id(term_id)?;
        if !session_id.is_empty() {
            return services.sessions.get(&session_id).await;
        }
        if tokio::time::timeout_at(deadline, notified).await.is_err() {
            return None;
        }
    }
}

/// Send one binary frame and charge it against the ack budget. Sends nothing if empty (suppresses
/// wasted frames). Err on send failure; on success returns the pause state after charging.
async fn send_accounted(
    socket: &mut WebSocket,
    services: &ControlServices,
    term_id: &str,
    data: Vec<u8>,
) -> Result<bool, ()> {
    if data.is_empty() {
        return Ok(false);
    }
    let units = utf16_units(&data);
    if socket.send(Message::Binary(data)).await.is_err() {
        return Err(());
    }
    Ok(services.terms.lock().unwrap().on_sent(term_id, units))
}

/// Send the screen restore on attach / tab switch (rebind): raw ring replay (rebuilds scrollback) first,
/// then the current screen's redraw sequence (overwriting colors and cursor position precisely). The raw
/// replay may be corrupted at the start if it begins mid-escape-sequence, but it is the only way to
/// rebuild scrollback in the browser xterm, so it is streamed before the current screen. Err on send
/// failure; on success returns the pause state. Not used for mid-stream recovery on Lagged/resume
/// (resending the raw replay would duplicate scrollback the client already holds; those paths reconcile
/// with the redraw sequence only).
async fn send_restore(
    socket: &mut WebSocket,
    services: &ControlServices,
    term_id: &str,
    replay: Vec<u8>,
    formatted: Vec<u8>,
) -> Result<bool, ()> {
    let paused_after_replay = send_accounted(socket, services, term_id, replay).await?;
    let paused_after_screen = send_accounted(socket, services, term_id, formatted).await?;
    Ok(paused_after_replay || paused_after_screen)
}

/// The main loop: subscribe -> initial restore (raw ring replay + redraw sequence) -> then run
/// live/input/backpressure/heartbeat. Because an owned PTY's attach target can be swapped on a tab switch
/// (term.select), watch for session_id changes via `bind_notify`; on change, re-subscribe to the new PTY
/// and resend scrollback + the current screen.
async fn run_bridge(
    socket: &mut WebSocket,
    term_id: &str,
    mut session: Arc<PtySession>,
    services: &ControlServices,
) {
    // On attach, align the PTY to the TermEntry's real size (independent of any resize message).
    apply_term_size(&session, services, term_id);
    let mut sub = session.subscribe();
    // Restore the initial screen and history in order: raw ring replay (rebuilds scrollback), then the
    // current screen's redraw sequence.
    let replay = std::mem::take(&mut sub.replay);
    let formatted = session.screen_formatted();
    if send_restore(socket, services, term_id, replay, formatted)
        .await
        .is_err()
    {
        return;
    }

    let mut heartbeat = tokio::time::interval_at(
        tokio::time::Instant::now() + services.heartbeat,
        services.heartbeat,
    );
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut alive = true;

    let resume_notify = services
        .terms
        .lock()
        .unwrap()
        .resume_notify(term_id)
        .unwrap_or_else(|| Arc::new(tokio::sync::Notify::new()));
    // The sid currently subscribed to. Re-subscribe if term.select swaps in a different sid.
    let mut bound_sid = services
        .terms
        .lock()
        .unwrap()
        .session_id(term_id)
        .unwrap_or_default();
    let bind_notify = services
        .terms
        .lock()
        .unwrap()
        .bind_notify(term_id)
        .unwrap_or_else(|| Arc::new(tokio::sync::Notify::new()));
    let mut paused = false;

    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                if !alive {
                    break;
                }
                alive = false;
                if socket.send(Message::Ping(Vec::new())).await.is_err() {
                    break;
                }
            }
            // Always drain live output (even while paused, drain and discard = never stall the PTY
            // itself; the opposite of the tmux version).
            live = sub.receiver.recv() => match live {
                Ok(chunk) => {
                    if paused {
                        // Discard while paused. On resume, resend the current screen to reconcile (the
                        // resume branch below).
                        continue;
                    }
                    let units = utf16_units(&chunk);
                    if socket.send(Message::Binary(chunk.to_vec())).await.is_err() {
                        break;
                    }
                    paused = services.terms.lock().unwrap().on_sent(term_id, units);
                }
                // A lagging subscriber's drop -> recover automatically by re-subscribing and resending
                // the current screen (redraw sequence).
                Err(RecvError::Lagged(_)) => {
                    sub = session.subscribe();
                    if !paused {
                        let formatted = session.screen_formatted();
                        if !formatted.is_empty() {
                            let units = utf16_units(&formatted);
                            if socket.send(Message::Binary(formatted)).await.is_err() {
                                break;
                            }
                            paused = services.terms.lock().unwrap().on_sent(term_id, units);
                        }
                    }
                }
                // PTY exit (the sender is dropped when the reader thread stops). Close the WS.
                Err(RecvError::Closed) => break,
            },
            // ack has progressed to the low watermark and a resume was signaled -> re-read shared state.
            // On resume, resend the current screen to recover the output discarded while paused (screen
            // reconciliation).
            _ = resume_notify.notified() => {
                let now_paused = services.terms.lock().unwrap().is_paused(term_id);
                if paused && !now_paused {
                    let formatted = session.screen_formatted();
                    if !formatted.is_empty() {
                        let units = utf16_units(&formatted);
                        if socket.send(Message::Binary(formatted)).await.is_err() {
                            break;
                        }
                        paused = services.terms.lock().unwrap().on_sent(term_id, units);
                        continue;
                    }
                }
                paused = now_paused;
            }
            // If a tab switch (term.select) swaps the attach-target sid, re-subscribe to the new PTY and
            // resend the current screen (redraw sequence) to switch the display. Ignore notifications for
            // the same sid (no swap).
            _ = bind_notify.notified() => {
                let next_sid = services
                    .terms
                    .lock()
                    .unwrap()
                    .session_id(term_id)
                    .unwrap_or_default();
                if next_sid.is_empty() || next_sid == bound_sid {
                    continue;
                }
                let Some(next_session) = services.sessions.get(&next_sid).await else {
                    // The swap-target PTY is gone (already closed, etc.). Do not switch; keep the current
                    // state.
                    continue;
                };
                bound_sid = next_sid;
                session = next_session;
                // Align the swap-target PTY to the TermEntry's real size too (so size stays consistent
                // after a tab switch).
                apply_term_size(&session, services, term_id);
                sub = session.subscribe();
                // On tab reopen/switch too, rebuild the new PTY's scrollback: raw ring replay -> current
                // screen.
                let replay = std::mem::take(&mut sub.replay);
                let formatted = session.screen_formatted();
                match send_restore(socket, services, term_id, replay, formatted).await {
                    Ok(p) => paused = p,
                    Err(()) => break,
                }
            }
            incoming = socket.recv() => match incoming {
                // Route input through the sole writer owner PtySession::write_input (never create a
                // second writer).
                Some(Ok(Message::Binary(data))) => {
                    alive = true;
                    if session.write_input(&data).is_err() {
                        break;
                    }
                }
                Some(Ok(Message::Text(text))) => {
                    alive = true;
                    if session.write_input(text.as_bytes()).is_err() {
                        break;
                    }
                }
                Some(Ok(Message::Pong(_))) => alive = true,
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(_)) => {}
                Some(Err(_)) => break,
            },
        }
    }
    // The PTY itself is shared with other subscribers/the poller, so we do not kill it here (unlike the
    // tmux version). The subscribe/receiver are released when sub is dropped. Stopping the PtySession is
    // SessionRegistry::remove's job.
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control::{ConfigView, ControlHub, HEARTBEAT_INTERVAL};
    use crate::pty_host::PtyConfig;
    use crate::session_registry::SessionRegistry;
    use crate::status_poller::StateSnapshot;
    use crate::term_registry::{TermEntry, TermRegistry};
    use portable_pty::CommandBuilder;
    use std::collections::BTreeMap;
    use std::sync::Mutex;
    use std::time::Duration;

    fn empty_snapshot() -> StateSnapshot {
        StateSnapshot {
            sessions: Vec::new(),
            orgs: Vec::new(),
            org_colors: BTreeMap::new(),
        }
    }

    fn cat_cfg() -> PtyConfig {
        let mut cmd = CommandBuilder::new("sh");
        cmd.arg("-c");
        cmd.arg("cat");
        cmd.env("TERM", "xterm-256color");
        PtyConfig::new(cmd)
    }

    /// cat with tty ECHO disabled (stops immediate echo of input so only cat's stdout is the output
    /// source). Used in the scrollback replay test to decide "output has fully drained" deterministically.
    fn noecho_cat_cfg() -> PtyConfig {
        let mut cmd = CommandBuilder::new("sh");
        cmd.arg("-c");
        cmd.arg("stty -echo; cat");
        cmd.env("TERM", "xterm-256color");
        PtyConfig::new(cmd)
    }

    /// Build services holding a term.open'd term and an owned PTY started for that session_id.
    async fn services_with_pty(term_id: &str, session_id: &str, cfg: PtyConfig) -> ControlServices {
        services_with_pty_sized(term_id, session_id, cfg, 80, 24).await
    }

    /// TermEntry-size variant of `services_with_pty` (verifies real-size reflection on attach).
    async fn services_with_pty_sized(
        term_id: &str,
        session_id: &str,
        cfg: PtyConfig,
        cols: u32,
        rows: u32,
    ) -> ControlServices {
        let (refresh, rx) = tokio::sync::mpsc::channel(8);
        drop(rx);
        let sessions = Arc::new(SessionRegistry::new());
        sessions.create(session_id.to_string(), cfg).await.unwrap();
        let terms = Arc::new(Mutex::new(TermRegistry::new()));
        terms
            .lock()
            .unwrap()
            .commit(TermEntry::new(term_id.to_string(), session_id.to_string(), cols, rows));
        ControlServices {
            hub: ControlHub::new(ConfigView::default(), vec![], empty_snapshot()),
            refresh,
            repos: crate::repos::shared_repos(vec![], Default::default()),
            launch_claude: false,
            terms,
            sessions,
            heartbeat: HEARTBEAT_INTERVAL,
            notify_mode: crate::hooks::NotifyMode::Web,
            mac_notify: std::sync::Arc::new(|_| {}),
            config_path: None,
        }
    }

    /// Minimal router wiring attach_owned_term to a real WS without going through build_router (token
    /// verification is out of scope).
    fn router(services: ControlServices) -> axum::Router {
        use axum::extract::{Path, State, WebSocketUpgrade};
        use axum::routing::get;
        axum::Router::new()
            .route(
                "/ws/term/:term_id",
                get(
                    |ws: WebSocketUpgrade,
                     Path(term_id): Path<String>,
                     State(services): State<ControlServices>| async move {
                        ws.on_upgrade(move |socket| attach_owned_term(socket, term_id, services))
                    },
                ),
            )
            .with_state(services)
    }

    async fn serve(services: ControlServices) -> u16 {
        let app = router(services);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        port
    }

    type Ws = tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >;

    async fn connect_term(port: u16, term_id: &str) -> Ws {
        let url = format!("ws://127.0.0.1:{port}/ws/term/{term_id}");
        tokio_tungstenite::connect_async(&url).await.unwrap().0
    }

    /// Read and accumulate until binary containing `needle` arrives (or timeout).
    async fn recv_until(ws: &mut Ws, needle: &str, timeout_ms: u64) -> String {
        use futures_util::StreamExt;
        use tokio_tungstenite::tungstenite::Message as TMsg;
        let mut acc: Vec<u8> = Vec::new();
        let fut = async {
            while !String::from_utf8_lossy(&acc).contains(needle) {
                match ws.next().await {
                    Some(Ok(TMsg::Binary(b))) => acc.extend_from_slice(&b),
                    Some(Ok(_)) => continue,
                    _ => break,
                }
            }
        };
        let _ = tokio::time::timeout(Duration::from_millis(timeout_ms), fut).await;
        String::from_utf8_lossy(&acc).into_owned()
    }

    #[tokio::test]
    async fn input_is_echoed_back_over_ws() {
        use futures_util::SinkExt;
        use tokio_tungstenite::tungstenite::Message as TMsg;
        let services = services_with_pty("t1", "sess-1", cat_cfg()).await;
        let port = serve(services).await;
        let mut ws = connect_term(port, "t1").await;

        ws.send(TMsg::Binary("ping-42\n".into())).await.unwrap();
        let seen = recv_until(&mut ws, "ping-42", 3000).await;
        assert!(seen.contains("ping-42"), "input not echoed to WS: {seen:?}");
    }

    #[tokio::test]
    async fn missing_term_closes_4404() {
        use futures_util::StreamExt;
        use tokio_tungstenite::tungstenite::Message as TMsg;
        // A termId that was not term.open'd gets close(4404) on the first frame.
        let services = services_with_pty("t1", "sess-1", cat_cfg()).await;
        let port = serve(services).await;
        let mut ws = connect_term(port, "nope").await;
        match ws.next().await.expect("frame").expect("ws ok") {
            TMsg::Close(Some(frame)) => assert_eq!(u16::from(frame.code), 4404),
            other => panic!("expected close 4404, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn second_attach_closes_4409() {
        use futures_util::StreamExt;
        use tokio_tungstenite::tungstenite::Message as TMsg;
        let services = services_with_pty("t1", "sess-1", cat_cfg()).await;
        let port = serve(services).await;
        let _first = connect_term(port, "t1").await;
        // Wait until the first attach calls mark_attached.
        tokio::time::sleep(Duration::from_millis(200)).await;
        let mut second = connect_term(port, "t1").await;
        match second.next().await.expect("frame").expect("ws ok") {
            TMsg::Close(Some(frame)) => assert_eq!(u16::from(frame.code), 4409),
            other => panic!("expected close 4409, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn initial_replay_sends_screen_restore_sequence() {
        // Draw characters on the screen beforehand -> on first attach they are restored via the redraw
        // sequence (derived from contents_formatted).
        let services = services_with_pty("t1", "sess-1", cat_cfg()).await;
        let session = services.sessions.get("sess-1").await.unwrap();
        session.write_input(b"HELLO-REPLAY\n").unwrap();
        // Wait until the output is reflected in the vt100 screen.
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(session.screen_contents().contains("HELLO-REPLAY"));

        let port = serve(services).await;
        let mut ws = connect_term(port, "t1").await;
        // The first frame contains the redraw sequence and visible characters arrive (redraw sequence,
        // not raw replay).
        let seen = recv_until(&mut ws, "HELLO-REPLAY", 3000).await;
        assert!(
            seen.contains("HELLO-REPLAY"),
            "initial screen restore missing: {seen:?}"
        );
    }

    #[tokio::test]
    async fn initial_replay_restores_scrollback_history() {
        // Past output that scrolled off the current screen (scrollback) arrives via raw ring replay on
        // first attach. The vt100 parser keeps 0 scrollback rows, so screen_formatted() only shows the
        // current screen; without also sending the raw replay, scrollback would be empty after a restart
        // or tab reopen and you could not scroll.
        //
        // Disable tty ECHO so only cat's stdout is the output source, and then wait until "the ring stops
        // growing" to capture cat's drain completion deterministically. Attaching without waiting for
        // this lets cat's delayed stdout arrive as live after subscribe, so the marker could sneak in
        // even without the raw replay and produce a false negative.
        let services = services_with_pty("t1", "sess-1", noecho_cat_cfg()).await;
        let session = services.sessions.get("sess-1").await.unwrap();
        // Draw a unique marker first, then stream over 24 lines to push it off the current screen.
        session.write_input(b"SCROLLBACK-MARKER\n").unwrap();
        for i in 0..60 {
            session
                .write_input(format!("filler-{i}\n").as_bytes())
                .unwrap();
        }
        // Wait until the ring contains filler-59 and does not grow for one polling interval (= cat has
        // fully drained and no more live output follows). Peek at the ring snapshot via subscribe().replay.
        let mut prev_len = 0usize;
        for _ in 0..300 {
            let snap = session.subscribe().replay;
            let s = String::from_utf8_lossy(&snap);
            if s.contains("filler-59") && snap.len() == prev_len {
                break;
            }
            prev_len = snap.len();
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(
            session.screen_contents().contains("filler-59"),
            "output not flushed: last line not on screen"
        );
        assert!(
            !session.screen_contents().contains("SCROLLBACK-MARKER"),
            "marker must have scrolled off current screen"
        );
        // The current screen's redraw sequence alone has no marker (= unrecoverable without the raw
        // replay).
        let formatted = String::from_utf8_lossy(&session.screen_formatted()).into_owned();
        assert!(
            !formatted.contains("SCROLLBACK-MARKER"),
            "formatted screen unexpectedly contains scrolled-off marker: {formatted:?}"
        );

        let port = serve(services).await;
        let mut ws = connect_term(port, "t1").await;
        let seen = recv_until(&mut ws, "SCROLLBACK-MARKER", 3000).await;
        assert!(
            seen.contains("SCROLLBACK-MARKER"),
            "scrollback history not replayed on attach: {seen:?}"
        );
    }

    #[tokio::test]
    async fn resize_owned_term_updates_pty_screen_size() {
        let services = services_with_pty("t1", "sess-1", cat_cfg()).await;
        let session = services.sessions.get("sess-1").await.unwrap();
        assert_eq!(session.screen_size(), (24, 80));
        resize_owned_term(&services, "t1", 100, 40).await;
        assert_eq!(session.screen_size(), (40, 100));
        // An unregistered termId is a no-op (does not panic).
        resize_owned_term(&services, "nope", 10, 10).await;
    }

    /// Deterministically verify the core of Lagged recovery (the redraw sequence resent on re-subscribe
    /// restores the latest screen). A real broadcast's Lagged firing is unstable, depending on chunk
    /// granularity and reader timing, so this focuses on the correctness of the recovery payload (the
    /// `screen_formatted()` sent by `run_bridge`'s Lagged and resume branches). The property that the
    /// live path survives crossing a Lagged reduces to the correctness of this payload.
    #[tokio::test]
    async fn recovery_redraw_reconstructs_current_screen() {
        let session = PtySession::spawn(cat_cfg()).unwrap();
        // Draw multiple lines + decoration (underline SGR) on the screen, then check they are restored
        // via the redraw sequence.
        session.write_input(b"line-one\n").unwrap();
        session.write_input(b"\x1b[4mUNDERLINED-FINAL\x1b[0m\n").unwrap();
        for _ in 0..100 {
            if session.screen_contents().contains("UNDERLINED-FINAL") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(session.screen_contents().contains("UNDERLINED-FINAL"));

        // Recovery procedure: take the current screen's redraw sequence and feed it to a fresh vt100
        // parser to reproduce the current screen.
        let formatted = session.screen_formatted();
        assert!(!formatted.is_empty(), "redraw sequence must be non-empty");
        let mut replay = vt100::Parser::new(24, 80, 0);
        replay.process(&formatted);
        assert!(
            replay.screen().contents().contains("UNDERLINED-FINAL"),
            "recovered screen missing final content: {:?}",
            replay.screen().contents()
        );
        // Unlike the raw replay, the start is not corrupted mid-escape-sequence = the cursor position
        // also matches.
        assert_eq!(
            replay.screen().cursor_position(),
            session.cursor_position(),
            "redraw must restore cursor position"
        );
    }

    /// Attaching an owned term.open with no windowId (unbound = empty session_id) does not close
    /// immediately; after a term.select-equivalent bind (rebind_session), it connects to the PTY and echo
    /// flows.
    #[tokio::test]
    async fn attach_unbound_then_bind_streams_pty() {
        use futures_util::SinkExt;
        use tokio_tungstenite::tungstenite::Message as TMsg;
        // Register an unbound term (session_id=""). The PTY exists at sess-1 but is unbound.
        let services = services_with_pty("t1", "", cat_cfg()).await;
        services
            .sessions
            .create("sess-1".to_string(), cat_cfg())
            .await
            .unwrap();
        let terms = services.terms.clone();
        let port = serve(services).await;
        let mut ws = connect_term(port, "t1").await;

        // Unbound right after attach. Not closed even after a short wait (no 4404/1011 arrives).
        tokio::time::sleep(Duration::from_millis(200)).await;
        // Bind via a control-equivalent term.select.
        assert!(terms.lock().unwrap().rebind_session("t1", "sess-1"));

        // After binding, input echo flows (= connected to the real PTY).
        ws.send(TMsg::Binary("bound-echo\n".into())).await.unwrap();
        let seen = recv_until(&mut ws, "bound-echo", 3000).await;
        assert!(seen.contains("bound-echo"), "bind 後に PTY へ繋がらない: {seen:?}");
    }

    /// Owned tab switch: rebinding to a different sid during attach re-subscribes to the new PTY and the
    /// new PTY's input echo flows (swapping one PTY = one window).
    #[tokio::test]
    async fn rebind_reattaches_to_new_pty() {
        use futures_util::SinkExt;
        use tokio_tungstenite::tungstenite::Message as TMsg;
        let services = services_with_pty("t1", "sess-1", cat_cfg()).await;
        services
            .sessions
            .create("sess-2".to_string(), cat_cfg())
            .await
            .unwrap();
        let terms = services.terms.clone();
        let port = serve(services).await;
        let mut ws = connect_term(port, "t1").await;

        // Initially connected to sess-1.
        ws.send(TMsg::Binary("on-one\n".into())).await.unwrap();
        assert!(recv_until(&mut ws, "on-one", 3000).await.contains("on-one"));

        // Swap to sess-2 -> run_bridge re-subscribes via bind_notify.
        assert!(terms.lock().unwrap().rebind_session("t1", "sess-2"));
        tokio::time::sleep(Duration::from_millis(150)).await;

        // Subsequent input is echoed by sess-2 (a different PTY). Both PTYs are `cat` so the content
        // matches, but the new marker arriving = confirmation that we stay bidirectionally connected to
        // the PTY after the switch.
        ws.send(TMsg::Binary("on-two\n".into())).await.unwrap();
        assert!(recv_until(&mut ws, "on-two", 3000).await.contains("on-two"));
    }

    /// Attaching a term with a TermEntry real size (120x40) resizes the PTY from its startup 80x24 to the
    /// TermEntry size (no resize message needed).
    #[tokio::test]
    async fn attach_resizes_pty_to_term_entry_size() {
        let services = services_with_pty_sized("t1", "sess-1", cat_cfg(), 120, 40).await;
        let session = services.sessions.get("sess-1").await.unwrap();
        assert_eq!(session.screen_size(), (24, 80));
        let port = serve(services).await;
        let mut _ws = connect_term(port, "t1").await;
        for _ in 0..100 {
            if session.screen_size() == (40, 120) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(
            session.screen_size(),
            (40, 120),
            "attach で PTY が TermEntry サイズ(120x40)へ resize されない"
        );
    }

    /// Attach an unbound term -> after binding via rebind_session, the bind-target PTY is resized to the
    /// TermEntry size.
    #[tokio::test]
    async fn bind_resizes_new_pty_to_term_entry_size() {
        let services = services_with_pty_sized("t1", "", cat_cfg(), 120, 40).await;
        services
            .sessions
            .create("sess-1".to_string(), cat_cfg())
            .await
            .unwrap();
        let session = services.sessions.get("sess-1").await.unwrap();
        assert_eq!(session.screen_size(), (24, 80));
        let terms = services.terms.clone();
        let port = serve(services).await;
        let mut _ws = connect_term(port, "t1").await;
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(terms.lock().unwrap().rebind_session("t1", "sess-1"));
        for _ in 0..100 {
            if session.screen_size() == (40, 120) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(
            session.screen_size(),
            (40, 120),
            "bind 後に PTY が TermEntry サイズ(120x40)へ resize されない"
        );
    }

    /// Swapping to a different sid during attach also aligns the swap-target PTY to the TermEntry size
    /// (size stays consistent after a tab switch).
    #[tokio::test]
    async fn rebind_resizes_switched_pty_to_term_entry_size() {
        let services = services_with_pty_sized("t1", "sess-1", cat_cfg(), 120, 40).await;
        services
            .sessions
            .create("sess-2".to_string(), cat_cfg())
            .await
            .unwrap();
        let session2 = services.sessions.get("sess-2").await.unwrap();
        assert_eq!(session2.screen_size(), (24, 80));
        let terms = services.terms.clone();
        let port = serve(services).await;
        let mut _ws = connect_term(port, "t1").await;
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(terms.lock().unwrap().rebind_session("t1", "sess-2"));
        for _ in 0..100 {
            if session2.screen_size() == (40, 120) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(
            session2.screen_size(),
            (40, 120),
            "張り替え先 PTY が TermEntry サイズ(120x40)へ resize されない"
        );
    }
}
