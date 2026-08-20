//! Switches the **screen source** for session state detection from tmux `capture-pane` to
//! pty_host's headless vt100-reconstructed screen (tmux removal, step ③).
//!
//! The detection logic itself (priority order wizard > running > bg_agent > no_claude > idle)
//! **reuses as-is** the pure function [`zashiki_core::session_state::detect_state`]. This only
//! swaps the visible-screen text that the tmux poller obtained via `capturePane(paneId)` for
//! [`PtySession::screen_contents`] (raw PTY output reconstructed by vt100). Not yet wired into
//! the poller loop (periodic execution, jsonl fallback merge); non-destructive. The behavioral
//! source of truth is the `tests` at the end of the file.

use crate::pty_host::PtySession;
use zashiki_core::session_state::{detect_state, DetectStateOptions, CockpitTerminalState};

/// Detect a session's current state from the headless reconstructed screen (vt100).
/// This replaces tmux `capture-pane` → `detectState` (only the screen source changes; detection stays the core pure function).
pub fn poll_state(session: &PtySession, opts: &DetectStateOptions) -> CockpitTerminalState {
    detect_state(&session.screen_contents(), opts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty_host::PtyConfig;
    use portable_pty::CommandBuilder;
    use std::time::Duration;

    fn sh(script: &str) -> PtyConfig {
        let mut cmd = CommandBuilder::new("sh");
        cmd.arg("-c");
        cmd.arg(script);
        cmd.env("TERM", "xterm-256color");
        PtyConfig::new(cmd)
    }

    fn opts(has_claude: bool) -> DetectStateOptions<'static> {
        DetectStateOptions {
            has_claude,
            run_marker: None,
            bg_agent_marker: None,
        }
    }

    async fn wait_screen_contains(session: &PtySession, needle: &str, timeout_ms: u64) {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
        while !session.screen_contents().contains(needle) {
            if tokio::time::Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// If the running spinner text (default run marker "(esc to interrupt") is visible near the bottom, it is Running.
    #[cfg(unix)]
    #[tokio::test]
    async fn running_marker_on_screen_is_detected_as_running() {
        let session =
            PtySession::spawn(sh("printf 'working (esc to interrupt)\\n'; sleep 5")).unwrap();
        wait_screen_contains(&session, "esc to interrupt", 2000).await;
        assert_eq!(poll_state(&session, &opts(true)), CockpitTerminalState::Running);
        session.kill();
    }

    /// A cursor line with `❯` plus two or more numbered options means waiting for input (wizard).
    #[cfg(unix)]
    #[tokio::test]
    async fn numbered_wizard_screen_is_detected_as_waiting_input() {
        let session =
            PtySession::spawn(sh("printf '\u{276f} 1. yes\\n  2. no\\n'; sleep 5")).unwrap();
        wait_screen_contains(&session, "2. no", 2000).await;
        assert_eq!(
            poll_state(&session, &opts(true)),
            CockpitTerminalState::WaitingInput
        );
        session.kill();
    }

    /// A plain screen with no cues is Idle when claude is present and NoClaude when absent.
    #[cfg(unix)]
    #[tokio::test]
    async fn plain_screen_is_idle_with_claude_and_no_claude_without() {
        let session = PtySession::spawn(sh("printf 'ready> \\n'; sleep 5")).unwrap();
        wait_screen_contains(&session, "ready>", 2000).await;
        assert_eq!(poll_state(&session, &opts(true)), CockpitTerminalState::Idle);
        assert_eq!(poll_state(&session, &opts(false)), CockpitTerminalState::NoClaude);
        session.kill();
    }
}
