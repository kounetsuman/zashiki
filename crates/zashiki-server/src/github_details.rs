//! Titles and states of the GitHub pull requests and issues a Claude Session links to, looked up with
//! `gh` in the background and kept for the server's lifetime.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;
use tokio::sync::Semaphore;

use crate::protocol::{GithubLinkRef, GithubState, SessionLink};

const MAX_CONCURRENT_LOOKUPS: usize = 4;
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(10);
const OPEN_RECHECK: Duration = Duration::from_secs(60);
const FAILURE_RETRY: Duration = Duration::from_secs(5 * 60);
/// How many pull requests and issues are remembered at once; the least recently read is dropped first.
const CACHE_CAPACITY: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubDetails {
    pub title: String,
    pub state: GithubState,
}

/// The last lookup's outcome. A failed re-check keeps the details an earlier lookup found.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Lookup {
    details: Option<GithubDetails>,
    checked_at: Instant,
    failed: bool,
}

fn is_due(lookup: Option<&Lookup>, now: Instant) -> bool {
    let Some(lookup) = lookup else {
        return true;
    };
    let wait = if lookup.failed {
        FAILURE_RETRY
    } else if lookup
        .details
        .as_ref()
        .is_some_and(|d| d.state == GithubState::Open)
    {
        OPEN_RECHECK
    } else {
        return false;
    };
    now.saturating_duration_since(lookup.checked_at) >= wait
}

fn github_state(state: &str, merged: bool) -> Option<GithubState> {
    match (state, merged) {
        ("open", _) => Some(GithubState::Open),
        ("closed", true) => Some(GithubState::Merged),
        ("closed", false) => Some(GithubState::Closed),
        _ => None,
    }
}

#[derive(Deserialize)]
struct RawIssue {
    title: String,
    state: String,
    pull_request: Option<RawPullRequest>,
}

#[derive(Deserialize)]
struct RawPullRequest {
    merged_at: Option<String>,
}

/// The title and state in a `GET repos/{owner}/{repo}/issues/{n}` response, which answers for pull
/// requests too (with a `pull_request` object carrying `merged_at`).
fn parse_issue(json: &str) -> Option<GithubDetails> {
    let raw: RawIssue = serde_json::from_str(json).ok()?;
    let merged = raw.pull_request.is_some_and(|pr| pr.merged_at.is_some());
    Some(GithubDetails {
        state: github_state(&raw.state, merged)?,
        title: raw.title,
    })
}

/// Whether a path segment can go into an API path as is: GitHub's owner and repo characters only, and
/// never `.` or `..`.
fn is_plain_segment(segment: &str) -> bool {
    !matches!(segment, "" | "." | "..")
        && segment
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

pub(crate) type LookupFuture = Pin<Box<dyn Future<Output = Option<GithubDetails>> + Send>>;
pub(crate) type Fetch = Arc<dyn Fn(GithubLinkRef) -> LookupFuture + Send + Sync>;
pub(crate) type Clock = Arc<dyn Fn() -> Instant + Send + Sync>;

struct Entry {
    lookup: Option<Lookup>,
    in_flight: bool,
    last_read: u64,
}

#[derive(Default)]
struct Entries {
    map: HashMap<String, Entry>,
    reads: u64,
}

impl Entries {
    /// The cached details of `url`, and whether a lookup should start now (it is then marked in flight).
    fn read(&mut self, url: &str, now: Instant) -> (Option<GithubDetails>, bool) {
        self.reads += 1;
        let reads = self.reads;
        let entry = self.map.entry(url.to_string()).or_insert(Entry {
            lookup: None,
            in_flight: false,
            last_read: reads,
        });
        entry.last_read = reads;
        let start = !entry.in_flight && is_due(entry.lookup.as_ref(), now);
        entry.in_flight |= start;
        let details = entry.lookup.as_ref().and_then(|l| l.details.clone());
        self.evict_beyond_capacity();
        (details, start)
    }

    fn finish(&mut self, url: &str, found: Option<GithubDetails>, now: Instant) {
        let Some(entry) = self.map.get_mut(url) else {
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

    fn evict_beyond_capacity(&mut self) {
        if self.map.len() <= CACHE_CAPACITY {
            return;
        }
        let oldest = self
            .map
            .iter()
            .min_by_key(|(_, e)| e.last_read)
            .map(|(url, _)| url.clone());
        if let Some(oldest) = oldest {
            self.map.remove(&oldest);
        }
    }
}

/// Fills links in from the cache and starts lookups for what is missing or stale, without waiting
/// for them: their results show on a later read.
pub struct GithubDetailsCache {
    entries: Arc<Mutex<Entries>>,
    permits: Arc<Semaphore>,
    fetch: Fetch,
    now: Clock,
    timeout: Duration,
}

impl Default for GithubDetailsCache {
    fn default() -> Self {
        Self::with_fetch(
            Arc::new(|github| Box::pin(gh_issue(github))),
            Arc::new(Instant::now),
        )
    }
}

impl GithubDetailsCache {
    pub(crate) fn with_fetch(fetch: Fetch, now: Clock) -> Self {
        Self {
            entries: Arc::default(),
            permits: Arc::new(Semaphore::new(MAX_CONCURRENT_LOOKUPS)),
            fetch,
            now,
            timeout: LOOKUP_TIMEOUT,
        }
    }

    /// Must run inside a Tokio runtime: lookups are spawned onto it.
    pub fn annotate(&self, links: &mut [SessionLink]) {
        let now = (self.now)();
        for link in links {
            let Some(github) = link.github.as_mut() else {
                continue;
            };
            if !is_plain_segment(&github.owner) || !is_plain_segment(&github.repo) {
                continue;
            }
            let Ok(mut entries) = self.entries.lock() else {
                return;
            };
            let (details, start) = entries.read(&link.url, now);
            drop(entries);
            if let Some(details) = details {
                github.title = Some(details.title);
                github.state = Some(details.state);
            }
            if start {
                self.spawn_lookup(link.url.clone(), github.clone());
            }
        }
    }

    fn spawn_lookup(&self, url: String, github: GithubLinkRef) {
        let entries = Arc::clone(&self.entries);
        let permits = Arc::clone(&self.permits);
        let lookup = (self.fetch)(github);
        let now = Arc::clone(&self.now);
        let timeout = self.timeout;
        tokio::spawn(async move {
            let found = match permits.acquire_owned().await {
                Ok(_permit) => tokio::time::timeout(timeout, lookup).await.ok().flatten(),
                Err(_) => None,
            };
            if let Ok(mut entries) = entries.lock() {
                entries.finish(&url, found, now());
            }
        });
    }
}

/// `gh api` on the issues endpoint: one REST call answers for both pull requests and issues. stderr
/// is dropped, so nothing gh reports (auth hints, API errors) reaches a log or the client.
async fn gh_issue(github: GithubLinkRef) -> Option<GithubDetails> {
    let program = crate::session_launch::resolve_program_path("gh")?;
    let path = format!(
        "repos/{}/{}/issues/{}",
        github.owner, github.repo, github.number
    );
    let output = tokio::process::Command::new(program)
        .args(["api", "--hostname", "github.com", &path])
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .ok()?
        .wait_with_output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_issue(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{SessionLinkKind, SessionLinkTab};
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

    fn open(title: &str) -> GithubDetails {
        GithubDetails {
            title: title.into(),
            state: GithubState::Open,
        }
    }

    static BASE: std::sync::LazyLock<Instant> = std::sync::LazyLock::new(Instant::now);

    fn at(ms: u64) -> Instant {
        *BASE + Duration::from_millis(ms)
    }

    fn ms(duration: Duration) -> u64 {
        duration.as_millis() as u64
    }

    fn checked(state: Option<GithubState>, at_ms: u64, failed: bool) -> Lookup {
        Lookup {
            details: state.map(|state| GithubDetails {
                title: "t".into(),
                state,
            }),
            checked_at: at(at_ms),
            failed,
        }
    }

    #[test]
    fn anything_never_looked_up_is_due() {
        assert!(is_due(None, at(0)));
    }

    #[test]
    fn merged_and_closed_results_are_kept_for_good() {
        for state in [GithubState::Merged, GithubState::Closed] {
            assert!(!is_due(
                Some(&checked(Some(state), 0, false)),
                at(u64::MAX / 4)
            ));
        }
    }

    #[test]
    fn an_open_result_is_rechecked_after_a_minute() {
        let lookup = checked(Some(GithubState::Open), 1_000, false);
        assert!(!is_due(Some(&lookup), at(1_000 + ms(OPEN_RECHECK) - 1)));
        assert!(is_due(Some(&lookup), at(1_000 + ms(OPEN_RECHECK))));
    }

    #[test]
    fn a_failure_is_retried_after_five_minutes_even_over_earlier_details() {
        for lookup in [
            checked(None, 1_000, true),
            checked(Some(GithubState::Merged), 1_000, true),
        ] {
            assert!(!is_due(Some(&lookup), at(1_000 + ms(FAILURE_RETRY) - 1)));
            assert!(is_due(Some(&lookup), at(1_000 + ms(FAILURE_RETRY))));
        }
    }

    #[test]
    fn states_map_with_merged_only_for_a_merged_pull_request() {
        assert_eq!(github_state("open", false), Some(GithubState::Open));
        assert_eq!(github_state("closed", false), Some(GithubState::Closed));
        assert_eq!(github_state("closed", true), Some(GithubState::Merged));
        assert_eq!(github_state("unknown", false), None);
    }

    #[test]
    fn an_issue_response_gives_its_title_and_state() {
        let json = r#"{"number":3,"title":"Crash on start","state":"open","body":"long"}"#;
        assert_eq!(parse_issue(json), Some(open("Crash on start")));
    }

    #[test]
    fn a_pull_request_response_is_merged_only_when_merged_at_is_set() {
        let merged = r#"{"title":"Add x","state":"closed","pull_request":{"merged_at":"2026-01-01T00:00:00Z"}}"#;
        let closed = r#"{"title":"Add x","state":"closed","pull_request":{"merged_at":null}}"#;
        assert_eq!(
            parse_issue(merged).map(|d| d.state),
            Some(GithubState::Merged)
        );
        assert_eq!(
            parse_issue(closed).map(|d| d.state),
            Some(GithubState::Closed)
        );
    }

    #[test]
    fn an_unreadable_response_gives_nothing() {
        assert_eq!(parse_issue("not json"), None);
        assert_eq!(parse_issue(r#"{"message":"Not Found"}"#), None);
        assert_eq!(parse_issue(r#"{"title":"x","state":"draft"}"#), None);
    }

    #[test]
    fn only_plain_owner_and_repo_names_go_into_an_api_path() {
        for ok in ["kounetsuman", "zashiki", "my-repo", "a.b_c", ".github"] {
            assert!(is_plain_segment(ok), "{ok}");
        }
        for bad in ["", ".", "..", "a%2fb", "a b", "a?b"] {
            assert!(!is_plain_segment(bad), "{bad}");
        }
    }

    fn github_link(owner: &str, number: u64) -> SessionLink {
        SessionLink {
            url: format!("https://github.com/{owner}/r/pull/{number}"),
            tab: SessionLinkTab::Conversation,
            kind: SessionLinkKind::Pr,
            source: "user".into(),
            title: None,
            github: Some(GithubLinkRef {
                owner: owner.into(),
                repo: "r".into(),
                number,
                ..Default::default()
            }),
        }
    }

    struct Fake {
        cache: GithubDetailsCache,
        calls: Arc<AtomicUsize>,
        clock: Arc<AtomicU64>,
    }

    fn fake(
        answer: impl Fn(u64) -> Option<GithubDetails> + Send + Sync + 'static,
        delay: Duration,
    ) -> Fake {
        let calls = Arc::new(AtomicUsize::new(0));
        let clock = Arc::new(AtomicU64::new(0));
        let answer = Arc::new(answer);
        let counted = Arc::clone(&calls);
        let fetch: Fetch = Arc::new(move |github: GithubLinkRef| {
            counted.fetch_add(1, Ordering::SeqCst);
            let answer = Arc::clone(&answer);
            Box::pin(async move {
                tokio::time::sleep(delay).await;
                answer(github.number)
            })
        });
        let now = Arc::clone(&clock);
        let cache =
            GithubDetailsCache::with_fetch(fetch, Arc::new(move || at(now.load(Ordering::SeqCst))));
        Fake {
            cache,
            calls,
            clock,
        }
    }

    async fn settle(cache: &GithubDetailsCache) {
        for _ in 0..200 {
            let busy = cache
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

    fn annotated(cache: &GithubDetailsCache, links: &[SessionLink]) -> Vec<SessionLink> {
        let mut links = links.to_vec();
        cache.annotate(&mut links);
        links
    }

    #[tokio::test]
    async fn the_first_read_returns_at_once_and_a_later_read_carries_the_result() {
        let f = fake(
            |n| Some(open(&format!("PR {n}"))),
            Duration::from_millis(10),
        );
        let links = [github_link("o", 7)];
        let first = annotated(&f.cache, &links);
        assert_eq!(first[0].github.as_ref().unwrap().title, None);
        settle(&f.cache).await;
        let later = annotated(&f.cache, &links);
        let github = later[0].github.as_ref().unwrap();
        assert_eq!(github.title.as_deref(), Some("PR 7"));
        assert_eq!(github.state, Some(GithubState::Open));
    }

    #[tokio::test]
    async fn a_link_in_flight_is_not_looked_up_again() {
        let f = fake(|_| Some(open("x")), Duration::from_millis(30));
        let links = [github_link("o", 1), github_link("o", 1)];
        annotated(&f.cache, &links);
        annotated(&f.cache, &links);
        settle(&f.cache).await;
        assert_eq!(f.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn at_most_four_lookups_run_at_once() {
        let running = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let (r, p) = (Arc::clone(&running), Arc::clone(&peak));
        let fetch: Fetch = Arc::new(move |_| {
            let (r, p) = (Arc::clone(&r), Arc::clone(&p));
            Box::pin(async move {
                let now = r.fetch_add(1, Ordering::SeqCst) + 1;
                p.fetch_max(now, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(20)).await;
                r.fetch_sub(1, Ordering::SeqCst);
                Some(open("x"))
            })
        });
        let cache = GithubDetailsCache::with_fetch(fetch, Arc::new(|| at(0)));
        let links: Vec<SessionLink> = (1..=10).map(|n| github_link("o", n)).collect();
        annotated(&cache, &links);
        settle(&cache).await;
        assert_eq!(peak.load(Ordering::SeqCst), MAX_CONCURRENT_LOOKUPS);
    }

    #[tokio::test]
    async fn a_lookup_that_overruns_its_timeout_is_a_remembered_failure() {
        let mut f = fake(|_| Some(open("late")), Duration::from_millis(200));
        f.cache.timeout = Duration::from_millis(10);
        let links = [github_link("o", 1)];
        annotated(&f.cache, &links);
        settle(&f.cache).await;
        annotated(&f.cache, &links);
        assert_eq!(f.calls.load(Ordering::SeqCst), 1);
        f.clock.store(ms(FAILURE_RETRY), Ordering::SeqCst);
        annotated(&f.cache, &links);
        assert_eq!(f.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn an_open_result_is_shown_while_it_is_rechecked() {
        let f = fake(|_| Some(open("x")), Duration::from_millis(5));
        let links = [github_link("o", 1)];
        annotated(&f.cache, &links);
        settle(&f.cache).await;
        f.clock.store(ms(OPEN_RECHECK), Ordering::SeqCst);
        let during = annotated(&f.cache, &links);
        assert_eq!(
            during[0].github.as_ref().unwrap().title.as_deref(),
            Some("x")
        );
        assert_eq!(f.calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn a_failed_recheck_keeps_the_details_found_before() {
        let fail = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let failing = Arc::clone(&fail);
        let f = fake(
            move |_| (!failing.load(Ordering::SeqCst)).then(|| open("x")),
            Duration::from_millis(1),
        );
        let links = [github_link("o", 1)];
        annotated(&f.cache, &links);
        settle(&f.cache).await;
        fail.store(true, Ordering::SeqCst);
        f.clock.store(ms(OPEN_RECHECK), Ordering::SeqCst);
        annotated(&f.cache, &links);
        settle(&f.cache).await;
        let after = annotated(&f.cache, &links);
        assert_eq!(
            after[0].github.as_ref().unwrap().title.as_deref(),
            Some("x")
        );
    }

    #[tokio::test]
    async fn links_without_a_github_ref_or_with_odd_names_are_never_looked_up() {
        let f = fake(|_| Some(open("x")), Duration::ZERO);
        let mut other = github_link("o", 1);
        other.github = None;
        annotated(&f.cache, &[other, github_link("..", 2)]);
        settle(&f.cache).await;
        assert_eq!(f.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn the_cache_keeps_only_the_most_recently_read_links() {
        let f = fake(|_| Some(open("x")), Duration::ZERO);
        let links: Vec<SessionLink> = (0..=CACHE_CAPACITY as u64)
            .map(|n| github_link("o", n))
            .collect();
        annotated(&f.cache, &links[..CACHE_CAPACITY]);
        annotated(&f.cache, &links[..1]);
        annotated(&f.cache, &links[CACHE_CAPACITY..]);
        settle(&f.cache).await;
        let entries = f.cache.entries.lock().unwrap();
        assert_eq!(entries.map.len(), CACHE_CAPACITY);
        assert!(entries.map.contains_key(&links[0].url));
        assert!(!entries.map.contains_key(&links[1].url));
    }
}
