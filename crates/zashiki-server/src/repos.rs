//! Reading and scanning repos.conf.
//! org = basename of the root line, repo = basename of a working tree that has `.git`, path = its absolute path.

use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, RwLock};

/// One entry from scanRepos (org/repo/path). Maps directly onto the wire `FsRepo`.
#[derive(Clone)]
pub struct ScannedRepo {
    pub org: String,
    pub repo: String,
    pub path: String,
    pub is_worktree: bool,
}

/// Collapses `.` / `..` lexically (does not resolve symlinks).
fn normalize_lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// The result of reading repos.conf as a list of absolute-path roots plus per-org display maps.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ReposConf {
    pub roots: Vec<PathBuf>,
    /// org (root basename) → color (`#rgb`/`#rrggbb`, lowercased). First occurrence wins for a given org.
    pub color_by_org: BTreeMap<String, String>,
    /// org (root basename) → display alias (`@Name` token). First occurrence wins for a given org.
    pub alias_by_org: BTreeMap<String, String>,
}

/// Whether the token is `#rgb` / `#rrggbb`.
fn is_color_token(token: &str) -> bool {
    match token.strip_prefix('#') {
        Some(hex) => {
            (hex.len() == 3 || hex.len() == 6) && hex.bytes().all(|b| b.is_ascii_hexdigit())
        }
        None => false,
    }
}

/// Whether the token is an alias (`@` followed by at least one character).
fn is_alias_token(token: &str) -> bool {
    token.strip_prefix('@').is_some_and(|rest| !rest.is_empty())
}

/// Splits an optional trailing whitespace-separated alias token (`@Name`) off the end of `head`
/// (the part of a line before any color/comment `#`). The remainder is the path, so internal
/// whitespace in the path is preserved; an alias is only taken when a non-empty path precedes it.
fn split_trailing_alias(head: &str) -> (&str, Option<String>) {
    let trimmed = head.trim_end();
    if let Some((rest, last)) = trimmed.rsplit_once(char::is_whitespace) {
        if is_alias_token(last) && !rest.trim().is_empty() {
            return (rest.trim_end(), Some(last[1..].to_string()));
        }
    }
    (trimmed, None)
}

/// Resolves a path line to an absolute path (`~`/`~/` expand to home, `~user` is discarded, relative paths are based on cwd, then lexically normalized).
fn expand_root(line: &str, home: &Path, cwd: &Path) -> Option<PathBuf> {
    let expanded: PathBuf = if line == "~" {
        home.to_path_buf()
    } else if let Some(rest) = line.strip_prefix("~/") {
        home.join(rest)
    } else if line.starts_with('~') {
        return None; // ~user is unsupported (avoid it degrading into a cwd-relative garbage path)
    } else {
        let p = Path::new(line);
        if p.is_absolute() {
            p.to_path_buf()
        } else {
            cwd.join(p)
        }
    };
    Some(normalize_lexical(&expanded))
}

/// Parses the body of repos.conf into a list of roots plus per-org colors and aliases (pure function).
/// A line is `path [@alias] [#color]`: everything after `#` is a comment, picked up as a color only when
/// whitespace-separated and a valid color token (a `#` adjacent to the path is a comment); a trailing
/// whitespace-separated `@alias` token (before the color) sets the org's display name. Internal whitespace
/// in the path is preserved. Color and alias are bound to org=basename, first occurrence wins.
pub fn parse_conf(text: &str, home: &Path, cwd: &Path) -> ReposConf {
    let mut seen = HashSet::new();
    let mut roots = Vec::new();
    let mut color_by_org = BTreeMap::new();
    let mut alias_by_org = BTreeMap::new();
    for raw in text.lines() {
        let line = raw.trim();
        let (path, alias, color) = match line.find('#') {
            None => {
                if line.is_empty() {
                    continue;
                }
                let (path, alias) = split_trailing_alias(line);
                (path, alias, None)
            }
            Some(hash) => {
                let before = &line[..hash];
                let (path, alias) = split_trailing_alias(before);
                if path.is_empty() {
                    continue; // A leading `#` (comment line / leading color token) has no path, so drop it.
                }
                // A `#` adjacent to the path (or alias) is a comment as before (not treated as a color).
                let separated = before.chars().next_back().is_some_and(char::is_whitespace);
                let color = if separated {
                    let head = line[hash..].split_whitespace().next().unwrap_or("");
                    is_color_token(head).then(|| head.to_ascii_lowercase())
                } else {
                    None
                };
                (path, alias, color)
            }
        };
        if path.is_empty() {
            continue;
        }
        let Some(abs) = expand_root(path, home, cwd) else {
            continue;
        };
        if seen.insert(abs.clone()) {
            roots.push(abs.clone());
        }
        if color.is_some() || alias.is_some() {
            let org = abs
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            if let Some(color) = color {
                color_by_org.entry(org.clone()).or_insert(color);
            }
            if let Some(alias) = alias {
                alias_by_org.entry(org).or_insert(alias);
            }
        }
    }
    ReposConf {
        roots,
        color_by_org,
        alias_by_org,
    }
}

/// Parses the body of repos.conf into a list of absolute-path roots (roots only, even for lines with a color; backward-compatible).
pub fn parse_conf_roots(text: &str, home: &Path, cwd: &Path) -> Vec<PathBuf> {
    parse_conf(text, home, cwd).roots
}

/// Renders one repos.conf line from a verbatim path plus optional alias (`@Name`) and color tokens.
/// The path is written as given (so `~` stays portable). Alias and color are whitespace-separated,
/// which is exactly what makes `parse_conf` read them back rather than as a comment. Order is
/// `path [@alias] [#color]`, matching the parse order.
pub fn format_conf_line(path: &str, alias: Option<&str>, color: Option<&str>) -> String {
    let mut out = path.trim().to_string();
    if let Some(alias) = alias {
        out.push_str("   @");
        out.push_str(alias);
    }
    if let Some(color) = color {
        out.push_str("   ");
        out.push_str(color);
    }
    out
}

/// The result of adding a root line to repos.conf text.
#[derive(Debug, PartialEq, Eq)]
pub enum AddOutcome {
    /// The full new text to write back (the line was appended on its own line).
    Added(String),
    /// The path's expanded absolute form is already a root; nothing was appended.
    Duplicate,
}

/// Appends a root line to repos.conf `text`, unless the path (after `~`/relative
/// expansion and lexical normalization) is already a root. Existing content is
/// preserved verbatim; a separating newline is inserted when the file lacks a
/// trailing one, and the appended line always ends with a newline.
pub fn add_root_line(
    text: &str,
    path: &str,
    alias: Option<&str>,
    color: Option<&str>,
    home: &Path,
    cwd: &Path,
) -> AddOutcome {
    let trimmed = path.trim();
    if let Some(abs) = expand_root(trimmed, home, cwd) {
        if parse_conf(text, home, cwd).roots.iter().any(|r| *r == abs) {
            return AddOutcome::Duplicate;
        }
    }
    let mut out = String::from(text);
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(&format_conf_line(trimmed, alias, color));
    out.push('\n');
    AddOutcome::Added(out)
}

/// Resolves a repos.conf path line to an absolute path (`~`/relative expansion + lexical normalization),
/// using the process HOME and cwd. Returns None for unsupported forms (`~user`). Exposed for existence
/// checks at the add endpoint before writing the line.
pub fn resolve_conf_path(path: &str) -> Option<PathBuf> {
    let (home, cwd) = conf_home_cwd();
    expand_root(path.trim(), &home, &cwd)
}

/// Whether a token is an accepted repos.conf color (`#rgb` / `#rrggbb`). Exposed so the add endpoint
/// rejects a color that would otherwise be written but silently read back as a comment.
pub fn is_valid_color_token(token: &str) -> bool {
    is_color_token(token)
}

fn write_repos_conf_atomic(path: &Path, text: &str) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(".repos.conf.tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)
}

/// Reads repos.conf, appends the root line (de-duplicated by normalized absolute path), and writes it
/// back atomically (temp + rename, so a concurrent read never sees half-written content). A missing
/// file is treated as empty. On `Duplicate` nothing is written.
pub fn append_root_to_conf(
    conf_path: &Path,
    path: &str,
    alias: Option<&str>,
    color: Option<&str>,
) -> std::io::Result<AddOutcome> {
    let text = std::fs::read_to_string(conf_path).unwrap_or_default();
    let (home, cwd) = conf_home_cwd();
    match add_root_line(&text, path, alias, color, &home, &cwd) {
        AddOutcome::Duplicate => Ok(AddOutcome::Duplicate),
        AddOutcome::Added(new_text) => {
            write_repos_conf_atomic(conf_path, &new_text)?;
            Ok(AddOutcome::Added(new_text))
        }
    }
}

fn conf_home_cwd() -> (PathBuf, PathBuf) {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    let cwd = std::env::current_dir().unwrap_or_default();
    (home, cwd)
}

/// Reads repos.conf and returns the list of roots (missing file or read failure yields empty; graceful).
pub fn read_conf_roots(conf_path: &Path) -> Vec<PathBuf> {
    read_repos_conf(conf_path).roots
}

/// Reads repos.conf and returns the list of roots plus org colors (missing file or read failure yields empty; graceful).
pub fn read_repos_conf(conf_path: &Path) -> ReposConf {
    let Ok(text) = std::fs::read_to_string(conf_path) else {
        return ReposConf::default();
    };
    let (home, cwd) = conf_home_cwd();
    parse_conf(&text, &home, &cwd)
}

/// Live repos.conf-derived state shared by the poller, session.new org validation, and the
/// repos.conf watcher. Swapped wholesale on reload so all readers see a consistent set.
/// `roots` are absolute-path strings; `colors`/`aliases` map org (basename) to its display color/name.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ReposState {
    pub roots: Vec<String>,
    pub colors: BTreeMap<String, String>,
    pub aliases: BTreeMap<String, String>,
}

/// A cloneable handle to the current {@link ReposState}. Reads are short-lived (per poll tick /
/// per session.new); writes happen only on add or on an external repos.conf edit.
pub type SharedRepos = Arc<RwLock<ReposState>>;

/// Wraps roots + colors + aliases into a {@link SharedRepos} handle.
pub fn shared_repos(
    roots: Vec<String>,
    colors: BTreeMap<String, String>,
    aliases: BTreeMap<String, String>,
) -> SharedRepos {
    Arc::new(RwLock::new(ReposState {
        roots,
        colors,
        aliases,
    }))
}

/// Reads repos.conf into a {@link ReposState} (roots as strings + org colors/aliases; graceful on missing/unreadable).
pub fn read_repos_state(conf_path: &Path) -> ReposState {
    let conf = read_repos_conf(conf_path);
    ReposState {
        roots: conf
            .roots
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
        colors: conf.color_by_org,
        aliases: conf.alias_by_org,
    }
}

/// How a would-be org path classifies. The `Ok` value carries the org name (basename); the failures
/// mirror the `POST /api/repos/add` error `code`s so add and the validate endpoint never drift.
#[derive(Debug, PartialEq, Eq, Clone)]
pub enum AddPathStatus {
    Ok(String),
    PathUnresolved,
    NotADirectory,
    NoDirName,
    Duplicate,
}

/// Classifies whether `path` could be added as an org root: resolves it (`~`/relative/lexical), checks it
/// is an existing directory with a final name, and de-duplicates against the current roots by the same
/// normalized-absolute-path basis as `add_root_line`. Shared by `repos_add` (authoritative add) and the
/// validate endpoint (inline preview), so both agree on every outcome.
pub fn classify_add_path(conf_path: &Path, path: &str) -> AddPathStatus {
    let Some(abs) = resolve_conf_path(path) else {
        return AddPathStatus::PathUnresolved;
    };
    if !abs.is_dir() {
        return AddPathStatus::NotADirectory;
    }
    let Some(org) = abs.file_name().map(|s| s.to_string_lossy().into_owned()) else {
        return AddPathStatus::NoDirName;
    };
    if org.is_empty() {
        return AddPathStatus::NoDirName;
    }
    let abs_str = abs.to_string_lossy();
    if read_repos_state(conf_path).roots.iter().any(|r| *r == abs_str) {
        return AddPathStatus::Duplicate;
    }
    AddPathStatus::Ok(org)
}

/// Number of `Normal` components in a path (its depth below the filesystem root); `/` is 0, `/Volumes`
/// is 1, `/Volumes/ext` is 2.
fn path_depth(path: &Path) -> usize {
    path.components()
        .filter(|c| matches!(c, Component::Normal(_)))
        .count()
}

/// The directories the browse endpoint may enumerate: the process HOME plus the parent of every
/// registered root (so orgs kept outside HOME, e.g. `/Volumes/ext/myorg`, stay browseable). A parent is
/// admitted only when it is at least two components deep, so a shallow root such as `/Users` (parent `/`)
/// can never widen enumeration to a top-level system directory. Enumeration is strictly more disclosing
/// than the add/validate 1-bit existence check, so it is confined to these.
pub fn browse_roots(conf_path: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    let (home, _) = conf_home_cwd();
    if !home.as_os_str().is_empty() {
        roots.push(home);
    }
    for root in read_repos_state(conf_path).roots {
        if let Some(parent) = Path::new(&root).parent() {
            if path_depth(parent) >= 2 {
                roots.push(parent.to_path_buf());
            }
        }
    }
    roots
}

fn is_repo(path: &Path) -> bool {
    // `.git` is a dir (normal) or a file (worktree). If it exists, this is a repo.
    path.join(".git").exists()
}

/// The main working tree a linked worktree belongs to — the anchor that groups it with its
/// siblings in the explorer. A worktree's `.git` file reads `gitdir: <MAIN>/.git/worktrees/<name>`,
/// so the main working tree is that target stripped of `/.git/worktrees/<name>`. `None` when `path`
/// is a main working tree, a submodule (`.../modules/<name>`), or the pointer is malformed.
pub fn worktree_main_path(path: &Path) -> Option<String> {
    let dot_git = path.join(".git");
    if !dot_git.is_file() {
        return None;
    }
    let content = std::fs::read_to_string(&dot_git).ok()?;
    let target = content
        .lines()
        .find_map(|line| line.strip_prefix("gitdir:"))?
        .trim();
    let worktrees_dir = Path::new(target).parent()?;
    if worktrees_dir.file_name()? != "worktrees" {
        return None;
    }
    let main = worktrees_dir.parent()?.parent()?;
    Some(main.to_string_lossy().into_owned())
}

/// Whether `path` is a linked worktree (as opposed to a main working tree or a submodule).
pub fn is_linked_worktree(path: &Path) -> bool {
    worktree_main_path(path).is_some()
}

/// Visible subdirectories directly under `dir` (excluding those starting with `.`).
fn visible_subdirs(dir: &Path) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    rd.flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .map(|e| e.path())
        .collect()
}

/// Scans `base` itself, its direct children, and grandchildren (2 levels), returning paths that have `.git` (sorted and deduplicated).
pub fn repos_under(base: &Path) -> Vec<PathBuf> {
    let mut found = BTreeSet::new();
    if is_repo(base) {
        found.insert(base.to_path_buf());
    }
    for child in visible_subdirs(base) {
        if is_repo(&child) {
            found.insert(child.clone());
        }
        for grand in visible_subdirs(&child) {
            if is_repo(&grand) {
                found.insert(grand);
            }
        }
    }
    found.into_iter().collect()
}

fn basename(path: &Path) -> String {
    path.file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Enumerates repos under every root in repos.conf as `{org, repo, path}`.
/// A repo's org is its most specific matching root (via `org_of_cwd`), so a repo under a nested
/// child root is attributed to the child, not the ancestor. Paths are deduplicated across roots
/// (an ancestor and a descendant root both reach the same repo).
pub fn scan_repos(conf_path: &Path) -> Vec<ScannedRepo> {
    let roots = read_conf_roots(conf_path);
    // org_of_cwd compares against the lossy repo path below, so build the roots on the same lossy
    // basis; otherwise a non-UTF8 root would drop out and its repos would misattribute to their own basename.
    let root_strings: Vec<String> = roots
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    let root_strs: Vec<&str> = root_strings.iter().map(String::as_str).collect();
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for root in &roots {
        for repo_path in repos_under(root) {
            let path = repo_path.to_string_lossy().into_owned();
            if !seen.insert(path.clone()) {
                continue;
            }
            out.push(ScannedRepo {
                org: zashiki_core::repos::org_of_cwd(&path, &root_strs).to_string(),
                repo: basename(&repo_path),
                is_worktree: is_linked_worktree(&repo_path),
                path,
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_conf_roots_comments_trim_dedup_and_tilde() {
        let home = Path::new("/home/u");
        let cwd = Path::new("/work");
        let text = "\
# comment line
~/workspace/foo
  /tmp/y  # trailing comment
~/workspace/foo  # duplicate
~user/nope
rel/dir
~
";
        assert_eq!(
            parse_conf_roots(text, home, cwd),
            vec![
                PathBuf::from("/home/u/workspace/foo"),
                PathBuf::from("/tmp/y"),
                PathBuf::from("/work/rel/dir"),
                PathBuf::from("/home/u"),
            ]
        );
    }

    #[test]
    fn format_conf_line_appends_alias_and_color_whitespace_separated() {
        assert_eq!(format_conf_line("/tmp/foo", None, None), "/tmp/foo");
        assert_eq!(
            format_conf_line("  ~/ws/foo  ", None, Some("#7aa2f7")),
            "~/ws/foo   #7aa2f7"
        );
        assert_eq!(
            format_conf_line("/tmp/foo", Some("Frontend"), None),
            "/tmp/foo   @Frontend"
        );
        assert_eq!(
            format_conf_line("/tmp/foo", Some("Frontend"), Some("#7aa2f7")),
            "/tmp/foo   @Frontend   #7aa2f7"
        );
    }

    #[test]
    fn add_root_line_appends_line_and_reparses_as_root() {
        let home = Path::new("/home/u");
        let cwd = Path::new("/work");
        let AddOutcome::Added(text) = add_root_line("", "~/ws/foo", None, None, home, cwd) else {
            panic!("expected Added");
        };
        assert_eq!(text, "~/ws/foo\n");
        assert_eq!(
            parse_conf_roots(&text, home, cwd),
            vec![PathBuf::from("/home/u/ws/foo")]
        );
    }

    #[test]
    fn add_root_line_inserts_separator_when_no_trailing_newline() {
        let home = Path::new("/home/u");
        let cwd = Path::new("/work");
        let AddOutcome::Added(text) =
            add_root_line("/tmp/a", "/tmp/b", None, Some("#f00"), home, cwd)
        else {
            panic!("expected Added");
        };
        assert_eq!(text, "/tmp/a\n/tmp/b   #f00\n");
        // The appended color is read back (whitespace-separated), bound to org=basename.
        let conf = parse_conf(&text, home, cwd);
        assert_eq!(conf.color_by_org.get("b"), Some(&"#f00".to_string()));
    }

    #[test]
    fn add_root_line_dedupes_by_normalized_absolute_path() {
        let home = Path::new("/home/u");
        let cwd = Path::new("/work");
        // Already present as an absolute root; the tilde form expands to the same path.
        assert_eq!(
            add_root_line("/home/u/ws/foo\n", "~/ws/foo", None, None, home, cwd),
            AddOutcome::Duplicate
        );
        // A `..` form that normalizes onto an existing root is also a duplicate.
        assert_eq!(
            add_root_line("/tmp/a\n", "/tmp/x/../a", None, None, home, cwd),
            AddOutcome::Duplicate
        );
        // A different basename under the same parent is NOT a duplicate (dedup is by path, not org).
        assert!(matches!(
            add_root_line("/ws/foo\n", "/ws/bar", None, None, home, cwd),
            AddOutcome::Added(_)
        ));
    }

    #[test]
    fn append_root_to_conf_writes_and_is_idempotent_on_duplicate() {
        let dir = tempfile::tempdir().unwrap();
        let conf = dir.path().join("repos.conf");
        let target = dir.path().join("myorg");
        std::fs::create_dir_all(&target).unwrap();
        let path = target.to_string_lossy().into_owned();

        // First add: the line is written and reads back as a root.
        let outcome = append_root_to_conf(&conf, &path, None, Some("#7aa2f7")).unwrap();
        assert!(matches!(outcome, AddOutcome::Added(_)));
        let state = read_repos_state(&conf);
        assert_eq!(state.roots, vec![path.clone()]);
        assert_eq!(state.colors.get("myorg"), Some(&"#7aa2f7".to_string()));

        // Re-adding the same path is a Duplicate and leaves the file untouched.
        let before = std::fs::read_to_string(&conf).unwrap();
        assert_eq!(
            append_root_to_conf(&conf, &path, None, None).unwrap(),
            AddOutcome::Duplicate
        );
        assert_eq!(std::fs::read_to_string(&conf).unwrap(), before);
    }

    #[test]
    fn append_root_to_conf_creates_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let conf = dir.path().join("nested/repos.conf");
        let target = dir.path().join("solo");
        std::fs::create_dir_all(&target).unwrap();
        let path = target.to_string_lossy().into_owned();
        assert!(matches!(
            append_root_to_conf(&conf, &path, None, None).unwrap(),
            AddOutcome::Added(_)
        ));
        assert_eq!(read_repos_state(&conf).roots, vec![path]);
    }

    #[test]
    fn parse_conf_roots_normalizes_dotdot() {
        let home = Path::new("/home/u");
        let cwd = Path::new("/work");
        assert_eq!(
            parse_conf_roots("/a/b/../c\n", home, cwd),
            vec![PathBuf::from("/a/c")]
        );
    }

    #[test]
    fn read_conf_roots_missing_file_is_empty() {
        assert!(read_conf_roots(Path::new("/no/such/repos.conf")).is_empty());
    }

    fn colors(text: &str) -> BTreeMap<String, String> {
        parse_conf(text, Path::new("/home"), Path::new("/work")).color_by_org
    }

    #[test]
    fn parse_conf_binds_trailing_color_to_org_lowercased() {
        let conf = parse_conf(
            "/tmp/whiskey  #7aa2f7\n/tmp/charlie\t#98C379\n/tmp/delta\n",
            Path::new("/home"),
            Path::new("/work"),
        );
        assert_eq!(
            conf.roots,
            vec![
                PathBuf::from("/tmp/whiskey"),
                PathBuf::from("/tmp/charlie"),
                PathBuf::from("/tmp/delta"),
            ]
        );
        assert_eq!(
            conf.color_by_org,
            BTreeMap::from([
                ("whiskey".to_string(), "#7aa2f7".to_string()),
                ("charlie".to_string(), "#98c379".to_string()),
            ])
        );
    }

    #[test]
    fn parse_conf_binds_alias_and_color_in_any_combination() {
        let conf = parse_conf(
            "/tmp/foo   @Frontend   #7aa2f7\n/tmp/bar   @Backend\n/tmp/baz   #98c379\n",
            Path::new("/home"),
            Path::new("/work"),
        );
        assert_eq!(
            conf.roots,
            vec![
                PathBuf::from("/tmp/foo"),
                PathBuf::from("/tmp/bar"),
                PathBuf::from("/tmp/baz"),
            ]
        );
        assert_eq!(
            conf.alias_by_org,
            BTreeMap::from([
                ("foo".to_string(), "Frontend".to_string()),
                ("bar".to_string(), "Backend".to_string()),
            ])
        );
        assert_eq!(
            conf.color_by_org,
            BTreeMap::from([
                ("foo".to_string(), "#7aa2f7".to_string()),
                ("baz".to_string(), "#98c379".to_string()),
            ])
        );
    }

    #[test]
    fn parse_conf_alias_adjacent_to_path_is_part_of_path() {
        // No whitespace before `@`, so it is part of the path, not an alias (mirrors the `#` adjacency rule).
        let conf = parse_conf("/tmp/a@x\n", Path::new("/home"), Path::new("/work"));
        assert_eq!(conf.roots, vec![PathBuf::from("/tmp/a@x")]);
        assert!(conf.alias_by_org.is_empty());
    }

    #[test]
    fn parse_conf_alias_first_occurrence_wins_for_same_basename() {
        let conf = parse_conf(
            "/a/foo   @First\n/b/foo   @Second\n",
            Path::new("/home"),
            Path::new("/work"),
        );
        // Both roots are kept (dedup is by absolute path); the alias binds to org=basename, first wins.
        assert_eq!(
            conf.roots,
            vec![PathBuf::from("/a/foo"), PathBuf::from("/b/foo")]
        );
        assert_eq!(
            conf.alias_by_org,
            BTreeMap::from([("foo".to_string(), "First".to_string())])
        );
    }

    #[test]
    fn parse_conf_alias_preserves_internal_whitespace_in_path() {
        let conf = parse_conf("/tmp/a  b   @Name\n", Path::new("/home"), Path::new("/work"));
        assert_eq!(conf.roots, vec![PathBuf::from("/tmp/a  b")]);
        assert_eq!(
            conf.alias_by_org,
            BTreeMap::from([("a  b".to_string(), "Name".to_string())])
        );
    }

    #[test]
    fn parse_conf_non_color_hash_is_comment_and_3digit_hex_ok() {
        assert_eq!(
            colors("/tmp/a  #f00  # これは説明\n/tmp/b  # 色なし\n"),
            BTreeMap::from([("a".to_string(), "#f00".to_string())])
        );
    }

    #[test]
    fn parse_conf_adjacent_hash_is_comment_not_color() {
        let conf = parse_conf("/tmp/x#f00\n", Path::new("/home"), Path::new("/work"));
        assert_eq!(conf.roots, vec![PathBuf::from("/tmp/x")]);
        assert!(conf.color_by_org.is_empty());
    }

    #[test]
    fn parse_conf_leading_color_token_line_is_dropped() {
        let conf = parse_conf(
            "#7aa2f7 /tmp/x\n/tmp/y\n",
            Path::new("/home"),
            Path::new("/work"),
        );
        assert_eq!(conf.roots, vec![PathBuf::from("/tmp/y")]);
        assert!(conf.color_by_org.is_empty());
    }

    #[test]
    fn parse_conf_preserves_internal_whitespace_in_path_and_org() {
        let conf = parse_conf(
            "/tmp/a  b\tc  #f00\n",
            Path::new("/home"),
            Path::new("/work"),
        );
        assert_eq!(conf.roots, vec![PathBuf::from("/tmp/a  b\tc")]);
        assert_eq!(
            conf.color_by_org,
            BTreeMap::from([("a  b\tc".to_string(), "#f00".to_string())])
        );
    }

    #[test]
    fn scan_repos_finds_git_worktrees_two_levels_deep() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path();
        // base itself is not a repo. Make base/repo-a (child) and base/group/repo-b (grandchild) repos.
        std::fs::create_dir_all(base.join("repo-a/.git")).unwrap();
        std::fs::create_dir_all(base.join("group/repo-b/.git")).unwrap();
        std::fs::create_dir_all(base.join(".hidden/repo-c/.git")).unwrap(); // hidden dir is ignored
        std::fs::create_dir_all(base.join("plain")).unwrap(); // no `.git` is ignored

        let conf = root.path().join("repos.conf");
        std::fs::write(&conf, format!("{}\n", base.display())).unwrap();

        let mut got: Vec<(String, String)> = scan_repos(&conf)
            .into_iter()
            .map(|r| (r.repo, r.path))
            .collect();
        got.sort();
        let org = basename(base);
        // org is base's basename. repo-a and repo-b are found; entries under .hidden and plain are excluded.
        assert_eq!(got.len(), 2);
        assert!(got.iter().any(|(repo, _)| repo == "repo-a"));
        assert!(got.iter().any(|(repo, _)| repo == "repo-b"));
        assert!(!got.iter().any(|(repo, _)| repo == "repo-c"));
        // every org is base's basename
        assert!(scan_repos(&conf).iter().all(|r| r.org == org));
    }

    #[test]
    fn scan_repos_nested_root_attributes_to_most_specific_and_dedups() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path();
        // "inner" is both a repo and a nested org root; "sub" lives under it; "plainrepo" is only under the parent.
        std::fs::create_dir_all(base.join("inner/.git")).unwrap();
        std::fs::create_dir_all(base.join("inner/sub/.git")).unwrap();
        std::fs::create_dir_all(base.join("plainrepo/.git")).unwrap();

        let conf = root.path().join("repos.conf");
        std::fs::write(&conf, format!("{0}\n{0}/inner\n", base.display())).unwrap();

        let scanned = scan_repos(&conf);

        let mut paths: Vec<String> = scanned.iter().map(|r| r.path.clone()).collect();
        paths.sort();
        let mut deduped = paths.clone();
        deduped.dedup();
        assert_eq!(paths, deduped, "a repo under a nested root must not be listed twice");

        let org_of = |repo: &str| {
            scanned
                .iter()
                .find(|r| r.repo == repo)
                .map(|r| r.org.clone())
        };
        assert_eq!(org_of("plainrepo"), Some(basename(base)));
        assert_eq!(org_of("inner"), Some("inner".to_string()));
        assert_eq!(org_of("sub"), Some("inner".to_string()));
    }

    #[test]
    fn scan_repos_includes_base_itself_when_repo() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().join("solo");
        std::fs::create_dir_all(base.join(".git")).unwrap();
        let conf = root.path().join("repos.conf");
        std::fs::write(&conf, format!("{}\n", base.display())).unwrap();

        let scanned = scan_repos(&conf);
        assert_eq!(scanned.len(), 1);
        assert_eq!(scanned[0].repo, "solo");
        assert_eq!(scanned[0].org, "solo");
    }

    #[test]
    fn classify_add_path_covers_ok_missing_and_duplicate() {
        let dir = tempfile::tempdir().unwrap();
        let conf = dir.path().join("repos.conf");
        let target = dir.path().join("myorg");
        std::fs::create_dir_all(&target).unwrap();
        let path = target.to_string_lossy().into_owned();

        // A new existing directory classifies as Ok with org = basename.
        assert_eq!(
            classify_add_path(&conf, &path),
            AddPathStatus::Ok("myorg".to_string())
        );
        // A path that does not resolve (`~user`) is PathUnresolved.
        assert_eq!(
            classify_add_path(&conf, "~nobody/x"),
            AddPathStatus::PathUnresolved
        );
        // A non-existent path is NotADirectory (existence folded in, matching add).
        assert_eq!(
            classify_add_path(&conf, &dir.path().join("nope").to_string_lossy()),
            AddPathStatus::NotADirectory
        );

        // Once registered, the same path (even via a `..` detour) is a Duplicate.
        append_root_to_conf(&conf, &path, None, None).unwrap();
        assert_eq!(classify_add_path(&conf, &path), AddPathStatus::Duplicate);
        let detour = format!("{}/../myorg", target.to_string_lossy());
        assert_eq!(classify_add_path(&conf, &detour), AddPathStatus::Duplicate);
    }

    #[test]
    fn browse_roots_includes_home_and_registered_root_parents() {
        let dir = tempfile::tempdir().unwrap();
        let conf = dir.path().join("repos.conf");
        let outside = dir.path().join("elsewhere");
        let org = outside.join("acme");
        std::fs::create_dir_all(&org).unwrap();
        append_root_to_conf(&conf, &org.to_string_lossy(), None, None).unwrap();

        let roots = browse_roots(&conf);
        // The parent of the registered root is browseable (orgs outside HOME stay reachable).
        assert!(roots.iter().any(|r| *r == outside));
        // HOME is included when set.
        if let Some(home) = std::env::var_os("HOME") {
            if !home.is_empty() {
                assert!(roots.iter().any(|r| *r == PathBuf::from(&home)));
            }
        }
    }

    #[test]
    fn browse_roots_excludes_shallow_parents() {
        // A root whose parent is a top-level system directory must NOT widen enumeration there.
        let dir = tempfile::tempdir().unwrap();
        let conf = dir.path().join("repos.conf");
        std::fs::write(&conf, "/opt/acme\n/Users\n").unwrap();
        let roots = browse_roots(&conf);
        assert!(!roots.iter().any(|r| *r == PathBuf::from("/opt"))); // parent depth 1
        assert!(!roots.iter().any(|r| *r == PathBuf::from("/"))); // parent of "/Users"
    }

    #[test]
    fn is_linked_worktree_distinguishes_worktree_from_main_and_submodule() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();

        let main = base.join("main");
        std::fs::create_dir_all(main.join(".git")).unwrap();
        assert!(!is_linked_worktree(&main));

        let worktree = base.join("wt");
        std::fs::create_dir_all(&worktree).unwrap();
        std::fs::write(
            worktree.join(".git"),
            "gitdir: /repo/.git/worktrees/wt\n",
        )
        .unwrap();
        assert!(is_linked_worktree(&worktree));

        let submodule = base.join("sub");
        std::fs::create_dir_all(&submodule).unwrap();
        std::fs::write(submodule.join(".git"), "gitdir: ../.git/modules/sub\n").unwrap();
        assert!(!is_linked_worktree(&submodule));

        // A submodule whose superproject lives under a directory literally named "worktrees" must
        // not be misread as a worktree: the gitdir still ends in modules/<name>, not worktrees/<name>.
        let nested = base.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(
            nested.join(".git"),
            "gitdir: /repo/worktrees/super/.git/modules/sub\n",
        )
        .unwrap();
        assert!(!is_linked_worktree(&nested));

        let plain = base.join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        assert!(!is_linked_worktree(&plain));
    }

    #[test]
    fn worktree_main_path_strips_git_worktrees_name_to_the_main_tree() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();

        let worktree = base.join("wt");
        std::fs::create_dir_all(&worktree).unwrap();
        std::fs::write(worktree.join(".git"), "gitdir: /repo/.git/worktrees/wt\n").unwrap();
        assert_eq!(
            worktree_main_path(&worktree),
            Some("/repo".to_string()),
            "the main tree is the gitdir target stripped of /.git/worktrees/<name>"
        );

        let main = base.join("main");
        std::fs::create_dir_all(main.join(".git")).unwrap();
        assert_eq!(worktree_main_path(&main), None);

        let submodule = base.join("sub");
        std::fs::create_dir_all(&submodule).unwrap();
        std::fs::write(submodule.join(".git"), "gitdir: /repo/.git/modules/sub\n").unwrap();
        assert_eq!(worktree_main_path(&submodule), None);
    }
}
