//! Watches aggregate scrollback memory across sessions and warns when it enters the danger zone.
//!
//! Session history is retained without eviction (see [`crate::pty_host`]) so the very first prompt
//! always stays reachable; the trade-off is unbounded growth. Rather than silently truncating history,
//! this raises a NOTIFICATION once the total crosses [`DANGER_BYTES`] and withdraws it once usage falls
//! back below [`CLEAR_BYTES`] (hysteresis avoids flapping around the threshold). The decision is the
//! pure [`evaluate_pressure`] guarded by unit tests; the spawned loop is a thin sampler.

use std::sync::Arc;
use std::time::Duration;

use crate::control::ControlHub;
use crate::session_registry::SessionRegistry;

/// Aggregate scrollback bytes across all sessions at which the danger-zone warning is raised.
pub const DANGER_BYTES: usize = 512 * 1024 * 1024;

/// Lower watermark (below [`DANGER_BYTES`]) at which the warning is withdrawn. The gap is hysteresis so
/// the notification does not flap when usage hovers around the threshold.
pub const CLEAR_BYTES: usize = 384 * 1024 * 1024;

/// How often aggregate usage is sampled.
pub const MONITOR_INTERVAL: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PressureAction {
    Idle,
    Warn,
    Withdraw,
}

/// Pure transition: given the current total, the thresholds, and whether a warning is already active,
/// decide the action and the next latch. `Warn` fires only on the upward crossing of `danger`;
/// `Withdraw` only on the downward crossing below `clear`.
pub fn evaluate_pressure(
    total_bytes: usize,
    danger: usize,
    clear: usize,
    warned: bool,
) -> (PressureAction, bool) {
    if !warned && total_bytes >= danger {
        (PressureAction::Warn, true)
    } else if warned && total_bytes < clear {
        (PressureAction::Withdraw, false)
    } else {
        (PressureAction::Idle, warned)
    }
}

async fn total_scrollback_bytes(registry: &SessionRegistry) -> usize {
    registry
        .entries()
        .await
        .iter()
        .map(|(_, session, _)| session.scrollback_len())
        .sum()
}

/// Spawns the periodic monitor. It holds only `Arc` clones, so it is fine to leave running for the
/// process lifetime; it also exits once the registry begins shutting down.
pub fn spawn_scrollback_monitor(
    registry: Arc<SessionRegistry>,
    hub: Arc<ControlHub>,
    interval: Duration,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        let mut warned = false;
        loop {
            ticker.tick().await;
            if registry.is_shutting_down() {
                break;
            }
            let total = total_scrollback_bytes(&registry).await;
            let (action, next) = evaluate_pressure(total, DANGER_BYTES, CLEAR_BYTES, warned);
            warned = next;
            match action {
                PressureAction::Warn => hub.record_scrollback_pressure(total, crate::now_ms()),
                PressureAction::Withdraw => hub.withdraw_scrollback_pressure(),
                PressureAction::Idle => {}
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const DANGER: usize = 100;
    const CLEAR: usize = 80;

    #[test]
    fn warns_on_upward_crossing_then_latches() {
        let (action, warned) = evaluate_pressure(100, DANGER, CLEAR, false);
        assert_eq!(action, PressureAction::Warn);
        assert!(warned);
        // Already warned and still above clear: no repeat notification.
        assert_eq!(
            evaluate_pressure(120, DANGER, CLEAR, true),
            (PressureAction::Idle, true)
        );
    }

    #[test]
    fn stays_idle_below_danger_when_not_warned() {
        assert_eq!(
            evaluate_pressure(99, DANGER, CLEAR, false),
            (PressureAction::Idle, false)
        );
    }

    #[test]
    fn hysteresis_holds_the_warning_between_clear_and_danger() {
        // Between clear and danger while already warned: keep warning, do not withdraw.
        assert_eq!(
            evaluate_pressure(90, DANGER, CLEAR, true),
            (PressureAction::Idle, true)
        );
    }

    #[test]
    fn withdraws_only_after_dropping_below_clear() {
        let (action, warned) = evaluate_pressure(79, DANGER, CLEAR, true);
        assert_eq!(action, PressureAction::Withdraw);
        assert!(!warned);
    }
}
