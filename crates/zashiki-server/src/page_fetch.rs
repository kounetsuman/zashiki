//! Fetching a public web page's title and favicon. Every request goes only to a destination
//! `public_destination` allows: the URL is checked before each hop, and the host's resolved addresses
//! are checked and then connected to as they are, so a second DNS answer cannot slip in between.

use std::io::{self, Read};
use std::net::{SocketAddr, ToSocketAddrs};
use std::sync::OnceLock;
use std::time::Duration;

use url::Url;

use crate::page_meta::{favicon_url, image_type, is_html, page_title};
use crate::public_destination::{is_fetchable_url, public_addrs};

const MAX_REDIRECTS: usize = 3;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const PAGE_MAX_BYTES: u64 = 256 * 1024;
const FAVICON_MAX_BYTES: u64 = 64 * 1024;
const USER_AGENT: &str = "zashiki";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageDetails {
    pub title: Option<String>,
    /// The origin the page was finally served from, which its favicon is cached under.
    pub favicon_origin: String,
    pub favicon_url: Option<Url>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Favicon {
    pub content_type: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Response {
    pub status: u16,
    pub location: Option<String>,
    pub content_type: String,
    pub body: Vec<u8>,
    /// The body went on past the read limit and was cut there.
    pub cut: bool,
}

/// Requests `url` and follows up to three redirects, refusing any hop that is not fetchable. The
/// final URL and response are returned only for a 2xx answer.
pub(crate) fn follow(
    mut url: Url,
    mut send: impl FnMut(&Url) -> Option<Response>,
) -> Option<(Url, Response)> {
    for _ in 0..=MAX_REDIRECTS {
        url.set_fragment(None);
        if !is_fetchable_url(&url) {
            return None;
        }
        let response = send(&url)?;
        if !(300..400).contains(&response.status) {
            return (200..300)
                .contains(&response.status)
                .then_some((url, response));
        }
        url = url.join(response.location.as_deref()?).ok()?;
    }
    None
}

pub(crate) fn page_details(final_url: &Url, response: &Response) -> PageDetails {
    let html = is_html(&response.content_type).then(|| String::from_utf8_lossy(&response.body));
    PageDetails {
        title: html.as_deref().and_then(page_title),
        favicon_origin: final_url.origin().ascii_serialization(),
        favicon_url: favicon_url(final_url, html.as_deref()),
    }
}

pub(crate) fn favicon(response: Response) -> Option<Favicon> {
    let content_type = image_type(&response.content_type)?;
    (!response.cut && !response.body.is_empty()).then_some(Favicon {
        content_type,
        bytes: response.body,
    })
}

/// Hands ureq only the addresses it has checked, so the connection goes to one of them.
struct PublicOnlyResolver;

impl ureq::Resolver for PublicOnlyResolver {
    fn resolve(&self, netloc: &str) -> io::Result<Vec<SocketAddr>> {
        let addrs = netloc.to_socket_addrs()?.collect();
        public_addrs(addrs)
            .ok_or_else(|| io::Error::new(io::ErrorKind::PermissionDenied, "not a public address"))
    }
}

/// No cookie store, no proxy, and redirects left to `follow`.
fn agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        ureq::AgentBuilder::new()
            .resolver(PublicOnlyResolver)
            .try_proxy_from_env(false)
            .redirects(0)
            .timeout(REQUEST_TIMEOUT)
            .user_agent(USER_AGENT)
            .build()
    })
}

fn send(url: &Url, accept: &str, max_bytes: u64) -> Option<Response> {
    let response = match agent().request_url("GET", url).set("Accept", accept).call() {
        Ok(response) => response,
        Err(ureq::Error::Status(status, _)) => {
            return Some(Response {
                status,
                ..Response::default()
            })
        }
        Err(ureq::Error::Transport(_)) => return None,
    };
    let status = response.status();
    let location = response.header("location").map(str::to_owned);
    let content_type = response.header("content-type").unwrap_or("").to_owned();
    let mut body = Vec::new();
    if (200..300).contains(&status) {
        response
            .into_reader()
            .take(max_bytes + 1)
            .read_to_end(&mut body)
            .ok()?;
    }
    let cut = body.len() as u64 > max_bytes;
    body.truncate(max_bytes as usize);
    Some(Response {
        status,
        location,
        content_type,
        body,
        cut,
    })
}

/// Blocking: run it off the async runtime.
pub(crate) fn fetch_page(url: Url) -> Option<PageDetails> {
    let (final_url, response) = follow(url, |url| {
        send(url, "text/html,application/xhtml+xml", PAGE_MAX_BYTES)
    })?;
    Some(page_details(&final_url, &response))
}

/// Blocking: run it off the async runtime.
pub(crate) fn fetch_favicon(url: Url) -> Option<Favicon> {
    let (_, response) = follow(url, |url| send(url, "image/*", FAVICON_MAX_BYTES))?;
    favicon(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ureq::Resolver;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    fn ok(content_type: &str, body: &str) -> Response {
        Response {
            status: 200,
            content_type: content_type.into(),
            body: body.as_bytes().to_vec(),
            ..Response::default()
        }
    }

    fn redirect(to: &str) -> Response {
        Response {
            status: 301,
            location: Some(to.into()),
            ..Response::default()
        }
    }

    /// Answers each request with the next response in turn, recording the URLs asked for.
    type Asked = std::rc::Rc<std::cell::RefCell<Vec<String>>>;

    fn scripted(responses: Vec<Response>) -> (impl FnMut(&Url) -> Option<Response>, Asked) {
        let asked = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
        let log = std::rc::Rc::clone(&asked);
        let mut responses = responses.into_iter();
        let send = move |u: &Url| {
            log.borrow_mut().push(u.to_string());
            responses.next()
        };
        (send, asked)
    }

    #[test]
    fn a_direct_answer_is_returned_with_its_url() {
        let (send, asked) = scripted(vec![ok("text/html", "x")]);
        let (final_url, response) = follow(url("https://example.com/a#frag"), send).unwrap();
        assert_eq!(final_url.as_str(), "https://example.com/a");
        assert_eq!(response.body, b"x");
        assert_eq!(*asked.borrow(), vec!["https://example.com/a"]);
    }

    #[test]
    fn up_to_three_redirects_are_followed_relative_to_each_hop() {
        let (send, asked) = scripted(vec![
            redirect("/b"),
            redirect("https://other.example.org/c"),
            redirect("d"),
            ok("text/html", ""),
        ]);
        let (final_url, _) = follow(url("https://example.com/a"), send).unwrap();
        assert_eq!(final_url.as_str(), "https://other.example.org/d");
        assert_eq!(asked.borrow().len(), 4);
    }

    #[test]
    fn a_fourth_redirect_is_not_followed() {
        let (send, asked) = scripted(vec![
            redirect("/1"),
            redirect("/2"),
            redirect("/3"),
            redirect("/4"),
            ok("text/html", ""),
        ]);
        assert_eq!(follow(url("https://example.com/"), send), None);
        assert_eq!(asked.borrow().len(), 4);
    }

    #[test]
    fn a_redirect_to_a_destination_that_is_not_allowed_is_never_requested() {
        for to in [
            "http://127.0.0.1/",
            "http://localhost/admin",
            "http://169.254.169.254/latest/meta-data",
            "https://user:pw@example.com/",
            "https://example.com:8443/",
            "file:///etc/passwd",
        ] {
            let (send, asked) = scripted(vec![redirect(to), ok("text/html", "")]);
            assert_eq!(follow(url("https://example.com/"), send), None, "{to}");
            assert_eq!(asked.borrow().len(), 1, "{to}");
        }
    }

    #[test]
    fn a_start_url_that_is_not_allowed_is_never_requested() {
        let (send, asked) = scripted(vec![ok("text/html", "")]);
        assert_eq!(follow(url("http://10.0.0.1/"), send), None);
        assert!(asked.borrow().is_empty());
    }

    #[test]
    fn error_statuses_and_redirects_without_a_location_give_nothing() {
        for response in [
            Response {
                status: 404,
                ..Response::default()
            },
            Response {
                status: 500,
                ..Response::default()
            },
            Response {
                status: 302,
                ..Response::default()
            },
        ] {
            let (send, _) = scripted(vec![response]);
            assert_eq!(follow(url("https://example.com/"), send), None);
        }
    }

    #[test]
    fn a_page_gives_its_title_and_favicon_from_the_url_it_was_served_from() {
        let html = r#"<title>Hello</title><link rel="icon" href="/i.png">"#;
        let details = page_details(
            &url("https://www.example.com/x"),
            &ok("text/html; charset=utf-8", html),
        );
        assert_eq!(
            details,
            PageDetails {
                title: Some("Hello".into()),
                favicon_origin: "https://www.example.com".into(),
                favicon_url: Some(url("https://www.example.com/i.png")),
            }
        );
    }

    #[test]
    fn a_response_that_is_not_html_has_no_title_but_may_have_a_favicon_ico() {
        let details = page_details(
            &url("https://example.com/doc.pdf"),
            &ok("application/pdf", "<title>no</title>"),
        );
        assert_eq!(details.title, None);
        assert_eq!(
            details.favicon_url,
            Some(url("https://example.com/favicon.ico"))
        );
    }

    #[test]
    fn a_favicon_is_kept_only_as_a_whole_image() {
        let image = Response {
            body: vec![1, 2, 3],
            ..ok("image/png", "")
        };
        assert_eq!(
            favicon(image.clone()),
            Some(Favicon {
                content_type: "image/png".into(),
                bytes: vec![1, 2, 3],
            })
        );
        assert_eq!(
            favicon(Response {
                cut: true,
                ..image.clone()
            }),
            None
        );
        assert_eq!(
            favicon(Response {
                body: vec![],
                ..image.clone()
            }),
            None
        );
        assert_eq!(
            favicon(Response {
                content_type: "text/html".into(),
                ..image
            }),
            None
        );
    }

    #[test]
    fn the_resolver_hands_back_only_public_addresses() {
        assert_eq!(
            PublicOnlyResolver.resolve("93.184.216.34:443").unwrap(),
            vec!["93.184.216.34:443".parse::<SocketAddr>().unwrap()]
        );
        for netloc in [
            "127.0.0.1:443",
            "[::1]:443",
            "10.0.0.1:80",
            "93.184.216.34:22",
        ] {
            let err = PublicOnlyResolver.resolve(netloc).unwrap_err();
            assert_eq!(err.kind(), io::ErrorKind::PermissionDenied, "{netloc}");
        }
    }
}
