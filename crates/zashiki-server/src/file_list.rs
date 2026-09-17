//! The quick-open (Cmd+P) file listing: which scanned repos `rg --files` walks for a query, and how its
//! output becomes the capped response.

use std::collections::HashSet;
use std::path::Path;

use serde::Serialize;

use crate::search::{root_for, ScannedRoot};

/// One file in the quick-open listing (GET /api/files, `FileEntry`).
#[derive(Serialize)]
pub struct FileEntry {
    pub org: String,
    pub repo: String,
    pub path: String,
    #[serde(rename = "relPath")]
    pub rel_path: String,
}

#[derive(Serialize)]
pub struct FileListResponse {
    pub truncated: bool,
    pub home: String,
    pub files: Vec<FileEntry>,
}

/// Cap on the quick-open file listing (past this the response is marked truncated).
pub const FILE_LIST_MAX: usize = 20_000;

/// The paths to walk, in listing order, and the org whose files are kept (None keeps every org).
pub struct ListingPlan {
    pub groups: [Vec<String>; 2],
    pub org: Option<String>,
}

/// Lists the org the active terminal's `cwd` belongs to. Inside a scanned repo, that repo comes first so
/// the cap can only drop the org's other repos; elsewhere under an org root (a new terminal starts at
/// the root) the org is listed as a whole. Outside every org root, or with no `cwd`, every repo is listed.
pub fn workspace_plan(roots: &[ScannedRoot], org_roots: &[&str], cwd: Option<&str>) -> ListingPlan {
    let active = cwd.and_then(|cwd| root_for(cwd, roots));
    let org = match active {
        Some(active) => Some(active.org.clone()),
        None => cwd
            .filter(|cwd| org_roots.iter().any(|root| contains(root, cwd)))
            .map(|cwd| zashiki_core::repos::org_of_cwd(cwd, org_roots).to_string()),
    };
    let first: Vec<String> = active.map(|r| r.path.clone()).into_iter().collect();
    let rest = roots
        .iter()
        .filter(|r| org.as_ref().is_none_or(|o| &r.org == o) && !first.contains(&r.path))
        .map(|r| r.path.clone())
        .collect();
    ListingPlan {
        groups: [first, rest],
        org,
    }
}

fn contains(root: &str, path: &str) -> bool {
    let root = root.trim_end_matches('/');
    path == root || path.starts_with(&format!("{root}/"))
}

/// Lists a path query's directory across every org: the directory itself, when it is inside a scanned
/// repo and really resolves inside it (a symlink must not reach files outside the scan). Anything else
/// lists nothing. Blocking (canonicalizes).
pub fn path_plan(dir: &Path, roots: &[ScannedRoot]) -> ListingPlan {
    let dir_text = dir.to_string_lossy();
    let inside_repo =
        root_for(&dir_text, roots).is_some_and(|root| resolves_within(dir, Path::new(&root.path)));
    let targets = if inside_repo {
        vec![dir_text.into_owned()]
    } else {
        Vec::new()
    };
    ListingPlan {
        groups: [targets, Vec::new()],
        org: None,
    }
}

fn resolves_within(dir: &Path, root: &Path) -> bool {
    match (std::fs::canonicalize(dir), std::fs::canonicalize(root)) {
        (Ok(dir_real), Ok(root_real)) => dir_real.starts_with(root_real),
        _ => false,
    }
}

/// Maps `rg --files` outputs (one path per line), taken in order, into capped file entries. A path is
/// dropped when it is outside every scan root, belongs to another org than `org`, or was already listed.
/// Returns the entries and whether the cap cut the listing short.
pub fn parse_rg_files(
    outputs: &[&str],
    roots: &[ScannedRoot],
    org: Option<&str>,
    max: usize,
) -> (Vec<FileEntry>, bool) {
    let mut files: Vec<FileEntry> = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();
    for stdout in outputs {
        for raw in stdout.split('\n') {
            let path = raw.strip_suffix('\r').unwrap_or(raw);
            if path.is_empty() {
                continue;
            }
            let Some(root) = root_for(path, roots) else {
                continue;
            };
            if org.is_some_and(|o| root.org != o) || !seen.insert(path) {
                continue;
            }
            if files.len() >= max {
                return (files, true);
            }
            let rel_path = if path == root.path {
                root.repo.clone()
            } else {
                path[root.path.len() + 1..].to_string()
            };
            files.push(FileEntry {
                org: root.org.clone(),
                repo: root.repo.clone(),
                path: path.to_string(),
                rel_path,
            });
        }
    }
    (files, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(org: &str, repo: &str, path: &str) -> ScannedRoot {
        ScannedRoot {
            org: org.to_string(),
            repo: repo.to_string(),
            path: path.to_string(),
        }
    }

    const ORG_ROOTS: &[&str] = &["/r/big", "/r/small/"];

    fn roots() -> Vec<ScannedRoot> {
        vec![
            root("big", "app", "/r/big/app"),
            root("big", "app-wt", "/r/big/app-wt"),
            root("small", "lib", "/r/small/lib"),
        ]
    }

    #[test]
    fn workspace_plan_lists_the_repo_containing_cwd_before_the_rest_of_its_org() {
        let plan = workspace_plan(&roots(), ORG_ROOTS, Some("/r/big/app-wt/packages/client"));
        assert_eq!(
            plan.groups,
            [
                vec!["/r/big/app-wt".to_string()],
                vec!["/r/big/app".to_string()]
            ]
        );
        assert_eq!(plan.org.as_deref(), Some("big"));
    }

    #[test]
    fn workspace_plan_picks_the_innermost_repo_for_a_nested_cwd() {
        let roots = vec![
            root("outer", "outer", "/r/outer"),
            root("inner", "inner", "/r/outer/inner"),
        ];
        let plan = workspace_plan(
            &roots,
            &["/r/outer", "/r/outer/inner"],
            Some("/r/outer/inner/src"),
        );
        assert_eq!(plan.groups[0], vec!["/r/outer/inner".to_string()]);
        assert!(plan.groups[1].is_empty());
        assert_eq!(plan.org.as_deref(), Some("inner"));
    }

    #[test]
    fn workspace_plan_at_an_org_root_lists_that_org() {
        for cwd in ["/r/big", "/r/big/app-w", "/r/big/notes/"] {
            let plan = workspace_plan(&roots(), ORG_ROOTS, Some(cwd));
            assert!(plan.groups[0].is_empty());
            assert_eq!(
                plan.groups[1],
                vec!["/r/big/app".to_string(), "/r/big/app-wt".to_string()]
            );
            assert_eq!(plan.org.as_deref(), Some("big"));
        }
    }

    #[test]
    fn workspace_plan_outside_every_org_root_lists_every_repo() {
        for cwd in [Some("/Users/me/Downloads"), Some("/r/bigger"), None] {
            let plan = workspace_plan(&roots(), ORG_ROOTS, cwd);
            assert!(plan.groups[0].is_empty());
            assert_eq!(plan.groups[1].len(), 3);
            assert_eq!(plan.org, None);
        }
    }

    #[test]
    fn path_plan_outside_every_repo_lists_nothing() {
        for dir in ["/r/big", "/", "/r/bi"] {
            assert!(path_plan(Path::new(dir), &roots()).groups[0].is_empty());
        }
    }

    #[test]
    fn path_plan_inside_a_repo_lists_just_that_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("org/repo");
        std::fs::create_dir_all(repo.join("src/deep")).unwrap();
        let roots = vec![root("org", "repo", &repo.to_string_lossy())];
        let dir = repo.join("src");
        let plan = path_plan(&dir, &roots);
        assert_eq!(plan.groups[0], vec![dir.to_string_lossy().into_owned()]);
    }

    #[test]
    fn path_plan_refuses_a_directory_that_escapes_the_repo_through_a_symlink() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("org/repo");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, repo.join("link")).unwrap();
        let roots = vec![root("org", "repo", &repo.to_string_lossy())];
        assert!(path_plan(&repo.join("link"), &roots).groups[0].is_empty());
        assert!(path_plan(&repo.join("missing"), &roots).groups[0].is_empty());
    }

    #[test]
    fn parse_rg_files_maps_paths_to_roots_and_drops_outsiders() {
        let stdout = concat!(
            "/r/big/app/src/x.ts\n",
            "/r/big/app/README.md\r\n",
            "\n",
            "/outside/y.ts\n",
        );
        let (files, truncated) = parse_rg_files(&[stdout], &roots(), None, FILE_LIST_MAX);
        assert!(!truncated);
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].rel_path, "src/x.ts");
        assert_eq!(files[0].org, "big");
        assert_eq!(files[1].rel_path, "README.md");
    }

    #[test]
    fn parse_rg_files_keeps_output_order_so_the_cap_drops_later_groups() {
        let active = "/r/big/app-wt/a\n/r/big/app-wt/b\n";
        let rest = "/r/big/app/a\n";
        let (files, truncated) = parse_rg_files(&[active, rest], &roots(), Some("big"), 2);
        assert!(truncated);
        let repos: Vec<&str> = files.iter().map(|f| f.repo.as_str()).collect();
        assert_eq!(repos, vec!["app-wt", "app-wt"]);
    }

    #[test]
    fn parse_rg_files_drops_other_orgs_and_duplicates() {
        let roots = vec![
            root("outer", "outer", "/r/outer"),
            root("inner", "inner", "/r/outer/inner"),
        ];
        let first = "/r/outer/a.ts\n/r/outer/inner/b.ts\n";
        let second = "/r/outer/a.ts\n";
        let (files, truncated) = parse_rg_files(&[first, second], &roots, Some("outer"), 10);
        assert!(!truncated);
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["/r/outer/a.ts"]);
    }
}
