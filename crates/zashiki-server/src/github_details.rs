//! Titles and states of the GitHub pull requests and issues a Claude Session links to, looked up with
//! `gh` in the background and kept for the server's lifetime.

use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::lookup_queue::{Clock, Lookup, LookupLimits, LookupQueue};
use crate::protocol::{GithubLinkRef, GithubState, SessionLink, SessionLinkKind};

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
    /// GitHub serves a pull request at `/issues/N` too, so the URL alone does not settle the kind.
    pub is_pull_request: bool,
}

fn is_due(lookup: Option<&Lookup<GithubDetails>>, now: Instant) -> bool {
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
    let is_pull_request = raw.pull_request.is_some();
    let merged = raw.pull_request.is_some_and(|pr| pr.merged_at.is_some());
    Some(GithubDetails {
        state: github_state(&raw.state, merged)?,
        title: raw.title,
        is_pull_request,
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

pub(crate) type Fetch = crate::lookup_queue::Fetch<GithubLinkRef, GithubDetails>;

/// One pull request or issue, however its URL was written: `/pull/N` and `/issues/N` name the same
/// item, and GitHub owner and repo names ignore case.
type ItemKey = (String, String, u64);

fn item_key(github: &GithubLinkRef) -> ItemKey {
    (
        github.owner.to_ascii_lowercase(),
        github.repo.to_ascii_lowercase(),
        github.number,
    )
}

/// Fills links in from the cache and starts lookups for what is missing or stale, without waiting
/// for them: their results show on a later read.
pub struct GithubDetailsCache {
    queue: LookupQueue<ItemKey, GithubLinkRef, GithubDetails>,
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
        let limits = LookupLimits {
            capacity: CACHE_CAPACITY,
            concurrent: MAX_CONCURRENT_LOOKUPS,
            timeout: LOOKUP_TIMEOUT,
        };
        Self {
            queue: LookupQueue::new(limits, is_due, fetch, now),
        }
    }

    /// Must run inside a Tokio runtime: lookups are spawned onto it.
    pub fn annotate(&self, links: &mut [SessionLink]) {
        let mut lookable: Vec<&mut SessionLink> = links
            .iter_mut()
            .filter(|link| {
                link.github
                    .as_ref()
                    .is_some_and(|g| is_plain_segment(&g.owner) && is_plain_segment(&g.repo))
            })
            .collect();
        let items = lookable
            .iter()
            .filter_map(|link| link.github.as_ref())
            .map(|github| (item_key(github), github.clone()))
            .collect();
        let found = self.queue.read(items);
        for (link, details) in lookable.iter_mut().zip(found) {
            let (Some(details), Some(github)) = (details, link.github.as_mut()) else {
                continue;
            };
            github.title = Some(details.title);
            github.state = Some(details.state);
            link.kind = if details.is_pull_request {
                SessionLinkKind::Pr
            } else {
                SessionLinkKind::Issue
            };
        }
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
    use crate::protocol::SessionLinkTab;
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

    fn open(title: &str) -> GithubDetails {
        GithubDetails {
            title: title.into(),
            state: GithubState::Open,
            is_pull_request: true,
        }
    }

    static BASE: std::sync::LazyLock<Instant> = std::sync::LazyLock::new(Instant::now);

    fn at(ms: u64) -> Instant {
        *BASE + Duration::from_millis(ms)
    }

    fn ms(duration: Duration) -> u64 {
        duration.as_millis() as u64
    }

    fn checked(state: Option<GithubState>, at_ms: u64, failed: bool) -> Lookup<GithubDetails> {
        Lookup {
            details: state.map(|state| GithubDetails {
                title: "t".into(),
                state,
                is_pull_request: true,
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
        assert_eq!(
            parse_issue(json),
            Some(GithubDetails {
                is_pull_request: false,
                ..open("Crash on start")
            })
        );
    }

    #[test]
    fn a_response_tells_a_pull_request_from_an_issue() {
        let issue = r#"{"title":"x","state":"open"}"#;
        let pull = r#"{"title":"x","state":"open","pull_request":{"merged_at":null}}"#;
        assert_eq!(parse_issue(issue).map(|d| d.is_pull_request), Some(false));
        assert_eq!(parse_issue(pull).map(|d| d.is_pull_request), Some(true));
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
            page_title: None,
            favicon_origin: None,
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
        cache.queue.settle().await;
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
    async fn a_pull_and_an_issues_url_for_the_same_number_share_one_lookup() {
        let f = fake(|n| Some(open(&format!("#{n}"))), Duration::from_millis(5));
        let mut as_issue = github_link("o", 5);
        as_issue.url = "https://github.com/o/r/issues/5".into();
        let mut upper = github_link("o", 5);
        upper.github.as_mut().unwrap().owner = "O".into();
        let links = [github_link("o", 5), as_issue, upper];
        annotated(&f.cache, &links);
        settle(&f.cache).await;
        let later = annotated(&f.cache, &links);
        assert_eq!(f.calls.load(Ordering::SeqCst), 1);
        assert!(later
            .iter()
            .all(|l| l.github.as_ref().unwrap().title.as_deref() == Some("#5")));
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
        f.cache.queue.timeout = Duration::from_millis(10);
        let links = [github_link("o", 1)];
        annotated(&f.cache, &links);
        settle(&f.cache).await;
        annotated(&f.cache, &links);
        assert_eq!(f.calls.load(Ordering::SeqCst), 1);
        f.clock.store(ms(FAILURE_RETRY), Ordering::SeqCst);
        annotated(&f.cache, &links);
        settle(&f.cache).await;
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
        settle(&f.cache).await;
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
        for round in [
            &links[..CACHE_CAPACITY],
            &links[..1],
            &links[CACHE_CAPACITY..],
        ] {
            annotated(&f.cache, round);
            settle(&f.cache).await;
        }
        let queue = &f.cache.queue;
        assert_eq!(queue.len(), CACHE_CAPACITY);
        assert!(queue.contains(&key_of(&links[0])));
        assert!(!queue.contains(&key_of(&links[1])));
    }

    fn key_of(link: &SessionLink) -> ItemKey {
        item_key(link.github.as_ref().unwrap())
    }

    #[tokio::test]
    async fn a_lookup_in_flight_is_never_dropped_to_make_room() {
        let f = fake(|_| Some(open("x")), Duration::from_secs(60));
        let links: Vec<SessionLink> = (0..=CACHE_CAPACITY as u64)
            .map(|n| github_link("o", n))
            .collect();
        annotated(&f.cache, &links[..CACHE_CAPACITY]);
        annotated(&f.cache, &links[CACHE_CAPACITY..]);
        let queue = &f.cache.queue;
        assert_eq!(queue.len(), CACHE_CAPACITY);
        assert!(links[..CACHE_CAPACITY]
            .iter()
            .all(|l| queue.in_flight(&key_of(l))));
        assert!(!queue.contains(&key_of(&links[CACHE_CAPACITY])));
    }

    #[tokio::test]
    async fn more_links_than_the_cache_holds_still_settle_into_cached_results() {
        let f = fake(|_| Some(open("x")), Duration::ZERO);
        let links: Vec<SessionLink> = (0..CACHE_CAPACITY as u64 + 50)
            .map(|n| github_link("o", n))
            .collect();
        for _ in 0..3 {
            annotated(&f.cache, &links);
            settle(&f.cache).await;
        }
        let titled = annotated(&f.cache, &links)
            .iter()
            .filter(|l| l.github.as_ref().unwrap().title.is_some())
            .count();
        assert_eq!(titled, CACHE_CAPACITY);
        assert_eq!(f.calls.load(Ordering::SeqCst), CACHE_CAPACITY);
    }

    #[tokio::test]
    async fn queued_lookups_are_skipped_once_details_stop_being_asked_for() {
        let f = fake(|_| Some(open("x")), Duration::from_millis(30));
        let links: Vec<SessionLink> = (1..=6).map(|n| github_link("o", n)).collect();
        annotated(&f.cache, &links);
        tokio::time::sleep(Duration::from_millis(5)).await;
        f.clock.store(
            ms(crate::lookup_queue::DETAILS_REQUEST_LAPSE) + 1,
            Ordering::SeqCst,
        );
        settle(&f.cache).await;
        assert_eq!(f.calls.load(Ordering::SeqCst), MAX_CONCURRENT_LOOKUPS);
        assert_eq!(f.cache.queue.never_looked_up(), 2);

        annotated(&f.cache, &links);
        settle(&f.cache).await;
        assert_eq!(f.calls.load(Ordering::SeqCst), 6);
    }

    #[tokio::test]
    async fn a_link_takes_the_kind_github_reports_whichever_url_it_came_from() {
        let f = fake(
            |n| {
                Some(GithubDetails {
                    title: "x".into(),
                    state: GithubState::Closed,
                    is_pull_request: n == 5,
                })
            },
            Duration::ZERO,
        );
        let mut pull_via_issues = github_link("o", 5);
        pull_via_issues.url = "https://github.com/o/r/issues/5".into();
        pull_via_issues.kind = SessionLinkKind::Issue;
        let issue_via_pull = github_link("o", 6);
        let links = [pull_via_issues, issue_via_pull];
        annotated(&f.cache, &links);
        settle(&f.cache).await;
        let kinds: Vec<SessionLinkKind> =
            annotated(&f.cache, &links).iter().map(|l| l.kind).collect();
        assert_eq!(kinds, vec![SessionLinkKind::Pr, SessionLinkKind::Issue]);
    }

    #[tokio::test]
    async fn a_new_link_ahead_of_a_full_cache_drops_nothing_already_resolved() {
        let f = fake(|_| Some(open("x")), Duration::ZERO);
        let held: Vec<SessionLink> = (0..CACHE_CAPACITY as u64)
            .map(|n| github_link("o", n))
            .collect();
        annotated(&f.cache, &held);
        settle(&f.cache).await;

        let newest = github_link("o", CACHE_CAPACITY as u64);
        let mut links = vec![newest.clone()];
        links.extend(held.iter().cloned());
        let shown = annotated(&f.cache, &links);
        settle(&f.cache).await;

        assert!(shown[1..]
            .iter()
            .all(|l| l.github.as_ref().unwrap().title.is_some()));
        assert_eq!(f.calls.load(Ordering::SeqCst), CACHE_CAPACITY);
        assert!(!f.cache.queue.contains(&key_of(&newest)));
    }
}
