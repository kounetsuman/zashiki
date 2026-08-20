//! Pure functions for client-side flow control (watermark scheme).
//!
//! For the server→client pty stream, the client (xterm.js) reports completed
//! writes via `term.ack`; the server pauses the pty once the unacked amount
//! exceeds the high watermark and resumes once it drains below the low watermark
//! (so that rendering backpressure does not cause an OOM). The amount is measured
//! in UTF-16 code units, matching on both ends.

/// pause/resume watermarks (hysteresis: pause at high, resume at or below low).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FlowWatermarks {
    /// Pause once the unacked amount exceeds this.
    pub high: u64,
    /// Resume once the unacked amount drains to at or below this while paused.
    pub low: u64,
}

/// The amount sent but not yet acked, plus the pause state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FlowState {
    pub unacked: u64,
    pub paused: bool,
}

/// Initial state (0 unacked, not paused).
pub const INITIAL_FLOW_STATE: FlowState = FlowState {
    unacked: 0,
    paused: false,
};

/// Server side: state transition after sending a chunk. Pauses when the high
/// watermark is exceeded.
pub fn on_bytes_sent(state: FlowState, bytes: u64, watermarks: FlowWatermarks) -> FlowState {
    let unacked = state.unacked + bytes;
    FlowState {
        unacked,
        paused: state.paused || unacked > watermarks.high,
    }
}

/// Server side: state transition after receiving an ACK. Resumes once drained to
/// the low watermark (unacked never goes below 0).
pub fn on_bytes_acked(state: FlowState, bytes: u64, watermarks: FlowWatermarks) -> FlowState {
    let unacked = state.unacked.saturating_sub(bytes);
    FlowState {
        unacked,
        paused: state.paused && unacked > watermarks.low,
    }
}

/// Client-side ACK accumulation result. Send `term.ack` when `ack_bytes` is nonzero.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Tally {
    pub pending: u64,
    pub ack_bytes: u64,
}

/// Client side: accumulate completed writes and, once the threshold is reached,
/// return the amount to ACK and reset.
pub fn tally_written_bytes(pending: u64, bytes: u64, threshold: u64) -> Tally {
    let total = pending + bytes;
    if total >= threshold {
        Tally {
            pending: 0,
            ack_bytes: total,
        }
    } else {
        Tally {
            pending: total,
            ack_bytes: 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: FlowWatermarks = FlowWatermarks { high: 100, low: 30 };

    fn state(unacked: u64, paused: bool) -> FlowState {
        FlowState { unacked, paused }
    }

    #[test]
    fn no_pause_at_or_below_high() {
        let s = on_bytes_sent(INITIAL_FLOW_STATE, 50, W);
        assert_eq!(s, state(50, false));
        // Exactly high does not pause yet
        let s = on_bytes_sent(s, 50, W);
        assert_eq!(s, state(100, false));
    }

    #[test]
    fn pause_above_high() {
        let s = on_bytes_sent(INITIAL_FLOW_STATE, 101, W);
        assert!(s.paused);
    }

    #[test]
    fn resume_only_at_or_below_low() {
        let s = on_bytes_sent(INITIAL_FLOW_STATE, 150, W);
        assert!(s.paused);
        let s = on_bytes_acked(s, 50, W); // unacked=100 > low=30 → still paused
        assert_eq!(s, state(100, true));
        let s = on_bytes_acked(s, 70, W); // unacked=30 <= low → resumes
        assert_eq!(s, state(30, false));
    }

    #[test]
    fn re_pause_after_resume_hysteresis() {
        let s = on_bytes_sent(INITIAL_FLOW_STATE, 150, W);
        let s = on_bytes_acked(s, 150, W);
        assert_eq!(s, state(0, false));
        let s = on_bytes_sent(s, 101, W);
        assert!(s.paused);
    }

    #[test]
    fn over_ack_does_not_go_below_zero() {
        let s = on_bytes_acked(on_bytes_sent(INITIAL_FLOW_STATE, 10, W), 9999, W);
        assert_eq!(s.unacked, 0);
    }

    #[test]
    fn ack_while_not_paused_does_not_worsen() {
        let s = on_bytes_acked(on_bytes_sent(INITIAL_FLOW_STATE, 50, W), 20, W);
        assert_eq!(s, state(30, false));
    }

    #[test]
    fn tally_below_threshold_accumulates() {
        assert_eq!(
            tally_written_bytes(0, 10, 64),
            Tally {
                pending: 10,
                ack_bytes: 0
            }
        );
        assert_eq!(
            tally_written_bytes(10, 20, 64),
            Tally {
                pending: 30,
                ack_bytes: 0
            }
        );
    }

    #[test]
    fn tally_at_threshold_acks_and_resets() {
        assert_eq!(
            tally_written_bytes(60, 10, 64),
            Tally {
                pending: 0,
                ack_bytes: 70
            }
        );
        assert_eq!(
            tally_written_bytes(0, 64, 64),
            Tally {
                pending: 0,
                ack_bytes: 64
            }
        );
    }

    #[test]
    fn tally_huge_chunk_acks_immediately() {
        assert_eq!(
            tally_written_bytes(0, 1_000_000, 64),
            Tally {
                pending: 0,
                ack_bytes: 1_000_000
            }
        );
    }
}
