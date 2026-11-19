//! Details about session links that are slow to find out, kept in a bounded cache: a read answers at
//! once with what is cached and starts background lookups, a few at a time, for what is missing or
//! due again.

use std::collections::HashMap;
use std::future::Future;
use std::hash::Hash;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::Semaphore;

/// How long after the last read asking for details a queued lookup is still worth running.
pub(crate) const DETAILS_REQUEST_LAPSE: Duration = Duration::from_secs(10);

/// The last lookup's outcome. A failed re-check keeps the details an earlier lookup found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Lookup<V> {
    pub details: Option<V>,
    pub checked_at: Instant,
    pub failed: bool,
}

pub(crate) type LookupFuture<V> = Pin<Box<dyn Future<Output = Option<V>> + Send>>;
pub(crate) type Fetch<R, V> = Arc<dyn Fn(R) -> LookupFuture<V> + Send + Sync>;
pub(crate) type Clock = Arc<dyn Fn() -> Instant + Send + Sync>;
/// Whether a lookup should run now, given the last one (`None` when there has been none).
pub(crate) type IsDue<V> = fn(Option<&Lookup<V>>, Instant) -> bool;

pub(crate) struct LookupLimits {
    pub capacity: usize,
    pub concurrent: usize,
    pub timeout: Duration,
}

struct Entry<V> {
    lookup: Option<Lookup<V>>,
    in_flight: bool,
    last_read: u64,
}

struct Entries<K, V> {
    map: HashMap<K, Entry<V>>,
    capacity: usize,
    reads: u64,
    round_start: u64,
    last_details_request: Option<Instant>,
}

impl<K: Eq + Hash + Clone, V: Clone> Entries<K, V> {
    fn begin_round(&mut self, now: Instant) {
        self.round_start = self.reads + 1;
        self.last_details_request = Some(now);
    }

    fn details_wanted(&self, now: Instant) -> bool {
        self.last_details_request
            .is_some_and(|at| now.saturating_duration_since(at) <= DETAILS_REQUEST_LAPSE)
    }

    fn abandon(&mut self, key: &K) {
        if let Some(entry) = self.map.get_mut(key) {
            entry.in_flight = false;
        }
    }

    /// The cached details of `key`, and whether a lookup should start now (it is then marked in flight).
    /// `None` when `key` is new and there is no room for it this round.
    fn read(&mut self, key: &K, now: Instant, is_due: IsDue<V>) -> Option<(Option<V>, bool)> {
        if !self.map.contains_key(key) && !self.make_room() {
            return None;
        }
        self.reads += 1;
        let reads = self.reads;
        let entry = self.map.entry(key.clone()).or_insert(Entry {
            lookup: None,
            in_flight: false,
            last_read: reads,
        });
        entry.last_read = reads;
        let start = !entry.in_flight && is_due(entry.lookup.as_ref(), now);
        entry.in_flight |= start;
        let details = entry.lookup.as_ref().and_then(|l| l.details.clone());
        Some((details, start))
    }

    fn finish(&mut self, key: &K, found: Option<V>, now: Instant) {
        let Some(entry) = self.map.get_mut(key) else {
            return;
        };
        let previous = entry.lookup.take().and_then(|l| l.details);
        entry.lookup = Some(Lookup {
            failed: found.is_none(),
            details: found.or(previous),
            checked_at: now,
        });
        entry.in_flight = false;
    }

    /// Drops the least recently read entry, never one in flight or already read this round, so a
    /// response with more links than fit keeps the ones it holds instead of churning through them.
    fn make_room(&mut self) -> bool {
        if self.map.len() < self.capacity {
            return true;
        }
        let round_start = self.round_start;
        let oldest = self
            .map
            .iter()
            .filter(|(_, e)| !e.in_flight && e.last_read < round_start)
            .min_by_key(|(_, e)| e.last_read)
            .map(|(key, _)| key.clone());
        let Some(oldest) = oldest else {
            return false;
        };
        self.map.remove(&oldest);
        true
    }
}

/// Keyed by `K`; a lookup is handed an `R` (what it needs to fetch) and finds a `V`.
pub(crate) struct LookupQueue<K, R, V> {
    entries: Arc<Mutex<Entries<K, V>>>,
    permits: Arc<Semaphore>,
    fetch: Fetch<R, V>,
    now: Clock,
    is_due: IsDue<V>,
    pub(crate) timeout: Duration,
}

impl<K, R, V> LookupQueue<K, R, V>
where
    K: Eq + Hash + Clone + Send + 'static,
    R: Send + 'static,
    V: Clone + Send + 'static,
{
    pub(crate) fn new(
        limits: LookupLimits,
        is_due: IsDue<V>,
        fetch: Fetch<R, V>,
        now: Clock,
    ) -> Self {
        Self {
            entries: Arc::new(Mutex::new(Entries {
                map: HashMap::new(),
                capacity: limits.capacity,
                reads: 0,
                round_start: 0,
                last_details_request: None,
            })),
            permits: Arc::new(Semaphore::new(limits.concurrent)),
            fetch,
            now,
            is_due,
            timeout: limits.timeout,
        }
    }

    /// The cached details for each item, in order, starting lookups for those that are due without
    /// waiting for them: their results show on a later read. Must run inside a Tokio runtime.
    pub(crate) fn read(&self, items: Vec<(K, R)>) -> Vec<Option<V>> {
        let now = (self.now)();
        let mut found = vec![None; items.len()];
        let mut lookups = Vec::new();
        {
            let Ok(mut entries) = self.entries.lock() else {
                return found;
            };
            entries.begin_round(now);
            let mut items: Vec<(usize, K, R)> = items
                .into_iter()
                .enumerate()
                .map(|(i, (key, request))| (i, key, request))
                .collect();
            // Cached items are read before new ones so a new item never pushes out one this read shows.
            items.sort_by_key(|(_, key, _)| !entries.map.contains_key(key));
            for (i, key, request) in items {
                let Some((details, start)) = entries.read(&key, now, self.is_due) else {
                    continue;
                };
                found[i] = details;
                if start {
                    lookups.push((key, request));
                }
            }
        }
        for (key, request) in lookups {
            self.spawn_lookup(key, request);
        }
        found
    }

    /// What is cached for `key`, without counting as a read or starting a lookup.
    pub(crate) fn cached(&self, key: &K) -> Option<V> {
        let entries = self.entries.lock().ok()?;
        entries.map.get(key)?.lookup.as_ref()?.details.clone()
    }

    /// A lookup still queued when reads have stopped asking for details is dropped unrun, and the
    /// next read starts it afresh.
    fn spawn_lookup(&self, key: K, request: R) {
        let entries = Arc::clone(&self.entries);
        let permits = Arc::clone(&self.permits);
        let fetch = Arc::clone(&self.fetch);
        let now = Arc::clone(&self.now);
        let timeout = self.timeout;
        tokio::spawn(async move {
            let Ok(_permit) = permits.acquire_owned().await else {
                return;
            };
            let still_wanted = entries.lock().is_ok_and(|e| e.details_wanted(now()));
            if !still_wanted {
                if let Ok(mut entries) = entries.lock() {
                    entries.abandon(&key);
                }
                return;
            }
            let found = tokio::time::timeout(timeout, fetch(request))
                .await
                .ok()
                .flatten();
            if let Ok(mut entries) = entries.lock() {
                entries.finish(&key, found, now());
            }
        });
    }
}

#[cfg(test)]
impl<K: Eq + Hash, R, V> LookupQueue<K, R, V> {
    pub(crate) fn len(&self) -> usize {
        self.entries.lock().unwrap().map.len()
    }

    pub(crate) fn contains(&self, key: &K) -> bool {
        self.entries.lock().unwrap().map.contains_key(key)
    }

    pub(crate) fn in_flight(&self, key: &K) -> bool {
        self.entries
            .lock()
            .unwrap()
            .map
            .get(key)
            .is_some_and(|e| e.in_flight)
    }

    pub(crate) fn never_looked_up(&self) -> usize {
        let entries = self.entries.lock().unwrap();
        entries.map.values().filter(|e| e.lookup.is_none()).count()
    }

    /// Waits until no lookup is in flight.
    pub(crate) async fn settle(&self) {
        for _ in 0..200 {
            let busy = self
                .entries
                .lock()
                .unwrap()
                .map
                .values()
                .any(|e| e.in_flight);
            if !busy {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("lookups never settled");
    }
}
