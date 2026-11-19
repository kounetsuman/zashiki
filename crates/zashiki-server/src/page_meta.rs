//! A web page's title and favicon location, read from the start of its HTML.

use url::Url;

use crate::public_destination::is_fetchable_url;

const TITLE_MAX_CHARS: usize = 200;

/// `<title>`, else `og:title`, decoded and on one line. A title the page's bytes could not be read
/// as UTF-8 for is dropped rather than shown garbled.
pub(crate) fn page_title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let from_element =
        title_element(html, &lower).and_then(|raw| clean_title(&decode_entities(raw)));
    from_element.or_else(|| {
        start_tags(html, &lower, "meta")
            .find(|attrs| {
                ["property", "name"].iter().any(|name| {
                    attr(attrs, name).is_some_and(|v| v.eq_ignore_ascii_case("og:title"))
                })
            })
            .and_then(|attrs| clean_title(attr(&attrs, "content")?))
    })
}

/// The `<title>` in the head: one after `</head>` or `<body>` belongs to something in the body, such
/// as an inline SVG.
fn title_element<'a>(html: &'a str, lower: &str) -> Option<&'a str> {
    let head_end = [lower.find("</head"), tag_starts(lower, "body").next()]
        .into_iter()
        .flatten()
        .min()
        .unwrap_or(lower.len());
    let open = tag_starts(lower, "title")
        .next()
        .filter(|&open| open < head_end)?;
    let content_start = open + lower[open..].find('>')? + 1;
    let content_end = content_start + lower[content_start..].find("</title")?;
    Some(&html[content_start..content_end])
}

fn clean_title(decoded: &str) -> Option<String> {
    let title: String = decoded
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(TITLE_MAX_CHARS)
        .collect();
    (!title.is_empty() && !title.contains('\u{FFFD}')).then_some(title)
}

/// `icon` (also as in `shortcut icon`) or `apple-touch-icon`; a monochrome `mask-icon` is no favicon.
fn names_an_icon(rel: &str) -> bool {
    rel.split_ascii_whitespace().any(|token| {
        token.eq_ignore_ascii_case("icon") || token.eq_ignore_ascii_case("apple-touch-icon")
    })
}

/// The first `<link>` whose `rel` names an icon, resolved against the page, else the origin's
/// `/favicon.ico`. Only a fetchable URL is returned.
pub(crate) fn favicon_url(page: &Url, html: Option<&str>) -> Option<Url> {
    let linked = html.and_then(|html| {
        let lower = html.to_ascii_lowercase();
        let attrs = start_tags(html, &lower, "link")
            .find(|attrs| attr(attrs, "rel").is_some_and(names_an_icon))?;
        let href = attr(&attrs, "href").filter(|href| !href.trim().is_empty())?;
        page.join(href.trim()).ok()
    });
    linked
        .filter(is_fetchable_url)
        .or_else(|| page.join("/favicon.ico").ok().filter(is_fetchable_url))
}

fn media_type_essence(content_type: &str) -> String {
    content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

pub(crate) fn is_html(content_type: &str) -> bool {
    matches!(
        media_type_essence(content_type).as_str(),
        "text/html" | "application/xhtml+xml"
    )
}

/// The `image/…` media type to serve a favicon with, without parameters.
pub(crate) fn image_type(content_type: &str) -> Option<String> {
    let essence = media_type_essence(content_type);
    let subtype = essence.strip_prefix("image/")?;
    let plain = !subtype.is_empty()
        && subtype
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'+' | b'-'));
    plain.then_some(essence)
}

/// Byte offsets of each `<name` that starts a tag of that name. `lower` is `html` lower-cased, which
/// keeps every byte offset.
fn tag_starts<'a>(lower: &'a str, name: &'a str) -> impl Iterator<Item = usize> + 'a {
    let open = format!("<{name}");
    lower.match_indices('<').map(|(i, _)| i).filter(move |&i| {
        lower[i..].starts_with(&open)
            && lower[i + open.len()..]
                .bytes()
                .next()
                .is_some_and(|b| b.is_ascii_whitespace() || matches!(b, b'>' | b'/'))
    })
}

type Attrs = Vec<(String, String)>;

/// The longest start tag read; a longer one is read up to here.
const TAG_MAX_BYTES: usize = 8 * 1024;

/// The attributes of each `<name …>` start tag, names lower-cased and values entity-decoded. A tag
/// is read no further than the next `<`, so unclosed tags cost no more than the body's length.
fn start_tags<'a>(
    html: &'a str,
    lower: &'a str,
    name: &'a str,
) -> impl Iterator<Item = Attrs> + 'a {
    tag_starts(lower, name).map(move |i| {
        let rest = &html[i + name.len() + 1..];
        let mut end = rest.find('<').unwrap_or(rest.len()).min(TAG_MAX_BYTES);
        while !rest.is_char_boundary(end) {
            end -= 1;
        }
        parse_attrs(&rest[..end])
    })
}

fn parse_attrs(rest: &str) -> Attrs {
    let mut attrs = Vec::new();
    let mut chars = rest.char_indices().peekable();
    loop {
        while chars
            .next_if(|(_, c)| c.is_whitespace() || *c == '/')
            .is_some()
        {}
        let Some(&(start, c)) = chars.peek() else {
            return attrs;
        };
        if c == '>' {
            return attrs;
        }
        let mut end = start;
        while let Some((i, c)) =
            chars.next_if(|(_, c)| !c.is_whitespace() && !matches!(c, '=' | '>' | '/'))
        {
            end = i + c.len_utf8();
        }
        let name = rest[start..end].to_ascii_lowercase();
        while chars.next_if(|(_, c)| c.is_whitespace()).is_some() {}
        let mut value = String::new();
        let has_value = chars.next_if(|(_, c)| *c == '=').is_some();
        if has_value {
            while chars.next_if(|(_, c)| c.is_whitespace()).is_some() {}
            match chars.peek().map(|&(_, c)| c) {
                Some(quote @ ('"' | '\'')) => {
                    chars.next();
                    for (_, c) in chars.by_ref() {
                        if c == quote {
                            break;
                        }
                        value.push(c);
                    }
                }
                _ => {
                    while let Some((_, c)) = chars.next_if(|(_, c)| !c.is_whitespace() && *c != '>')
                    {
                        value.push(c);
                    }
                }
            }
        }
        if name.is_empty() {
            if !has_value {
                chars.next();
            }
            continue;
        }
        attrs.push((name, decode_entities(&value)));
    }
}

fn attr<'a>(attrs: &'a Attrs, name: &str) -> Option<&'a str> {
    attrs
        .iter()
        .find(|(n, _)| n == name)
        .map(|(_, v)| v.as_str())
}

const NAMED_ENTITIES: [(&str, char); 22] = [
    ("amp", '&'),
    ("lt", '<'),
    ("gt", '>'),
    ("quot", '"'),
    ("apos", '\''),
    ("nbsp", '\u{a0}'),
    ("ndash", '\u{2013}'),
    ("mdash", '\u{2014}'),
    ("hellip", '\u{2026}'),
    ("middot", '\u{b7}'),
    ("bull", '\u{2022}'),
    ("laquo", '\u{ab}'),
    ("raquo", '\u{bb}'),
    ("lsquo", '\u{2018}'),
    ("rsquo", '\u{2019}'),
    ("ldquo", '\u{201c}'),
    ("rdquo", '\u{201d}'),
    ("copy", '\u{a9}'),
    ("reg", '\u{ae}'),
    ("trade", '\u{2122}'),
    ("times", '\u{d7}'),
    ("yen", '\u{a5}'),
];

/// Longest entity body looked for after `&` (the longest name above, or `#x10FFFF`).
const ENTITY_MAX_LEN: usize = 8;

fn decode_entity(body: &str) -> Option<char> {
    let code = if let Some(hex) = body.strip_prefix("#x").or_else(|| body.strip_prefix("#X")) {
        u32::from_str_radix(hex, 16).ok()?
    } else if let Some(dec) = body.strip_prefix('#') {
        dec.parse().ok()?
    } else {
        return NAMED_ENTITIES
            .iter()
            .find(|(name, _)| *name == body)
            .map(|&(_, c)| c);
    };
    char::from_u32(code).filter(|&c| c != '\0')
}

fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let after = &rest[amp + 1..];
        let decoded = after
            .char_indices()
            .take(ENTITY_MAX_LEN + 1)
            .find(|&(_, c)| c == ';')
            .and_then(|(semi, _)| Some((decode_entity(&after[..semi])?, semi)));
        match decoded {
            Some((c, semi)) => {
                out.push(c);
                rest = &after[semi + 1..];
            }
            None => {
                out.push('&');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn the_title_element_gives_the_title() {
        let html = "<html><head><TITLE lang=en>Example Domain</TITLE></head></html>";
        assert_eq!(page_title(html).as_deref(), Some("Example Domain"));
    }

    #[test]
    fn og_title_stands_in_when_there_is_no_usable_title_element() {
        let og = r#"<meta content="From OG" property="og:title"><meta name="x" content="y">"#;
        assert_eq!(page_title(og).as_deref(), Some("From OG"));
        let empty_title = format!("<title>  </title>{og}");
        assert_eq!(page_title(&empty_title).as_deref(), Some("From OG"));
        let single_quoted = "<meta property='og:title' content='Single'>";
        assert_eq!(page_title(single_quoted).as_deref(), Some("Single"));
    }

    #[test]
    fn a_title_inside_the_body_is_not_the_page_title() {
        let og = r#"<meta property="og:title" content="OG">"#;
        let in_body = format!("<head>{og}</head><body><svg><title>Close</title></svg></body>");
        assert_eq!(page_title(&in_body).as_deref(), Some("OG"));
        let no_head_end = format!("{og}<BODY class=x><svg><title>Close</title></svg>");
        assert_eq!(page_title(&no_head_end).as_deref(), Some("OG"));
        let headless = "<title>Plain</title><p>text</p>";
        assert_eq!(page_title(headless).as_deref(), Some("Plain"));
    }

    #[test]
    fn the_title_element_wins_over_og_title() {
        let html = r#"<meta property="og:title" content="OG"><title>Element</title>"#;
        assert_eq!(page_title(html).as_deref(), Some("Element"));
    }

    #[test]
    fn entities_in_a_title_are_decoded() {
        let html = "<title>Tom &amp; Jerry &lt;3 &quot;x&quot; &#39;y&#x27; &#x1F600; &nbsp;&mdash; &copy;</title>";
        assert_eq!(
            page_title(html).as_deref(),
            Some("Tom & Jerry <3 \"x\" 'y' \u{1F600} \u{2014} \u{a9}")
        );
        let og = r#"<meta property="og:title" content="A &amp; B">"#;
        assert_eq!(page_title(og).as_deref(), Some("A & B"));
    }

    #[test]
    fn an_escaped_entity_is_decoded_only_once() {
        let og = r#"<meta property="og:title" content="&amp;lt;b&amp;gt;">"#;
        assert_eq!(page_title(og).as_deref(), Some("&lt;b&gt;"));
        assert_eq!(
            page_title("<title>&amp;lt;b&amp;gt;</title>").as_deref(),
            Some("&lt;b&gt;")
        );
    }

    #[test]
    fn unknown_or_broken_entities_are_left_as_written() {
        let html = "<title>a &bogus; b &#xZZ; c &#0; d &amp e</title>";
        assert_eq!(
            page_title(html).as_deref(),
            Some("a &bogus; b &#xZZ; c &#0; d &amp e")
        );
    }

    #[test]
    fn whitespace_in_a_title_is_collapsed() {
        let html = "<title>\n   Line one\n\t\tline   two  </title>";
        assert_eq!(page_title(html).as_deref(), Some("Line one line two"));
    }

    #[test]
    fn a_long_title_is_cut_at_two_hundred_characters() {
        let html = format!("<title>{}</title>", "あ".repeat(300));
        assert_eq!(page_title(&html).map(|t| t.chars().count()), Some(200));
    }

    #[test]
    fn a_page_without_a_title_has_none() {
        assert_eq!(page_title("<html><body>hi</body></html>"), None);
        assert_eq!(page_title("<title>unterminated"), None);
        assert_eq!(page_title(""), None);
    }

    #[test]
    fn a_title_with_undecodable_bytes_is_dropped() {
        assert_eq!(page_title("<title>\u{FFFD}\u{FFFD}</title>"), None);
    }

    fn page() -> Url {
        Url::parse("https://example.com/docs/page.html").unwrap()
    }

    fn icon(html: &str) -> Option<String> {
        favicon_url(&page(), Some(html)).map(String::from)
    }

    #[test]
    fn the_first_link_whose_rel_names_an_icon_is_the_favicon() {
        let html = r#"<link rel="stylesheet" href="/a.css"><link rel="Shortcut Icon" href="/s.ico"><link rel="icon" href="/i.png">"#;
        assert_eq!(icon(html).as_deref(), Some("https://example.com/s.ico"));
        let touch = r#"<link href="touch.png" rel="apple-touch-icon">"#;
        assert_eq!(
            icon(touch).as_deref(),
            Some("https://example.com/docs/touch.png")
        );
    }

    #[test]
    fn rel_is_matched_by_its_tokens_and_a_mask_icon_is_passed_over() {
        let html = r#"<link rel="mask-icon" href="/m.svg"><link rel="iconic" href="/x"><link rel="alternate icon" href="/a.ico">"#;
        assert_eq!(icon(html).as_deref(), Some("https://example.com/a.ico"));
        let only_mask = r#"<link rel="mask-icon" href="/m.svg">"#;
        assert_eq!(
            icon(only_mask).as_deref(),
            Some("https://example.com/favicon.ico")
        );
    }

    #[test]
    fn a_relative_or_protocol_relative_href_resolves_against_the_page() {
        assert_eq!(
            icon(r#"<link rel=icon href=../img/f.png>"#).as_deref(),
            Some("https://example.com/img/f.png")
        );
        assert_eq!(
            icon(r#"<link rel="icon" href="//cdn.example.net/f.ico">"#).as_deref(),
            Some("https://cdn.example.net/f.ico")
        );
        assert_eq!(
            icon(r#"<link rel="icon" href="/f.ico?v=2&amp;x=1">"#).as_deref(),
            Some("https://example.com/f.ico?v=2&x=1")
        );
    }

    #[test]
    fn without_a_usable_icon_link_the_favicon_is_the_origins_favicon_ico() {
        let fallback = Some("https://example.com/favicon.ico".to_string());
        assert_eq!(icon("<title>x</title>"), fallback);
        assert_eq!(icon(r#"<link rel="icon">"#), fallback);
        assert_eq!(
            icon(r#"<link rel="icon" href="data:image/png;base64,AA">"#),
            fallback
        );
        assert_eq!(
            icon(r#"<link rel="icon" href="http://127.0.0.1/f.ico">"#),
            fallback
        );
        assert_eq!(favicon_url(&page(), None).map(String::from), fallback);
    }

    #[test]
    fn an_attribute_without_a_name_does_not_run_into_the_next_tag() {
        assert_eq!(parse_attrs(r#" ="x"> rel="icon" href="/a.png">"#), vec![]);
        assert_eq!(
            parse_attrs(r#" ="x" rel="icon">"#),
            vec![("rel".to_string(), "icon".to_string())]
        );
    }

    #[test]
    fn a_body_of_unclosed_tags_is_read_in_linear_time() {
        let page_max = 256 * 1024;
        let bodies = [
            "<meta ".repeat(page_max / 6),
            "<link rel=\"".repeat(page_max / 11),
            format!("<meta content=\"{}", "x".repeat(page_max)),
        ];
        let started = std::time::Instant::now();
        for html in &bodies {
            assert_eq!(page_title(html), None);
            favicon_url(&page(), Some(html));
        }
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "{:?}",
            started.elapsed()
        );
    }

    #[test]
    fn html_responses_are_told_by_their_content_type() {
        for ct in [
            "text/html",
            "text/html; charset=utf-8",
            "Application/XHTML+XML",
        ] {
            assert!(is_html(ct), "{ct}");
        }
        for ct in ["application/json", "text/plain", "image/png", ""] {
            assert!(!is_html(ct), "{ct}");
        }
    }

    #[test]
    fn only_image_content_types_are_kept_for_a_favicon() {
        assert_eq!(image_type("image/png").as_deref(), Some("image/png"));
        assert_eq!(
            image_type("Image/x-icon; charset=binary").as_deref(),
            Some("image/x-icon")
        );
        assert_eq!(
            image_type("image/svg+xml").as_deref(),
            Some("image/svg+xml")
        );
        for ct in [
            "text/html",
            "image/",
            "image/png\r\nx: y",
            "application/octet-stream",
            "",
        ] {
            assert_eq!(image_type(ct), None, "{ct}");
        }
    }
}
