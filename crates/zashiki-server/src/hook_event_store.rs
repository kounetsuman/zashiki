//! In-memory store of the last Claude Code hook event per Claude Session (`sid`), shared by the hook
//! intake route (writer) and the status poller (reader) through
//! [`crate::poller_types::PollerPorts::last_hook_event`], feeding
//! [`zashiki_core::session_state::resolve_state`]. The canonical spec is the `tests` module.

use std::collections::HashMap;
use std::sync::Mutex;

use zashiki_core::session_state::HookEvent;

use crate::poller_types::HookEventAge;

/// How long a recorded event is retained before it is pruned on the next write. Generously above the
/// arbitration freshness window (`hook_event_fresh_within_sec`, which actually gates authority); this
/// only bounds memory for sids that never fire again (ended sessions).
const RETAIN_MS: u64 = 5 * 60 * 1000;

#[derive(Debug, Clone, Copy)]
struct Recorded {
    event: HookEvent,
    at_ms: u64,
}

#[derive(Default)]
pub struct HookEventStore {
    inner: Mutex<HashMap<String, Recorded>>,
}

impl HookEventStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Records `event` for `sid` (latest wins) and prunes entries older than `RETAIN_MS`. `sid` is
    /// lowercased to match the poller's process-tree-derived sid.
    pub fn record(&self, sid: &str, event: HookEvent, now_ms: u64) {
        let mut map = self.inner.lock().unwrap();
        map.retain(|_, r| now_ms.saturating_sub(r.at_ms) <= RETAIN_MS);
        map.insert(sid.to_lowercase(), Recorded { event, at_ms: now_ms });
    }

    /// The last event for `sid` with its age in seconds (None if never recorded). A clock that went
    /// backwards clamps the age to 0.
    pub fn get(&self, sid: &str, now_ms: u64) -> Option<HookEventAge> {
        let map = self.inner.lock().unwrap();
        map.get(&sid.to_lowercase()).map(|r| HookEventAge {
            event: r.event,
            age_sec: now_ms.saturating_sub(r.at_ms) as f64 / 1000.0,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SID: &str = "0b6cbc45-83a9-4f2e-9c3d-1a2b3c4d5e6f";

    #[test]
    fn get_none_when_absent() {
        let store = HookEventStore::new();
        assert!(store.get(SID, 1000).is_none());
    }

    #[test]
    fn record_then_get_reports_event_and_age() {
        let store = HookEventStore::new();
        store.record(SID, HookEvent::Waiting, 1000);
        let got = store.get(SID, 3000).unwrap();
        assert_eq!(got.event, HookEvent::Waiting);
        assert_eq!(got.age_sec, 2.0);
    }

    #[test]
    fn latest_event_wins() {
        let store = HookEventStore::new();
        store.record(SID, HookEvent::Waiting, 1000);
        store.record(SID, HookEvent::Done, 2000);
        assert_eq!(store.get(SID, 2000).unwrap().event, HookEvent::Done);
    }

    #[test]
    fn sid_is_matched_case_insensitively() {
        let store = HookEventStore::new();
        store.record(&SID.to_uppercase(), HookEvent::Waiting, 1000);
        assert_eq!(store.get(SID, 1000).unwrap().event, HookEvent::Waiting);
    }

    #[test]
    fn backwards_clock_clamps_age_to_zero() {
        let store = HookEventStore::new();
        store.record(SID, HookEvent::Waiting, 5000);
        assert_eq!(store.get(SID, 1000).unwrap().age_sec, 0.0);
    }

    #[test]
    fn stale_other_sids_are_pruned_on_write() {
        let store = HookEventStore::new();
        store.record("old-sid", HookEvent::Done, 0);
        // A later write past the retention horizon evicts the untouched old sid.
        store.record(SID, HookEvent::Waiting, RETAIN_MS + 1);
        assert!(store.get("old-sid", RETAIN_MS + 1).is_none());
        assert!(store.get(SID, RETAIN_MS + 1).is_some());
    }
}
