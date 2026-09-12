//! In-memory store of the model per Claude Session (`sid`), shared by the statusLine intake route
//! (writer) and the status poller (reader) through
//! [`crate::poller_types::PollerPorts::active_model`], feeding the session status footer.
//! Claude Code reports the model from a session's first statusLine render, before any assistant reply
//! exists in the transcript, which is what lets a freshly launched Cockpit Terminal show its model.
//! The canonical spec is the `tests` module.

use std::collections::HashMap;
use std::sync::Mutex;

use crate::poller_types::ModelReading;

/// How many sids are kept. Unlike [`crate::hook_event_store`] nothing is dropped by age: a session
/// left sitting at the prompt renders its statusLine a few times and then goes quiet, and its model
/// has to keep showing. The cap is what bounds memory, and it evicts by least recent *read* rather
/// than write, so the live terminals the poller reads every cycle outrank sessions that have ended
/// (every Claude Code session on the machine reports here, not only the ones zashiki owns).
const CAPACITY: usize = 256;

#[derive(Debug, Clone)]
struct Recorded {
    model: String,
    /// When Claude Code reported it — what the poller weighs against the transcript.
    recorded_at_ms: u64,
    /// When the poller last read it — the eviction order.
    read_at_ms: u64,
}

#[derive(Default)]
pub struct SessionModelStore {
    inner: Mutex<HashMap<String, Recorded>>,
}

impl SessionModelStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Records `model` for `sid` (latest wins, so an in-session `/model` switch lands on its next
    /// statusLine render) and evicts the least recently read sids above `CAPACITY`. `sid` is
    /// lowercased to match the poller's process-tree-derived sid.
    pub fn record(&self, sid: &str, model: &str, now_ms: u64) {
        let mut map = self.inner.lock().unwrap();
        map.insert(
            sid.to_lowercase(),
            Recorded {
                model: model.to_string(),
                recorded_at_ms: now_ms,
                read_at_ms: now_ms,
            },
        );
        evict_beyond_capacity(&mut map);
    }

    /// The model recorded for `sid` and when it was reported (None if none ever was). Reading marks
    /// the sid as live for eviction.
    pub fn get(&self, sid: &str, now_ms: u64) -> Option<ModelReading> {
        let mut map = self.inner.lock().unwrap();
        let recorded = map.get_mut(&sid.to_lowercase())?;
        recorded.read_at_ms = now_ms;
        Some(ModelReading {
            model: recorded.model.clone(),
            at_ms: Some(recorded.recorded_at_ms),
        })
    }
}

fn evict_beyond_capacity(map: &mut HashMap<String, Recorded>) {
    let excess = map.len().saturating_sub(CAPACITY);
    if excess == 0 {
        return;
    }
    let mut coldest_first: Vec<(String, u64)> =
        map.iter().map(|(sid, r)| (sid.clone(), r.read_at_ms)).collect();
    coldest_first.sort_by_key(|(_, read_at_ms)| *read_at_ms);
    for (sid, _) in coldest_first.into_iter().take(excess) {
        map.remove(&sid);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SID: &str = "0b6cbc45-83a9-4f2e-9c3d-1a2b3c4d5e6f";

    #[test]
    fn get_none_when_absent() {
        assert!(SessionModelStore::new().get(SID, 1000).is_none());
    }

    #[test]
    fn record_then_get_reports_the_model_and_when_it_was_reported() {
        let store = SessionModelStore::new();
        store.record(SID, "claude-opus-5", 1000);
        let got = store.get(SID, 4000).unwrap();
        assert_eq!(got.model, "claude-opus-5");
        assert_eq!(got.at_ms, Some(1000));
    }

    #[test]
    fn latest_model_wins_and_carries_its_own_time() {
        let store = SessionModelStore::new();
        store.record(SID, "claude-opus-5", 1000);
        store.record(SID, "claude-sonnet-5", 5000);
        let got = store.get(SID, 6000).unwrap();
        assert_eq!(got.model, "claude-sonnet-5");
        assert_eq!(got.at_ms, Some(5000));
    }

    #[test]
    fn sid_matches_case_insensitively() {
        let store = SessionModelStore::new();
        store.record(&SID.to_uppercase(), "claude-opus-5", 1000);
        assert_eq!(store.get(SID, 1000).unwrap().model, "claude-opus-5");
    }

    /// A terminal that has gone quiet survives the cap as long as the poller keeps reading it, so the
    /// sessions evicted are the ones nothing looks at any more.
    #[test]
    fn capacity_evicts_the_least_recently_read_not_the_least_recently_recorded() {
        let store = SessionModelStore::new();
        store.record("quiet-but-live", "claude-opus-5", 1);
        store.record("ended", "claude-sonnet-5", 2);
        for i in 0..CAPACITY {
            let at_ms = 100 + i as u64;
            store.get("quiet-but-live", at_ms);
            store.record(&format!("sid-{i}"), "claude-haiku-4-5", at_ms);
        }
        assert_eq!(
            store.get("quiet-but-live", 9999).map(|m| m.model),
            Some("claude-opus-5".to_string())
        );
        assert!(store.get("ended", 9999).is_none());
    }
}
