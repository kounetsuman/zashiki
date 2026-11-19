//! Titles and favicons of the public web pages a Claude Session links to, fetched in the background
//! and kept for the server's lifetime. A page is read first; its favicon, once the page says where it
//! is, is cached per origin.

use std::sync::Arc;
use std::time::{Duration, Instant};

use url::Url;

use crate::lookup_queue::{Clock, Fetch, Lookup, LookupLimits, LookupQueue};
use crate::page_fetch::{fetch_favicon, fetch_page, FETCH_LIMIT};
pub use crate::page_fetch::{Favicon, PageDetails};
use crate::protocol::{SessionLink, SessionLinkKind};
use crate::public_destination::is_fetchable_url;

const MAX_CONCURRENT_FETCHES: usize = 4;
/// Longer than a fetch may run, so a lookup the queue gives up on has already stopped fetching; the
/// margin covers resolving names, which the fetch's own deadline cannot cut short.
const LOOKUP_TIMEOUT: Duration = FETCH_LIMIT.saturating_add(Duration::from_secs(5));
const SUCCESS_KEPT: Duration = Duration::from_secs(24 * 60 * 60);
const FAILURE_RETRY: Duration = Duration::from_secs(5 * 60);
const PAGE_CAPACITY: usize = 512;
const FAVICON_CAPACITY: usize = 256;

fn is_due<V>(lookup: Option<&Lookup<V>>, now: Instant) -> bool {
    let Some(lookup) = lookup else {
        return true;
    };
    let wait = if lookup.failed {
        FAILURE_RETRY
    } else {
        SUCCESS_KEPT
    };
    now.saturating_duration_since(lookup.checked_at) >= wait
}

/// The URL a link's page is fetched and cached by: the link without its fragment, when that is a
/// destination zashiki may fetch.
fn page_url(link: &SessionLink) -> Option<Url> {
    if link.kind != SessionLinkKind::Other || link.github.is_some() {
        return None;
    }
    let mut url = Url::parse(&link.url).ok()?;
    url.set_fragment(None);
    is_fetchable_url(&url).then_some(url)
}

pub(crate) type PageFetch = Fetch<Url, PageDetails>;
pub(crate) type FaviconFetch = Fetch<Url, Arc<Favicon>>;

pub struct PageDetailsCache {
    pages: LookupQueue<String, Url, PageDetails>,
    /// Keyed by origin (`https://example.com`).
    favicons: LookupQueue<String, Url, Arc<Favicon>>,
}

async fn off_runtime<T: Send + 'static>(
    fetch: impl FnOnce() -> Option<T> + Send + 'static,
) -> Option<T> {
    tokio::task::spawn_blocking(fetch).await.ok().flatten()
}

impl Default for PageDetailsCache {
    fn default() -> Self {
        Self::with_fetch(
            Arc::new(|url| Box::pin(off_runtime(move || fetch_page(url)))),
            Arc::new(|url| Box::pin(off_runtime(move || fetch_favicon(url).map(Arc::new)))),
            Arc::new(Instant::now),
        )
    }
}

impl PageDetailsCache {
    pub(crate) fn with_fetch(pages: PageFetch, favicons: FaviconFetch, now: Clock) -> Self {
        let limits = |capacity| LookupLimits {
            capacity,
            concurrent: MAX_CONCURRENT_FETCHES,
            timeout: LOOKUP_TIMEOUT,
        };
        Self {
            pages: LookupQueue::new(limits(PAGE_CAPACITY), is_due, pages, Arc::clone(&now)),
            favicons: LookupQueue::new(limits(FAVICON_CAPACITY), is_due, favicons, now),
        }
    }

    /// Fills `other` links in from the cache and starts fetches for what is missing or stale, without
    /// waiting for them. Must run inside a Tokio runtime.
    pub fn annotate(&self, links: &mut [SessionLink]) {
        let lookable: Vec<(&mut SessionLink, Url)> = links
            .iter_mut()
            .filter_map(|link| {
                let url = page_url(link)?;
                Some((link, url))
            })
            .collect();
        let items = lookable
            .iter()
            .map(|(_, url)| (url.as_str().to_owned(), url.clone()))
            .collect();
        let pages = self.pages.read(items);

        let mut with_favicon = Vec::new();
        for ((link, _), page) in lookable.into_iter().zip(pages) {
            let Some(page) = page else {
                continue;
            };
            link.page_title = page.title;
            if let Some(icon) = page.favicon_url {
                with_favicon.push((link, page.favicon_origin, icon));
            }
        }
        let items = with_favicon
            .iter()
            .map(|(_, origin, icon)| (origin.clone(), icon.clone()))
            .collect();
        let favicons = self.favicons.read(items);
        for ((link, origin, _), favicon) in with_favicon.into_iter().zip(favicons) {
            if favicon.is_some() {
                link.favicon_origin = Some(origin);
            }
        }
    }

    /// The favicon already cached for `origin`; never starts a fetch.
    pub fn favicon(&self, origin: &str) -> Option<Arc<Favicon>> {
        self.favicons.cached(&origin.to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{GithubLinkRef, SessionLinkTab};
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
    use std::sync::Mutex;

    static BASE: std::sync::LazyLock<Instant> = std::sync::LazyLock::new(Instant::now);

    fn at(ms: u64) -> Instant {
        *BASE + Duration::from_millis(ms)
    }

    fn ms(duration: Duration) -> u64 {
        duration.as_millis() as u64
    }

    fn checked(at_ms: u64, failed: bool) -> Lookup<()> {
        Lookup {
            details: (!failed).then_some(()),
            checked_at: at(at_ms),
            failed,
        }
    }

    #[test]
    fn a_lookup_is_given_at_least_as_long_as_the_fetch_may_take() {
        assert!(LOOKUP_TIMEOUT > FETCH_LIMIT);
    }

    #[test]
    fn a_page_never_fetched_is_due() {
        assert!(is_due::<()>(None, at(0)));
    }

    #[test]
    fn a_fetched_page_is_kept_for_a_day() {
        let lookup = checked(1_000, false);
        assert!(!is_due(Some(&lookup), at(1_000 + ms(SUCCESS_KEPT) - 1)));
        assert!(is_due(Some(&lookup), at(1_000 + ms(SUCCESS_KEPT))));
    }

    #[test]
    fn a_failed_fetch_is_retried_after_five_minutes() {
        let lookup = checked(1_000, true);
        assert!(!is_due(Some(&lookup), at(1_000 + ms(FAILURE_RETRY) - 1)));
        assert!(is_due(Some(&lookup), at(1_000 + ms(FAILURE_RETRY))));
    }

    fn other(url: &str) -> SessionLink {
        SessionLink {
            url: url.into(),
            tab: SessionLinkTab::AiReferenced,
            kind: SessionLinkKind::Other,
            source: "WebFetch".into(),
            title: None,
            github: None,
            page_title: None,
            favicon_origin: None,
        }
    }

    fn page(title: &str, origin: &str) -> PageDetails {
        PageDetails {
            title: Some(title.into()),
            favicon_origin: origin.into(),
            favicon_url: Some(Url::parse(&format!("{origin}/favicon.ico")).unwrap()),
        }
    }

    fn png() -> Arc<Favicon> {
        Arc::new(Favicon {
            content_type: "image/png".into(),
            bytes: vec![0x89, b'P', b'N', b'G'],
        })
    }

    struct Fake {
        cache: PageDetailsCache,
        page_calls: Arc<Mutex<Vec<String>>>,
        favicon_calls: Arc<AtomicUsize>,
        clock: Arc<AtomicU64>,
    }

    fn fake(
        page_answer: impl Fn(&Url) -> Option<PageDetails> + Send + Sync + 'static,
        favicon_answer: Option<Arc<Favicon>>,
    ) -> Fake {
        let page_calls = Arc::new(Mutex::new(Vec::new()));
        let favicon_calls = Arc::new(AtomicUsize::new(0));
        let clock = Arc::new(AtomicU64::new(0));
        let (seen, counted) = (Arc::clone(&page_calls), Arc::clone(&favicon_calls));
        let page_answer = Arc::new(page_answer);
        let pages: PageFetch = Arc::new(move |url: Url| {
            seen.lock().unwrap().push(url.to_string());
            let answer = page_answer(&url);
            Box::pin(async move { answer })
        });
        let favicons: FaviconFetch = Arc::new(move |_| {
            counted.fetch_add(1, Ordering::SeqCst);
            let answer = favicon_answer.clone();
            Box::pin(async move { answer })
        });
        let now = Arc::clone(&clock);
        let cache = PageDetailsCache::with_fetch(
            pages,
            favicons,
            Arc::new(move || at(now.load(Ordering::SeqCst))),
        );
        Fake {
            cache,
            page_calls,
            favicon_calls,
            clock,
        }
    }

    async fn settle(cache: &PageDetailsCache) {
        cache.pages.settle().await;
        cache.favicons.settle().await;
    }

    fn annotated(cache: &PageDetailsCache, links: &[SessionLink]) -> Vec<SessionLink> {
        let mut links = links.to_vec();
        cache.annotate(&mut links);
        links
    }

    #[tokio::test]
    async fn a_page_title_shows_on_a_read_after_the_fetch_and_its_favicon_on_the_next() {
        let f = fake(
            |_| Some(page("Example", "https://example.com")),
            Some(png()),
        );
        let links = [other("https://example.com/a")];

        let first = annotated(&f.cache, &links);
        assert_eq!(first[0].page_title, None);
        settle(&f.cache).await;

        let second = annotated(&f.cache, &links);
        assert_eq!(second[0].page_title.as_deref(), Some("Example"));
        assert_eq!(second[0].favicon_origin, None);
        settle(&f.cache).await;

        let third = annotated(&f.cache, &links);
        assert_eq!(
            third[0].favicon_origin.as_deref(),
            Some("https://example.com")
        );
        assert_eq!(f.cache.favicon("https://example.com"), Some(png()));
    }

    #[tokio::test]
    async fn a_favicon_that_could_not_be_fetched_is_not_offered() {
        let f = fake(|_| Some(page("Example", "https://example.com")), None);
        let links = [other("https://example.com/a")];
        for _ in 0..3 {
            annotated(&f.cache, &links);
            settle(&f.cache).await;
        }
        let shown = annotated(&f.cache, &links);
        assert_eq!(shown[0].page_title.as_deref(), Some("Example"));
        assert_eq!(shown[0].favicon_origin, None);
        assert_eq!(f.cache.favicon("https://example.com"), None);
        assert_eq!(f.favicon_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn pages_on_one_origin_share_one_favicon_fetch() {
        let f = fake(|_| Some(page("x", "https://example.com")), Some(png()));
        let links = [
            other("https://example.com/a"),
            other("https://example.com/b"),
        ];
        for _ in 0..3 {
            annotated(&f.cache, &links);
            settle(&f.cache).await;
        }
        assert_eq!(f.favicon_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn urls_differing_only_in_their_fragment_are_fetched_once_without_it() {
        let f = fake(|_| Some(page("x", "https://example.com")), None);
        annotated(
            &f.cache,
            &[
                other("https://example.com/a#one"),
                other("https://example.com/a#two"),
            ],
        );
        settle(&f.cache).await;
        assert_eq!(*f.page_calls.lock().unwrap(), vec!["https://example.com/a"]);
    }

    #[tokio::test]
    async fn links_zashiki_may_not_fetch_or_that_are_github_items_are_left_alone() {
        let f = fake(|_| Some(page("x", "https://example.com")), Some(png()));
        let mut github = other("https://github.com/o/r/pull/1");
        github.kind = SessionLinkKind::Pr;
        github.github = Some(GithubLinkRef {
            owner: "o".into(),
            repo: "r".into(),
            number: 1,
            ..Default::default()
        });
        let links = [
            github,
            other("http://localhost:5173/"),
            other("http://127.0.0.1/"),
            other("http://192.168.0.10/"),
            other("http://printer.local/"),
            other("https://user:pw@example.com/"),
            other("https://example.com:8443/"),
            other("ftp://example.com/"),
            other("not a url"),
        ];
        annotated(&f.cache, &links);
        settle(&f.cache).await;
        assert!(f.page_calls.lock().unwrap().is_empty());
        assert_eq!(annotated(&f.cache, &links), links.to_vec());
    }

    #[tokio::test]
    async fn a_failed_page_fetch_is_retried_after_five_minutes() {
        let f = fake(|_| None, None);
        let links = [other("https://example.com/")];
        annotated(&f.cache, &links);
        settle(&f.cache).await;
        annotated(&f.cache, &links);
        settle(&f.cache).await;
        assert_eq!(f.page_calls.lock().unwrap().len(), 1);
        f.clock.store(ms(FAILURE_RETRY), Ordering::SeqCst);
        annotated(&f.cache, &links);
        settle(&f.cache).await;
        assert_eq!(f.page_calls.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn a_page_redirected_elsewhere_takes_the_favicon_of_where_it_landed() {
        let f = fake(
            |_| Some(page("Landed", "https://landed.example.org")),
            Some(png()),
        );
        let links = [other("https://short.example/abc")];
        for _ in 0..2 {
            annotated(&f.cache, &links);
            settle(&f.cache).await;
        }
        let shown = annotated(&f.cache, &links);
        assert_eq!(
            shown[0].favicon_origin.as_deref(),
            Some("https://landed.example.org")
        );
    }
}
