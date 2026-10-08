//! In-memory store of what Claude Code's hooks have said about each Claude Session (`sid`), shared
//! by the hook intake route (writer) and the status poller (reader). Two readings are kept apart
//! because they answer different questions and age on different clocks: the last event, read through
//! [`crate::poller_types::PollerPorts::last_hook_event`] to feed
//! [`zashiki_core::session_state::resolve_state`], and which background agents have reported
//! stopping and when, read through [`crate::poller_types::PollerPorts::stopped_subagent_ages_sec`] to tell a
//! scraped agent tray from a leftover render. It also keeps which Claude Session each claude in a
//! Cockpit Terminal last reported, read through
//! [`crate::poller_types::PollerPorts::reported_claude_session`]: an in-session `/resume` or `/clear`
//! moves claude to another sid while its launch arguments keep the old one. The canonical spec is the
//! `tests` module.

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

/// The most Claude Sessions whose stopped agents are kept. Stops are bounded by capacity rather than
/// by age: they are read precisely when a terminal has been sitting still, so a time horizon would
/// drop them while they are still the reason its agent tray is down, and the tray would come back.
/// Eviction takes the session least recently written to or read from. Reads only happen while a
/// session's tray is stale, so a session in the middle of a long batch is touched by its own stops
/// alone and can still go cold; being dropped then costs it the release for the rest of the session
/// and leaves its tray up.
const MAX_TRACKED_SIDS: usize = 512;

/// The most agents held for one Claude Session. A session that runs more than this over its life
/// stops being releasable rather than growing without bound; the tray it leaves up is the state this
/// whole floor describes.
const MAX_AGENTS_PER_SID: usize = 4096;

/// When each agent under one Claude Session reported stopping, and when the session was last heard
/// from — written or read. Stop times are kept rather than a bare set: another `SubagentStop` hook
/// can send an agent back to work, and only the time tells a stop it outlived from a final one.
#[derive(Debug, Default)]
struct StoppedAgents {
    stops_ms: HashMap<String, u64>,
    touched_ms: u64,
}

/// The most Cockpit Terminals whose reported Claude Sessions are kept, and the most claude processes
/// kept per terminal (one runs the terminal; others are claudes it started, such as `claude -p`).
/// The least recently reported one goes first.
const MAX_REPORTING_TERMINALS: usize = 512;
const MAX_REPORTING_CLAUDES_PER_TERMINAL: usize = 16;

/// The sid a claude process reported through its hooks, with when it last did.
#[derive(Debug, Clone)]
struct ReportedSession {
    sid: String,
    at_ms: u64,
}

/// claude pid -> what it reported, for one Cockpit Terminal.
type ReportingClaudes = HashMap<i64, ReportedSession>;

#[derive(Default)]
pub struct HookEventStore {
    inner: Mutex<HashMap<String, Recorded>>,
    stopped_agents: Mutex<HashMap<String, StoppedAgents>>,
    reported_sessions: Mutex<HashMap<String, ReportingClaudes>>,
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

    /// Records that the agent `agent_id` under `sid` reported stopping. `sid` is lowercased to match
    /// the poller's process-tree-derived sid; a `SubagentStop` carries the parent session's id, not
    /// the agent's own, which is what makes that match land. Agents are held as a set, so a hook that
    /// fires twice for one agent is recorded once.
    pub fn record_subagent_end(&self, sid: &str, agent_id: &str, now_ms: u64) {
        let mut map = self.stopped_agents.lock().unwrap();
        let sid = sid.to_lowercase();
        if map.len() >= MAX_TRACKED_SIDS && !map.contains_key(&sid) {
            evict_oldest(&mut map, |agents: &StoppedAgents| Some(agents.touched_ms));
        }
        let agents = map.entry(sid).or_default();
        if agents.stops_ms.len() < MAX_AGENTS_PER_SID
            || agents.stops_ms.contains_key(agent_id)
        {
            agents.stops_ms.insert(agent_id.to_string(), now_ms);
        }
        agents.touched_ms = now_ms;
    }

    /// How long ago each agent under `sid` reported stopping, and a touch that keeps a session being
    /// read out of eviction's reach for as long as it is being read. Ages are floored to whole
    /// seconds to match the transcript ages they are compared against; a clock that went backwards
    /// reads as a stop this instant.
    pub fn stopped_subagent_ages_sec(&self, sid: &str, now_ms: u64) -> HashMap<String, f64> {
        let mut map = self.stopped_agents.lock().unwrap();
        match map.get_mut(&sid.to_lowercase()) {
            Some(agents) => {
                agents.touched_ms = now_ms;
                agents
                    .stops_ms
                    .iter()
                    .map(|(agent_id, at_ms)| {
                        (
                            agent_id.clone(),
                            (now_ms.saturating_sub(*at_ms) / 1000) as f64,
                        )
                    })
                    .collect()
            }
            None => HashMap::new(),
        }
    }
}

impl HookEventStore {
    /// Records that the claude `claude_pid` in `cockpit_terminal_id` is now on `sid` (lowercased like
    /// every other sid here).
    pub fn record_claude_session(&self, cockpit_terminal_id: &str, claude_pid: i64, sid: &str, now_ms: u64) {
        let mut map = self.reported_sessions.lock().unwrap();
        if map.len() >= MAX_REPORTING_TERMINALS && !map.contains_key(cockpit_terminal_id) {
            let last_report = |claudes: &ReportingClaudes| claudes.values().map(|r| r.at_ms).max();
            evict_oldest(&mut map, last_report);
        }
        let claudes = map.entry(cockpit_terminal_id.to_string()).or_default();
        if claudes.len() >= MAX_REPORTING_CLAUDES_PER_TERMINAL && !claudes.contains_key(&claude_pid) {
            evict_oldest(claudes, |r: &ReportedSession| Some(r.at_ms));
        }
        claudes.insert(
            claude_pid,
            ReportedSession {
                sid: sid.to_lowercase(),
                at_ms: now_ms,
            },
        );
    }

    /// The sid the claude `claude_pid` in the terminal last reported (None if it never did).
    pub fn reported_claude_session(&self, cockpit_terminal_id: &str, claude_pid: i64) -> Option<String> {
        let map = self.reported_sessions.lock().unwrap();
        map.get(&cockpit_terminal_id.to_lowercase())?
            .get(&claude_pid)
            .map(|r| r.sid.clone())
    }
}

fn evict_oldest<K: Clone + Eq + std::hash::Hash, V>(
    map: &mut HashMap<K, V>,
    reported_at: impl Fn(&V) -> Option<u64>,
) {
    if let Some(oldest) = map
        .iter()
        .min_by_key(|(_, v)| reported_at(v))
        .map(|(k, _)| k.clone())
    {
        map.remove(&oldest);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SID: &str = "0b6cbc45-83a9-4f2e-9c3d-1a2b3c4d5e6f";

    const TERMINAL: &str = "11111111-2222-4333-8444-555555555555";

    #[test]
    fn each_claude_in_a_terminal_keeps_the_latest_session_it_reported() {
        let store = HookEventStore::new();
        assert_eq!(store.reported_claude_session(TERMINAL, 120), None);
        store.record_claude_session(TERMINAL, 120, TERMINAL, 1000);
        store.record_claude_session(TERMINAL, 120, &SID.to_uppercase(), 2000);
        store.record_claude_session(TERMINAL, 150, TERMINAL, 3000);
        assert_eq!(store.reported_claude_session(TERMINAL, 120).as_deref(), Some(SID));
        assert_eq!(store.reported_claude_session(TERMINAL, 150).as_deref(), Some(TERMINAL));
        assert_eq!(store.reported_claude_session("other", 120), None);
    }

    #[test]
    fn reports_are_bounded_by_dropping_the_least_recently_reporting() {
        let store = HookEventStore::new();
        for pid in 0..MAX_REPORTING_CLAUDES_PER_TERMINAL as i64 {
            store.record_claude_session(TERMINAL, pid, SID, 1000 + pid as u64);
        }
        store.record_claude_session(TERMINAL, 0, SID, 9000);
        store.record_claude_session(TERMINAL, 999, SID, 9001);
        assert!(store.reported_claude_session(TERMINAL, 1).is_none());
        assert!(store.reported_claude_session(TERMINAL, 0).is_some());

        for i in 0..MAX_REPORTING_TERMINALS as u64 {
            store.record_claude_session(&format!("t{i}"), 1, SID, 10_000 + i);
        }
        assert!(store.reported_claude_session(TERMINAL, 999).is_none());
        assert!(store.reported_claude_session("t0", 1).is_some());
    }

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

    // -- subagent stops --

    const AGENT_A: &str = "a374587f5bbaaf161";
    const AGENT_B: &str = "a8bd2811e301d64f7";

    #[test]
    fn no_stops_reported_for_an_unknown_sid() {
        let store = HookEventStore::new();
        assert_eq!(store.stopped_subagent_ages_sec(SID, 1000).len(), 0);
    }

    #[test]
    fn distinct_agents_each_count_once() {
        let store = HookEventStore::new();
        store.record_subagent_end(SID, AGENT_A, 1000);
        store.record_subagent_end(SID, AGENT_B, 2000);
        assert_eq!(store.stopped_subagent_ages_sec(SID, 2000).len(), 2);
    }

    /// A hook that fires twice for one agent must not read as two agents having finished.
    /// An agent that reports twice is one agent, dated by its latest stop — the one an agent sent
    /// back to work would be measured against.
    #[test]
    fn the_same_agent_reported_twice_keeps_its_latest_stop() {
        let store = HookEventStore::new();
        store.record_subagent_end(SID, AGENT_A, 1000);
        store.record_subagent_end(SID, AGENT_A, 2000);
        let ages = store.stopped_subagent_ages_sec(SID, 2000);
        assert_eq!(ages, HashMap::from([(AGENT_A.to_string(), 0.0)]));
    }

    #[test]
    fn stops_are_kept_per_session() {
        let store = HookEventStore::new();
        store.record_subagent_end(SID, AGENT_A, 1000);
        assert_eq!(store.stopped_subagent_ages_sec("other-sid", 1000).len(), 0);
    }

    #[test]
    fn subagent_stop_sid_is_matched_case_insensitively() {
        let store = HookEventStore::new();
        store.record_subagent_end(&SID.to_uppercase(), AGENT_A, 1000);
        assert_eq!(store.stopped_subagent_ages_sec(SID, 1000).len(), 1);
    }



    /// The two readings are independent: recording one never evicts or overwrites the other.
    #[test]
    fn stops_and_the_last_event_do_not_displace_each_other() {
        let store = HookEventStore::new();
        store.record(SID, HookEvent::Waiting, 1000);
        store.record_subagent_end(SID, AGENT_A, 2000);
        assert_eq!(store.get(SID, 2000).unwrap().event, HookEvent::Waiting);
        assert_eq!(store.stopped_subagent_ages_sec(SID, 2000).len(), 1);
    }

    /// Stops outlive the hook-event horizon, so an agent tray taken down hours ago stays down.
    #[test]
    fn stops_outlive_the_hook_event_horizon() {
        let store = HookEventStore::new();
        store.record_subagent_end(SID, AGENT_A, 0);
        assert_eq!(store.stopped_subagent_ages_sec(SID, RETAIN_MS * 10).len(), 1);
    }

    /// At capacity, the session heard from longest ago is the one evicted.
    #[test]
    fn capacity_evicts_the_coldest_session() {
        let store = HookEventStore::new();
        for i in 0..MAX_TRACKED_SIDS {
            store.record_subagent_end(&format!("sid-{i}"), AGENT_A, 1000 + i as u64);
        }
        store.record_subagent_end(SID, AGENT_A, 9_000_000);
        assert_eq!(store.stopped_subagent_ages_sec("sid-0", 9_000_000).len(), 0);
        assert_eq!(store.stopped_subagent_ages_sec(SID, 9_000_000).len(), 1);
        assert_eq!(
            store.stopped_subagent_ages_sec("sid-1", 9_000_000).len(),
            1,
            "only the coldest session is evicted"
        );
    }

    #[test]
    fn the_report_names_each_agent_that_stopped_and_how_long_ago() {
        let store = HookEventStore::new();
        store.record_subagent_end(SID, AGENT_A, 1000);
        store.record_subagent_end(SID, AGENT_B, 1000);
        let ages = store.stopped_subagent_ages_sec(SID, 3000);
        assert_eq!(
            ages,
            HashMap::from([(AGENT_A.to_string(), 2.0), (AGENT_B.to_string(), 2.0)])
        );
    }

    /// Reading touches, so the session the poller is still watching is not the one capacity evicts —
    /// which would put its agent tray back up.
    #[test]
    fn a_session_being_read_is_not_the_one_evicted() {
        let store = HookEventStore::new();
        store.record_subagent_end(SID, AGENT_A, 1);
        for i in 0..MAX_TRACKED_SIDS - 1 {
            store.record_subagent_end(&format!("sid-{i}"), AGENT_A, 1000 + i as u64);
        }
        // The poller reads the watched session every tick; without the touch it is the coldest.
        assert_eq!(store.stopped_subagent_ages_sec(SID, 9_000_000).len(), 1);
        store.record_subagent_end("newcomer", AGENT_B, 9_000_001);
        assert_eq!(store.stopped_subagent_ages_sec(SID, 9_000_002).len(), 1);
        assert_eq!(
            store.stopped_subagent_ages_sec("sid-0", 9_000_002).len(),
            0,
            "the untouched session is the one evicted"
        );
    }


    /// Agents per session are capped, so a long-lived session cannot grow the set without bound.
    #[test]
    fn agents_per_session_are_capped() {
        let store = HookEventStore::new();
        for i in 0..MAX_AGENTS_PER_SID + 10 {
            store.record_subagent_end(SID, &format!("agent-{i}"), 1000);
        }
        // An agent already held keeps being re-dated even once the cap is reached.
        store.record_subagent_end(SID, "agent-0", 5000);
        assert_eq!(
            store.stopped_subagent_ages_sec(SID, 5000).get("agent-0"),
            Some(&0.0)
        );
        assert_eq!(
            store.stopped_subagent_ages_sec(SID, 1000).len(),
            MAX_AGENTS_PER_SID
        );
    }

    /// A session already tracked keeps taking stops at capacity without evicting anyone.
    #[test]
    fn capacity_does_not_evict_for_a_session_already_tracked() {
        let store = HookEventStore::new();
        for i in 0..MAX_TRACKED_SIDS {
            store.record_subagent_end(&format!("sid-{i}"), AGENT_A, 1000 + i as u64);
        }
        store.record_subagent_end("sid-0", AGENT_B, 9_000_000);
        assert_eq!(store.stopped_subagent_ages_sec("sid-0", 9_000_000).len(), 2);
        assert_eq!(store.stopped_subagent_ages_sec("sid-1", 9_000_000).len(), 1);
    }
}
