//! Where the main window may go. The WebView reports navigations of the page and of every frame in
//! it alike, with nothing but the target URL, so one decision covers both.

use tauri::Url;

/// Whether the window (or a frame in it) may go to `url` in place. `allowed` holds serialized web
/// origins (`scheme://host:port`, see [`web_origin`]). The shell's own startup and error pages are
/// `data:` URLs, which are let through only while `showing_shell_page`. Everything else is refused
/// rather than handed to the browser: a navigation here may be a script's, not the user's click.
pub fn may_navigate(url: &Url, allowed: &[String], showing_shell_page: bool) -> bool {
    let is_allowed = || web_origin(url).is_some_and(|origin| allowed.contains(&origin));
    match url.scheme() {
        "http" | "https" | "blob" => is_allowed(),
        "about" => matches!(url.path(), "blank" | "srcdoc"),
        "data" => showing_shell_page,
        _ => false,
    }
}

/// The main window's navigation guard. The shell's pages may be shown until the window first moves
/// onto the app, which is decided here rather than by when the shell asks for that move, so a
/// startup page that is still loading when the app is ready is not refused.
pub struct Guard {
    app_origins: Vec<String>,
    showing_shell_page: std::sync::atomic::AtomicBool,
}

impl Guard {
    pub fn new(app_origins: Vec<String>) -> Self {
        Self {
            app_origins,
            showing_shell_page: std::sync::atomic::AtomicBool::new(true),
        }
    }

    pub fn app_origins(&self) -> &[String] {
        &self.app_origins
    }

    /// [`may_navigate`] against the app's origins plus `extra_origin` (the dashboard's).
    pub fn allows(&self, url: &Url, extra_origin: Option<String>) -> bool {
        use std::sync::atomic::Ordering;
        if matches!(url.scheme(), "http" | "https") && may_navigate(url, &self.app_origins, false) {
            self.showing_shell_page.store(false, Ordering::SeqCst);
            return true;
        }
        let mut allowed = self.app_origins.clone();
        allowed.extend(extra_origin);
        may_navigate(
            url,
            &allowed,
            self.showing_shell_page.load(Ordering::SeqCst),
        )
    }
}

/// Requests to open a new window never get one: a second WebView would sit outside the
/// navigation guard. Web links go to the default browser instead, and this is the one place a link
/// reaches it. Only the app's own page asks for windows by script: the frames that run other
/// content's scripts (the dashboard, the HTML preview) are sandboxed without `allow-popups`. The
/// app's own origins are kept out of it, since their URLs can carry the access token.
pub fn opens_in_browser(url: &Url, app_origins: &[String]) -> bool {
    matches!(url.scheme(), "http" | "https")
        && web_origin(url).is_some_and(|origin| !app_origins.contains(&origin))
}

/// The origins the window is served from: the page's own origin, and the server's, which differs
/// in development where the page comes from the Vite dev server but media still streams from the
/// server.
pub fn app_origins(page_url: &str, server_port: u16) -> Vec<String> {
    let mut origins = Vec::new();
    let server = format!("http://127.0.0.1:{server_port}");
    for url in [page_url, server.as_str()] {
        if let Some(origin) = Url::parse(url).ok().as_ref().and_then(web_origin) {
            if !origins.contains(&origin) {
                origins.push(origin);
            }
        }
    }
    origins
}

/// The http(s) origin a URL belongs to (a `blob:` URL belongs to the origin that created it), or
/// None for anything that has no web origin of its own.
pub fn web_origin(url: &Url) -> Option<String> {
    let origin = url.origin();
    let serialized = origin.ascii_serialization();
    let is_web = serialized.starts_with("http://") || serialized.starts_with("https://");
    (origin.is_tuple() && is_web).then_some(serialized)
}

/// [`web_origin`] of an address given as text, such as the URL the window is opened on.
pub fn web_origin_of(url: &str) -> Option<String> {
    web_origin(&Url::parse(url).ok()?)
}

/// The origin of the configured dashboard page, which the dashboard overlay frames in the window.
/// Only an http(s) address counts; anything else (empty, a local file, another scheme) is None.
pub fn dashboard_origin(dashboard_url: &str) -> Option<String> {
    let url = Url::parse(dashboard_url.trim()).ok()?;
    matches!(url.scheme(), "http" | "https")
        .then(|| web_origin(&url))
        .flatten()
}

pub fn open_in_browser(url: &Url) {
    #[cfg(target_os = "macos")]
    let opener = "open";
    #[cfg(not(target_os = "macos"))]
    let opener = "xdg-open";
    let url = url.to_string();
    std::thread::spawn(move || {
        if let Err(e) = std::process::Command::new(opener).arg(&url).status() {
            eprintln!("zashiki: could not open {url} in the default browser: {e}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    fn served_from(page: &str) -> Vec<String> {
        app_origins(page, 8790)
    }

    #[test]
    fn stays_on_the_origin_the_app_is_served_from() {
        let allowed = served_from("http://127.0.0.1:8790");
        for target in [
            "http://127.0.0.1:8790/?token=abc",
            "http://127.0.0.1:8790/api/media?path=a.pdf",
            "http://127.0.0.1:8790/#memo",
        ] {
            assert!(may_navigate(&url(target), &allowed, false), "{target}");
        }
    }

    #[test]
    fn refuses_other_web_origins_in_place() {
        let allowed = served_from("http://127.0.0.1:8790");
        for target in [
            "https://example.com/",
            "http://127.0.0.1:5173/",
            "http://127.0.0.1:8791/",
            "http://localhost:8790/",
            "https://127.0.0.1:8790/",
            "http://evil.example/http://127.0.0.1:8790/",
        ] {
            assert!(!may_navigate(&url(target), &allowed, false), "{target}");
        }
    }

    #[test]
    fn development_serves_the_page_from_vite_and_media_from_the_server() {
        let allowed = served_from("http://localhost:5173");
        assert!(may_navigate(
            &url("http://localhost:5173/"),
            &allowed,
            false
        ));
        assert!(may_navigate(
            &url("http://127.0.0.1:8790/api/media?path=a.pdf"),
            &allowed,
            false
        ));
        assert!(!may_navigate(
            &url("http://localhost:3000/"),
            &allowed,
            false
        ));
    }

    #[test]
    fn an_extra_allowed_origin_is_stayed_on() {
        let mut allowed = served_from("http://127.0.0.1:8790");
        allowed.extend(dashboard_origin("https://dash.example/board?x=1"));
        assert!(may_navigate(
            &url("https://dash.example/board"),
            &allowed,
            false
        ));
        assert!(!may_navigate(
            &url("https://other.example/"),
            &allowed,
            false
        ));
    }

    #[test]
    fn frames_the_app_creates_itself_stay() {
        let allowed = served_from("http://127.0.0.1:8790");
        for target in [
            "about:blank",
            "about:srcdoc",
            "blob:http://127.0.0.1:8790/5d1f0f3e-2b8c-4a43-9d9a-3f1c2b7e6a10",
        ] {
            assert!(may_navigate(&url(target), &allowed, false), "{target}");
        }
    }

    #[test]
    fn refuses_every_other_scheme() {
        let allowed = served_from("http://127.0.0.1:8790");
        for target in [
            "blob:https://example.com/5d1f0f3e-2b8c-4a43-9d9a-3f1c2b7e6a10",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,<h1>Zashiki</h1>",
            "about:config",
            "vscode://file/a",
            "ftp://example.com/",
        ] {
            assert!(!may_navigate(&url(target), &allowed, false), "{target}");
        }
    }

    #[test]
    fn shell_pages_are_shown_only_before_the_app_is_loaded() {
        let allowed = served_from("http://127.0.0.1:8790");
        let page = url("data:text/html;charset=utf-8,%3Ch1%3E");
        assert!(may_navigate(&page, &allowed, true));
        assert!(!may_navigate(&page, &allowed, false));
    }

    #[test]
    fn the_guard_shows_shell_pages_until_the_window_moves_onto_the_app() {
        let guard = Guard::new(served_from("http://127.0.0.1:8790"));
        let loading = url("data:text/html;charset=utf-8,%3Ch1%3Eloading");
        let error = url("data:text/html;charset=utf-8,%3Ch1%3Eerror");
        assert!(guard.allows(&loading, None));
        assert!(!guard.allows(&url("https://example.com/"), None));
        assert!(
            guard.allows(&error, None),
            "a refused navigation is not the app"
        );
        assert!(guard.allows(&url("http://127.0.0.1:8790/?token=abc"), None));
        assert!(!guard.allows(&loading, None));
    }

    #[test]
    fn the_guard_lets_the_extra_origin_through_without_counting_it_as_the_app() {
        let guard = Guard::new(served_from("http://127.0.0.1:8790"));
        let dashboard = dashboard_origin("https://dash.example/board");
        assert!(guard.allows(&url("https://dash.example/board"), dashboard.clone()));
        assert!(!guard.allows(&url("https://dash.example/board"), None));
        assert!(guard.allows(&url("data:text/html,x"), dashboard));
    }

    #[test]
    fn new_windows_open_web_links_in_the_browser_and_nothing_else() {
        let app = served_from("http://localhost:5173");
        assert!(opens_in_browser(
            &url("https://github.com/kounetsuman/zashiki/issues/new"),
            &app
        ));
        assert!(opens_in_browser(&url("http://127.0.0.1:8791/"), &app));
        for target in ["about:blank", "file:///etc/passwd", "javascript:alert(1)"] {
            assert!(!opens_in_browser(&url(target), &app), "{target}");
        }
    }

    #[test]
    fn new_windows_never_take_the_app_s_own_urls_to_the_browser() {
        let app = served_from("http://localhost:5173");
        for target in [
            "http://localhost:5173/?token=abc",
            "http://127.0.0.1:8790/api/media?path=a.pdf&token=abc",
        ] {
            assert!(!opens_in_browser(&url(target), &app), "{target}");
        }
    }

    #[test]
    fn dashboard_origin_takes_only_web_addresses() {
        assert_eq!(
            dashboard_origin(" https://dash.example:8443/board?x=1 ").as_deref(),
            Some("https://dash.example:8443")
        );
        assert_eq!(
            dashboard_origin("http://localhost:3000/").as_deref(),
            Some("http://localhost:3000")
        );
        for value in [
            "",
            "dashboard.html",
            "~/dash.html",
            "file:///Users/me/dash.html",
            "tauri://localhost",
            "blob:https://dash.example/5d1f0f3e",
            "javascript:alert(1)",
            "data:text/html,x",
        ] {
            assert_eq!(dashboard_origin(value), None, "{value}");
        }
    }

    #[test]
    fn app_origins_does_not_repeat_the_server_origin() {
        assert_eq!(served_from("http://127.0.0.1:8790").len(), 1);
        assert_eq!(served_from("http://localhost:5173").len(), 2);
        assert_eq!(served_from("not a url").len(), 1);
    }
}
