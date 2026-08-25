//! Registry of terminal views (terms). Registers on term.open, removes on term.close, and holds
//! term.ack flow state.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use tokio::sync::Notify;
use zashiki_core::flow::{
    on_bytes_acked, on_bytes_sent, FlowState, FlowWatermarks, INITIAL_FLOW_STATE,
};

/// term.ack-based flow control watermarks.
pub const ACK_HIGH_WATER_MARK: u64 = 512 * 1024;
pub const ACK_LOW_WATER_MARK: u64 = 128 * 1024;
const ACK_WATERMARKS: FlowWatermarks = FlowWatermarks {
    high: ACK_HIGH_WATER_MARK,
    low: ACK_LOW_WATER_MARK,
};

/// Per-term observation counters (for archiving at teardown; regression monitoring).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct TermDiagnostics {
    pub max_buffered_amount: u64,
    pub pause_count: u32,
    pub resume_count: u32,
    pub ack_pause_count: u32,
    pub ack_resume_count: u32,
}

/// State of one term. The part confirmed before `/ws/term` attach + the attached flag.
#[derive(Debug, Clone)]
pub struct TermEntry {
    pub term_id: String,
    /// The attach-target session id (for owned, cockpitTerminalId=UUID sid). `attach_owned_term` uses this to
    /// look up the PTY. If term.open had no cockpitTerminalId, it is registered with an empty string (unbound) and
    /// later bound to a real sid by term.select (`rebind_session`).
    pub session_id: String,
    pub cols: u32,
    pub rows: u32,
    /// Whether a PTY is wired up on `/ws/term` (rejects double attach).
    pub attached: bool,
    pub ack_enabled: bool,
    pub ack_flow: FlowState,
    pub released: bool,
    pub diagnostics: TermDiagnostics,
    /// On an ack-driven pause->resume transition, wakes the `/ws/term` sender task that paused and stopped
    /// out_rx (signaled from the control task's apply_ack; term_attach awaits and resumes).
    resume_notify: Arc<Notify>,
    /// owned: fires when session_id is bound / swapped (wakes the attach that waits while unbound and the
    /// run_bridge that re-subscribes for live).
    bind_notify: Arc<Notify>,
}

impl TermEntry {
    pub fn new(term_id: String, session_id: String, cols: u32, rows: u32) -> Self {
        Self {
            term_id,
            session_id,
            cols,
            rows,
            attached: false,
            ack_enabled: false,
            ack_flow: INITIAL_FLOW_STATE,
            released: false,
            diagnostics: TermDiagnostics::default(),
            resume_notify: Arc::new(Notify::new()),
            bind_notify: Arc::new(Notify::new()),
        }
    }
}

/// Result of a `/ws/term` attach reservation.
pub enum AttachOutcome {
    /// A termId that was not term.open'd (close 4404).
    Missing,
    /// A PTY is already wired up (close 4409).
    AlreadyAttached,
    /// New attach allowed (the session and size to wire the PTY to).
    Ready {
        session_id: String,
        cols: u16,
        rows: u16,
    },
}

/// Registry of all terms. `opening` provides concurrent mutual exclusion for term.open (a synchronous
/// reservation taken before any await).
#[derive(Default)]
pub struct TermRegistry {
    entries: HashMap<String, TermEntry>,
    opening: HashSet<String>,
}

impl TermRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Synchronous reservation for concurrent open. false if already registered or an open is in progress
    /// (term_exists); true reserves it. Call this before any await (a synchronous reservation).
    pub fn try_reserve(&mut self, term_id: &str) -> bool {
        if self.entries.contains_key(term_id) || self.opening.contains(term_id) {
            return false;
        }
        self.opening.insert(term_id.to_string());
        true
    }

    /// Cancel the reservation (in the finally of a failed open).
    pub fn cancel_reserve(&mut self, term_id: &str) {
        self.opening.remove(term_id);
    }

    /// Commit the reservation and register the entry (opening -> entries).
    pub fn commit(&mut self, entry: TermEntry) {
        self.opening.remove(&entry.term_id);
        self.entries.insert(entry.term_id.clone(), entry);
    }

    /// The session_id for term.select (None if unregistered).
    pub fn session_id(&self, term_id: &str) -> Option<String> {
        self.entries.get(term_id).map(|e| e.session_id.clone())
    }

    /// The confirmed terminal size `(cols, rows)` (None if unregistered). cols/rows are already clamped
    /// and fit in u16. Used to resize the owned PTY to the real size on attach / bind.
    pub fn term_size(&self, term_id: &str) -> Option<(u16, u16)> {
        self.entries
            .get(term_id)
            .map(|e| (e.cols as u16, e.rows as u16))
    }

    /// owned term.select: bind / swap an existing term's attach target to the switch-target cockpitTerminalId
    /// (UUID sid) (since one PTY = one window, this swaps the PTY). Wakes
    /// the attach waiting while unbound and the run_bridge that re-subscribes for live. false if
    /// unregistered. No notification if session_id is unchanged.
    pub fn rebind_session(&mut self, term_id: &str, session_id: &str) -> bool {
        match self.entries.get_mut(term_id) {
            Some(entry) => {
                if entry.session_id != session_id {
                    entry.session_id = session_id.to_string();
                    entry.bind_notify.notify_waiters();
                }
                true
            }
            None => false,
        }
    }

    /// The notification handle used by owned attach / run_bridge for bind-waiting and re-subscribing
    /// (None if unregistered).
    pub fn bind_notify(&self, term_id: &str) -> Option<Arc<Notify>> {
        self.entries.get(term_id).map(|e| e.bind_notify.clone())
    }

    /// Reserve a `/ws/term` attach. Missing if unregistered, AlreadyAttached if already attached;
    /// otherwise set attached=true and return Ready (the PTY-target session/size). cols/rows are already
    /// clamped (with a lower bound) and the protocol max is 10000, so they fit in u16.
    pub fn try_mark_attached(&mut self, term_id: &str) -> AttachOutcome {
        match self.entries.get_mut(term_id) {
            None => AttachOutcome::Missing,
            Some(entry) if entry.attached => AttachOutcome::AlreadyAttached,
            Some(entry) => {
                entry.attached = true;
                AttachOutcome::Ready {
                    session_id: entry.session_id.clone(),
                    cols: entry.cols as u16,
                    rows: entry.rows as u16,
                }
            }
        }
    }

    /// Update the terminal size (false if unregistered). Propagating the resize to the pty happens after
    /// attach (a later increment).
    pub fn set_size(&mut self, term_id: &str, cols: u32, rows: u32) -> bool {
        match self.entries.get_mut(term_id) {
            Some(entry) => {
                entry.cols = cols;
                entry.rows = rows;
                true
            }
            None => false,
        }
    }

    /// Detach for teardown (idempotent: None if already gone = double-free guard). Marked released once
    /// detached.
    pub fn take_for_teardown(&mut self, term_id: &str) -> Option<TermEntry> {
        let mut entry = self.entries.remove(term_id)?;
        entry.released = true;
        Some(entry)
    }

    /// term.ack: unregistered is a normal no-op (false). If present, set ack_enabled=true, update flow,
    /// increment resume (true). On a pause->resume after draining to the low watermark, wake the
    /// term_attach that paused and stopped sending.
    pub fn apply_ack(&mut self, term_id: &str, bytes: u64) -> bool {
        let Some(entry) = self.entries.get_mut(term_id) else {
            return false;
        };
        entry.ack_enabled = true;
        let was_paused = entry.ack_flow.paused;
        entry.ack_flow = on_bytes_acked(entry.ack_flow, bytes, ACK_WATERMARKS);
        if was_paused && !entry.ack_flow.paused {
            entry.diagnostics.ack_resume_count += 1;
            entry.resume_notify.notify_one();
        }
        true
    }

    /// Flow update after sending PTY output (only when ack is enabled). Transitions to pause when the
    /// high watermark is exceeded and increments
    /// ack_pause_count. Return value = whether to pause after sending (false if ack is disabled or
    /// unregistered = a client that sends no ACK uses natural backpressure only, as before). `units` is
    /// UTF-16 code units.
    pub fn on_sent(&mut self, term_id: &str, units: u64) -> bool {
        let Some(entry) = self.entries.get_mut(term_id) else {
            return false;
        };
        if !entry.ack_enabled {
            return false;
        }
        let was_paused = entry.ack_flow.paused;
        entry.ack_flow = on_bytes_sent(entry.ack_flow, units, ACK_WATERMARKS);
        if !was_paused && entry.ack_flow.paused {
            entry.diagnostics.ack_pause_count += 1;
        }
        entry.ack_flow.paused
    }

    /// Whether currently paused (the term_attach woken by a resume notification re-reads shared state).
    /// false if unregistered.
    pub fn is_paused(&self, term_id: &str) -> bool {
        self.entries
            .get(term_id)
            .map(|e| e.ack_flow.paused)
            .unwrap_or(false)
    }

    /// The resume notification handle that term_attach acquires on attach (None if unregistered).
    pub fn resume_notify(&self, term_id: &str) -> Option<Arc<Notify>> {
        self.entries.get(term_id).map(|e| e.resume_notify.clone())
    }

    #[cfg(test)]
    pub fn get(&self, term_id: &str) -> Option<&TermEntry> {
        self.entries.get(term_id)
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registered(reg: &mut TermRegistry, term_id: &str) {
        assert!(reg.try_reserve(term_id));
        reg.commit(TermEntry::new(
            term_id.to_string(),
            "$1".to_string(),
            80,
            24,
        ));
    }

    #[test]
    fn reserve_excludes_concurrent_and_existing() {
        let mut reg = TermRegistry::new();
        assert!(reg.try_reserve("t1"));
        // Double reservation not allowed while an open is in progress (term_exists).
        assert!(!reg.try_reserve("t1"));
        reg.commit(TermEntry::new("t1".to_string(), "$1".to_string(), 80, 24));
        // Already registered is also not allowed.
        assert!(!reg.try_reserve("t1"));
    }

    #[test]
    fn cancel_reserve_allows_retry() {
        let mut reg = TermRegistry::new();
        assert!(reg.try_reserve("t1"));
        reg.cancel_reserve("t1");
        assert!(reg.try_reserve("t1"));
    }

    #[test]
    fn mark_attached_reports_missing_ready_then_already() {
        let mut reg = TermRegistry::new();
        assert!(matches!(
            reg.try_mark_attached("t1"),
            AttachOutcome::Missing
        ));
        registered(&mut reg, "t1");
        match reg.try_mark_attached("t1") {
            AttachOutcome::Ready {
                session_id,
                cols,
                rows,
            } => {
                assert_eq!(session_id, "$1");
                assert_eq!((cols, rows), (80, 24));
            }
            _ => panic!("expected Ready"),
        }
        // The second time is already attached.
        assert!(matches!(
            reg.try_mark_attached("t1"),
            AttachOutcome::AlreadyAttached
        ));
    }

    #[test]
    fn teardown_is_idempotent() {
        let mut reg = TermRegistry::new();
        registered(&mut reg, "t1");
        let entry = reg.take_for_teardown("t1").expect("first teardown");
        assert!(entry.released);
        assert!(reg.take_for_teardown("t1").is_none());
        assert!(reg.is_empty());
    }

    #[test]
    fn set_size_updates_only_existing() {
        let mut reg = TermRegistry::new();
        registered(&mut reg, "t1");
        assert!(reg.set_size("t1", 120, 40));
        assert_eq!(
            (reg.get("t1").unwrap().cols, reg.get("t1").unwrap().rows),
            (120, 40)
        );
        assert!(!reg.set_size("missing", 10, 10));
    }

    #[test]
    fn ack_absent_is_noop_and_present_updates_flow() {
        let mut reg = TermRegistry::new();
        // Unregistered (an ack for an already-closed term) is a normal no-op.
        assert!(!reg.apply_ack("missing", 100));

        registered(&mut reg, "t1");
        assert!(reg.apply_ack("t1", 4096));
        let entry = reg.get("t1").unwrap();
        assert!(entry.ack_enabled);
        assert_eq!(entry.ack_flow.unacked, 0); // ack decreases unacked (stays saturated at 0 before sending)
    }

    #[test]
    fn ack_resume_counts_transition_from_paused() {
        let mut reg = TermRegistry::new();
        registered(&mut reg, "t1");
        // Pseudo-set paused / unacked to the high watermark (equivalent to having sent).
        {
            let e = reg.entries.get_mut("t1").unwrap();
            e.ack_flow = FlowState {
                unacked: ACK_HIGH_WATER_MARK + 1,
                paused: true,
            };
        }
        // ack down to the low watermark or below -> increment on the resume transition.
        reg.apply_ack("t1", ACK_HIGH_WATER_MARK + 1);
        let entry = reg.get("t1").unwrap();
        assert!(!entry.ack_flow.paused);
        assert_eq!(entry.diagnostics.ack_resume_count, 1);
    }

    #[test]
    fn on_sent_is_noop_until_ack_enabled() {
        let mut reg = TermRegistry::new();
        registered(&mut reg, "t1");
        // A client that sends no ACK (ack_enabled=false) does not pause even over the high watermark
        // (natural backpressure only).
        assert!(!reg.on_sent("t1", ACK_HIGH_WATER_MARK + 1));
        assert!(!reg.is_paused("t1"));
        assert_eq!(reg.get("t1").unwrap().diagnostics.ack_pause_count, 0);
        // Unregistered is also a no-op.
        assert!(!reg.on_sent("missing", 999));
    }

    #[test]
    fn on_sent_pauses_over_high_watermark_and_counts() {
        let mut reg = TermRegistry::new();
        registered(&mut reg, "t1");
        reg.apply_ack("t1", 0); // Enable ACK-based pause via term.ack(0).
        // Does not pause up to the low watermark.
        assert!(!reg.on_sent("t1", ACK_LOW_WATER_MARK));
        // Over the high watermark -> pause transition + increment.
        assert!(reg.on_sent("t1", ACK_HIGH_WATER_MARK));
        assert!(reg.is_paused("t1"));
        assert_eq!(reg.get("t1").unwrap().diagnostics.ack_pause_count, 1);
    }

    #[tokio::test]
    async fn apply_ack_resume_wakes_paused_sender() {
        let mut reg = TermRegistry::new();
        registered(&mut reg, "t1");
        reg.apply_ack("t1", 0); // Enable ACK.
        {
            let e = reg.entries.get_mut("t1").unwrap();
            e.ack_flow = FlowState {
                unacked: ACK_HIGH_WATER_MARK + 1,
                paused: true,
            };
        }
        // Equivalent to the resume handle term_attach acquires on attach.
        let notify = reg.resume_notify("t1").unwrap();
        // ack down to the low watermark or below -> resume transition -> notify_one.
        reg.apply_ack("t1", ACK_HIGH_WATER_MARK + 1);
        assert!(!reg.is_paused("t1"));
        // Already notify_one'd, so it completes immediately via the permit even with no waiter that has
        // awaited yet.
        tokio::time::timeout(std::time::Duration::from_secs(1), notify.notified())
            .await
            .expect("resume must wake the paused sender");
    }

    #[tokio::test]
    async fn pause_resume_cycle_never_sticks() {
        // Verify it never gets stuck paused: pause over the high watermark -> full ack always resumes
        // (notification + is_paused false) -> resending pauses again (sawtooth). Since the client's ack
        // threshold (64K) < low (128K), even with a fractional hold-back unacked always drops below low
        // and never lingers in a band from which resume is impossible.
        let mut reg = TermRegistry::new();
        registered(&mut reg, "t1");
        reg.apply_ack("t1", 0); // Enable ACK.
        let notify = reg.resume_notify("t1").unwrap();

        assert!(reg.on_sent("t1", ACK_HIGH_WATER_MARK + 1)); // pause transition.
        assert!(reg.is_paused("t1"));

        reg.apply_ack("t1", ACK_HIGH_WATER_MARK + 1); // full ack -> resume.
        assert!(!reg.is_paused("t1"));
        tokio::time::timeout(std::time::Duration::from_secs(1), notify.notified())
            .await
            .expect("resume must fire");

        assert!(reg.on_sent("t1", ACK_HIGH_WATER_MARK + 1)); // Can pause again (does not get stuck).
        assert!(reg.is_paused("t1"));
        assert_eq!(reg.get("t1").unwrap().diagnostics.ack_pause_count, 2);
        assert_eq!(reg.get("t1").unwrap().diagnostics.ack_resume_count, 1);
    }
}
