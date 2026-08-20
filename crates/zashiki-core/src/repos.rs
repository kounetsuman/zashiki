//! Pure logic for determining org (organization) membership.
//! Reading, parsing, and absolutizing repos.conf are the responsibility of server/infra; this module only does string
//! comparison over already-absolute root paths (org name = the last element of a root).

/// The last element of a path. Strips a trailing slash and takes the last segment;
/// if empty (all slashes / empty string), returns the trimmed string.
fn basename(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    let last = trimmed.rsplit('/').next().unwrap_or(trimmed);
    if last.is_empty() {
        trimmed
    } else {
        last
    }
}

/// Which org the cwd belongs to (org name = the last element of a root).
/// If it is under no root, the last element of the cwd itself (a fallback for detecting paths outside the conf).
pub fn org_of_cwd<'a>(cwd: &'a str, roots: &[&'a str]) -> &'a str {
    for &root in roots {
        if cwd == root || cwd.starts_with(&format!("{root}/")) {
            return basename(root);
        }
    }
    basename(cwd)
}

/// org name → root absolute path (None if there is no match).
pub fn org_root<'a>(org: &str, roots: &[&'a str]) -> Option<&'a str> {
    roots.iter().copied().find(|&root| basename(root) == org)
}

/// The list of display names for all orgs in the conf (order-preserving dedup). Also the basis for always showing orgs with zero sessions.
pub fn org_names<'a>(roots: &[&'a str]) -> Vec<&'a str> {
    let mut seen = std::collections::HashSet::new();
    let mut names = Vec::new();
    for &root in roots {
        let name = basename(root);
        if seen.insert(name) {
            names.push(name);
        }
    }
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOTS: &[&str] = &[
        "/Users/kilo/workspace/charlie",
        "/Users/kilo/workspace/delta",
        "/Users/kilo/workspace/kilo",
    ];

    #[test]
    fn org_of_cwd_under_root() {
        assert_eq!(
            org_of_cwd("/Users/kilo/workspace/charlie/repo-a", ROOTS),
            "charlie"
        );
    }

    #[test]
    fn org_of_cwd_root_itself() {
        assert_eq!(
            org_of_cwd("/Users/kilo/workspace/charlie", ROOTS),
            "charlie"
        );
    }

    #[test]
    fn org_of_cwd_prefix_sibling_not_misattributed() {
        // A different directory that is a prefix match (charlie2) must not be misattributed to charlie
        assert_eq!(
            org_of_cwd("/Users/kilo/workspace/charlie2", ROOTS),
            "charlie2"
        );
    }

    #[test]
    fn org_of_cwd_outside_any_root() {
        assert_eq!(org_of_cwd("/tmp/scratch", ROOTS), "scratch");
    }

    #[test]
    fn org_root_resolves() {
        assert_eq!(
            org_root("delta", ROOTS),
            Some("/Users/kilo/workspace/delta")
        );
    }

    #[test]
    fn org_root_no_match_is_none() {
        assert_eq!(org_root("unknown", ROOTS), None);
    }

    #[test]
    fn org_names_preserves_order() {
        assert_eq!(org_names(ROOTS), vec!["charlie", "delta", "kilo"]);
    }

    #[test]
    fn org_names_dedups_preserving_order() {
        assert_eq!(
            org_names(&["/a/foo", "/b/foo", "/a/bar"]),
            vec!["foo", "bar"]
        );
    }

    // basename edge cases (trailing-slash trim and empty input).
    #[test]
    fn basename_edges() {
        assert_eq!(org_of_cwd("/a/foo/", &[]), "foo"); // strips the trailing slash
        assert_eq!(org_of_cwd("/a/foo///", &[]), "foo"); // strips consecutive slashes too
        assert_eq!(org_of_cwd("foo", &[]), "foo"); // no slash
        assert_eq!(org_of_cwd("", &[]), ""); // empty input
        assert_eq!(org_of_cwd("///", &[]), ""); // all slashes
        assert_eq!(org_of_cwd("/a/foo/", &["/a/foo/"]), "foo"); // exact match against a root with a trailing slash
    }
}
