// ---- Pure security functions ----

const ALLOWED_HOSTNAMES: [&str; 3] = ["127.0.0.1", "localhost", "[::1]"];

fn is_allowed_hostname(hostname: &str) -> bool {
    ALLOWED_HOSTNAMES
        .iter()
        .any(|h| hostname.eq_ignore_ascii_case(h))
}

/// Whether it is `:` followed by only one or more digits (the suffix part of `(:\d+)?`).
fn is_port_suffix(s: &str) -> bool {
    matches!(s.strip_prefix(':'), Some(rest) if !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()))
}

/// Extracts the hostname from an authority (`host[:port]`). Matches the Host regex
/// `^(\[[^\]]+\]|[^:]+)(:\d+)?$`: it accepts only a bracketed IPv6 or a colon-free host + an optional `:port`,
/// and returns None if there is extra content after `]` or at the port position (host/origin share the same rule).
fn hostname_of_authority(authority: &str) -> Option<&str> {
    if authority.is_empty() {
        return None;
    }
    if authority.starts_with('[') {
        // \[[^\]]+\] then optional :\d+
        let end = authority.find(']').filter(|&i| i > 1)?;
        let suffix = &authority[end + 1..];
        if !suffix.is_empty() && !is_port_suffix(suffix) {
            return None;
        }
        Some(&authority[..=end])
    } else {
        // [^:]+ then optional :\d+
        match authority.find(':') {
            None => Some(authority),
            Some(0) => None,
            Some(i) => {
                if !is_port_suffix(&authority[i..]) {
                    return None;
                }
                Some(&authority[..i])
            }
        }
    }
}

/// Host header verification (rejects anything outside the localhost family = DNS rebinding).
pub fn is_allowed_host(host: Option<&str>) -> bool {
    match host.and_then(hostname_of_authority) {
        Some(hostname) => is_allowed_hostname(hostname),
        None => false,
    }
}

/// Origin header verification (absent is allowed; if present, only http(s) on the localhost family).
/// Rather than a full URL parse: an origin is the simple form `scheme://host[:port]`, so we decompose it by hand.
/// Host extraction uses the same `hostname_of_authority` as `is_allowed_host` to keep the check consistent.
pub fn is_allowed_origin(origin: Option<&str>) -> bool {
    let Some(origin) = origin else {
        return true;
    };
    let Some((scheme, rest)) = origin.split_once("://") else {
        return false;
    };
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return false;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    match hostname_of_authority(authority) {
        Some(hostname) => is_allowed_hostname(hostname),
        None => false,
    }
}

/// Extracts the first non-empty `token=` value from the query string (after `?`).
pub fn token_from_query(query: Option<&str>) -> Option<&str> {
    query?
        .split('&')
        .find_map(|kv| kv.strip_prefix("token="))
        .filter(|t| !t.is_empty())
}

/// Timing-attack-resistant token comparison (length mismatch or None is false).
pub fn token_matches(provided: Option<&str>, expected: &str) -> bool {
    match provided {
        None => false,
        Some(p) => constant_time_eq(p.as_bytes(), expected.as_bytes()),
    }
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowed_host_accepts_localhost_family() {
        assert!(is_allowed_host(Some("127.0.0.1:8790")));
        assert!(is_allowed_host(Some("localhost:8790")));
        assert!(is_allowed_host(Some("127.0.0.1")));
        assert!(is_allowed_host(Some("[::1]:8790")));
    }

    #[test]
    fn allowed_host_rejects_others_and_missing() {
        assert!(!is_allowed_host(Some("example.com:8790")));
        assert!(!is_allowed_host(Some("127.0.0.1.evil.com:8790")));
        assert!(!is_allowed_host(None));
        assert!(!is_allowed_host(Some("")));
        assert!(!is_allowed_host(Some(":8790")));
    }

    #[test]
    fn allowed_origin_accepts_localhost_http() {
        assert!(is_allowed_origin(Some("http://127.0.0.1:8790")));
        assert!(is_allowed_origin(Some("http://localhost:5173")));
        assert!(is_allowed_origin(None));
    }

    #[test]
    fn allowed_origin_rejects_external_and_invalid() {
        assert!(!is_allowed_origin(Some("http://evil.example")));
        assert!(!is_allowed_origin(Some("https://127.0.0.1.evil.com")));
        assert!(!is_allowed_origin(Some("null")));
        assert!(!is_allowed_origin(Some("not a url")));
        assert!(!is_allowed_origin(Some("ftp://127.0.0.1")));
    }

    #[test]
    fn allowed_origin_rejects_bracket_trailing_junk_and_bad_port() {
        assert!(!is_allowed_origin(Some("http://[::1]extra")));
        assert!(!is_allowed_origin(Some("http://[::1]@evil.com")));
        assert!(!is_allowed_origin(Some("http://[::1].evil.com")));
        assert!(!is_allowed_origin(Some("http://127.0.0.1:80extra")));
        assert!(is_allowed_origin(Some("http://[::1]")));
        assert!(is_allowed_origin(Some("http://[::1]:8790")));
        assert!(is_allowed_origin(Some("http://127.0.0.1:8790/path?x=1")));
    }

    #[test]
    fn token_from_query_takes_first_nonempty() {
        assert_eq!(token_from_query(Some("token=abc")), Some("abc"));
        assert_eq!(token_from_query(Some("token=xyz&x=1")), Some("xyz"));
        assert_eq!(token_from_query(Some("x=1")), None);
        assert_eq!(token_from_query(Some("token=")), None);
        assert_eq!(token_from_query(None), None);
    }

    #[test]
    fn token_matches_is_length_safe() {
        assert!(token_matches(Some("abc"), "abc"));
        assert!(!token_matches(Some("abcd"), "abc"));
        assert!(!token_matches(Some("abd"), "abc"));
        assert!(!token_matches(None, "abc"));
    }
}
