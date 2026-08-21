//! Cross-repo text search (the search panel). Handles argument building, rg JSON parsing, and running rg.
//! ripgrep runs as a single process over all target repos (the same search is never fired in parallel).

use std::collections::HashMap;
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::process::Command;

/// Request body for POST /api/search (`SearchRequest`).
#[derive(Deserialize)]
pub struct SearchRequest {
    pub query: String,
    /// Case sensitivity (defaults to smart-case).
    #[serde(rename = "matchCase", default)]
    pub match_case: bool,
    /// Whole-word match.
    #[serde(rename = "wholeWord", default)]
    pub whole_word: bool,
    /// Regular expression (false means a fixed string).
    #[serde(default)]
    pub regex: bool,
}

#[derive(Serialize)]
pub struct SearchMatch {
    pub line: u64,
    pub text: String,
    pub start: usize,
    pub end: usize,
}

#[derive(Serialize)]
pub struct SearchFile {
    pub org: String,
    pub repo: String,
    pub path: String,
    #[serde(rename = "relPath")]
    pub rel_path: String,
    pub matches: Vec<SearchMatch>,
}

#[derive(Serialize)]
pub struct SearchResponse {
    pub truncated: bool,
    pub files: Vec<SearchFile>,
}

/// A root to be scanned (the needed subset of a scanRepos result).
pub struct ScannedRoot {
    pub org: String,
    pub repo: String,
    pub path: String,
}

pub struct SearchLimits {
    pub max_total: usize,
    pub max_per_file: usize,
    pub max_bytes_per_line: usize,
}

pub const DEFAULT_SEARCH_LIMITS: SearchLimits = SearchLimits {
    max_total: 1000,
    max_per_file: 100,
    max_bytes_per_line: 500,
};

/// Builds the rg arguments from the search options (does not include the search paths).
/// query is always passed as `--regexp <query>` (as a positional, a leading `-` would be treated as a flag).
pub fn build_rg_args(req: &SearchRequest, limits: &SearchLimits) -> Vec<String> {
    let mut args = vec![
        "--json".to_string(),
        "--max-count".to_string(),
        limits.max_per_file.to_string(),
    ];
    if !req.regex {
        args.push("--fixed-strings".to_string());
    }
    if req.whole_word {
        args.push("--word-regexp".to_string());
    }
    if req.match_case {
        args.push("--case-sensitive".to_string());
    } else {
        args.push("--smart-case".to_string());
    }
    args.push("--regexp".to_string());
    args.push(req.query.clone());
    args
}

// ---- Only the needed fields of an rg --json line (unknown fields are ignored) ----

#[derive(Deserialize)]
struct RgLine {
    #[serde(rename = "type")]
    typ: Option<String>,
    data: Option<RgData>,
}

#[derive(Deserialize)]
struct RgData {
    path: Option<RgText>,
    lines: Option<RgText>,
    line_number: Option<u64>,
    submatches: Option<Vec<RgSub>>,
}

#[derive(Deserialize)]
struct RgText {
    text: Option<String>,
}

#[derive(Deserialize)]
struct RgSub {
    start: Option<usize>,
    end: Option<usize>,
}

fn strip_line_end(text: &str) -> &str {
    let t = text.strip_suffix('\n').unwrap_or(text);
    t.strip_suffix('\r').unwrap_or(t)
}

fn root_for<'a>(path: &str, roots: &'a [ScannedRoot]) -> Option<&'a ScannedRoot> {
    roots
        .iter()
        .find(|r| path == r.path || path.starts_with(&format!("{}/", r.path)))
}

/// Formats the output of `rg --json` (newline-delimited JSON) into a SearchResponse.
/// Lines other than `type: "match"`, those outside a scan root, and parse failures are ignored. Exceeding maxTotal sets truncated=true.
/// Preserves occurrence order and groups matches from the same file into a single entry.
pub fn parse_rg_json(stdout: &str, roots: &[ScannedRoot], limits: &SearchLimits) -> SearchResponse {
    let mut files: Vec<SearchFile> = Vec::new();
    let mut by_path: HashMap<String, usize> = HashMap::new();
    let mut total = 0usize;
    let mut truncated = false;

    for raw in stdout.split('\n') {
        if raw.trim().is_empty() {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<RgLine>(raw) else {
            continue;
        };
        if parsed.typ.as_deref() != Some("match") {
            continue;
        }
        let Some(data) = parsed.data else { continue };
        let (Some(path), Some(line)) = (data.path.and_then(|p| p.text), data.line_number) else {
            continue;
        };
        let Some(root) = root_for(&path, roots) else {
            continue;
        };

        if total >= limits.max_total {
            truncated = true;
            break;
        }
        total += 1;

        let sub = data.submatches.as_ref().and_then(|s| s.first());
        let raw_text = data.lines.and_then(|l| l.text).unwrap_or_default();
        let text: String = strip_line_end(&raw_text)
            .chars()
            .take(limits.max_bytes_per_line)
            .collect();
        let m = SearchMatch {
            line,
            text,
            start: sub.and_then(|s| s.start).unwrap_or(0),
            end: sub.and_then(|s| s.end).unwrap_or(0),
        };

        let idx = *by_path.entry(path.clone()).or_insert_with(|| {
            let rel_path = if path == root.path {
                root.repo.clone()
            } else {
                path[root.path.len() + 1..].to_string()
            };
            files.push(SearchFile {
                org: root.org.clone(),
                repo: root.repo.clone(),
                path: path.clone(),
                rel_path,
                matches: Vec::new(),
            });
            files.len() - 1
        });
        files[idx].matches.push(m);
    }

    SearchResponse { truncated, files }
}

/// rg not found or cannot be spawned.
#[derive(Debug)]
pub struct RipgrepUnavailable;

/// Runs `<program> <args> -- <paths...>` as a single process and returns stdout (no shell; 15s timeout).
/// `program` is the ripgrep executable, resolved to an absolute path by the caller so it launches under a
/// thin GUI/launchd PATH. Exit code 1 (no match) is normal. A spawn failure (rg absent) yields
/// `RipgrepUnavailable`. If paths is empty, rg is not started and an empty string is returned.
pub async fn run_ripgrep(
    program: &str,
    args: &[String],
    paths: &[String],
) -> Result<String, RipgrepUnavailable> {
    if paths.is_empty() {
        return Ok(String::new());
    }
    let mut cmd = Command::new(program);
    cmd.args(args)
        .arg("--")
        .args(paths)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let child = cmd.spawn().map_err(|_| RipgrepUnavailable)?;
    let output = match tokio::time::timeout(Duration::from_secs(15), child.wait_with_output()).await
    {
        Ok(Ok(o)) => o,
        // Timeout or wait failure is treated as empty (safe side: do not return partial results).
        _ => return Ok(String::new()),
    };
    // Adopt stdout for both exit code 0 (matches) and 1 (no match). 2 or higher is treated as empty.
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(query: &str, regex: bool, whole_word: bool, match_case: bool) -> SearchRequest {
        SearchRequest {
            query: query.to_string(),
            match_case,
            whole_word,
            regex,
        }
    }

    #[test]
    fn build_rg_args_default_is_fixed_strings_smart_case() {
        let a = build_rg_args(&req("foo", false, false, false), &DEFAULT_SEARCH_LIMITS);
        assert_eq!(
            a,
            vec![
                "--json",
                "--max-count",
                "100",
                "--fixed-strings",
                "--smart-case",
                "--regexp",
                "foo"
            ]
        );
    }

    #[test]
    fn build_rg_args_regex_wholeword_case() {
        let a = build_rg_args(&req("ba.r", true, true, true), &DEFAULT_SEARCH_LIMITS);
        assert_eq!(
            a,
            vec![
                "--json",
                "--max-count",
                "100",
                "--word-regexp",
                "--case-sensitive",
                "--regexp",
                "ba.r"
            ]
        );
    }

    fn roots() -> Vec<ScannedRoot> {
        vec![ScannedRoot {
            org: "org1".to_string(),
            repo: "repo-a".to_string(),
            path: "/r/org1/repo-a".to_string(),
        }]
    }

    #[test]
    fn parse_rg_json_groups_matches_and_computes_relpath() {
        // Equivalent to rg --json (a mix of begin/match/end/summary, with unknown fields).
        let stdout = concat!(
            r#"{"type":"begin","data":{"path":{"text":"/r/org1/repo-a/src/x.ts"}}}"#,
            "\n",
            r#"{"type":"match","data":{"path":{"text":"/r/org1/repo-a/src/x.ts"},"lines":{"text":"hello foo bar\n"},"line_number":3,"absolute_offset":0,"submatches":[{"match":{"text":"foo"},"start":6,"end":9}]}}"#,
            "\n",
            r#"{"type":"match","data":{"path":{"text":"/r/org1/repo-a/src/x.ts"},"lines":{"text":"foo again"},"line_number":10,"submatches":[{"start":0,"end":3}]}}"#,
            "\n",
            "\n",
            "not json",
            "\n",
            r#"{"type":"match","data":{"path":{"text":"/outside/y.ts"},"lines":{"text":"foo"},"line_number":1,"submatches":[{"start":0,"end":3}]}}"#,
            "\n",
            r#"{"type":"summary","data":{"stats":{"matches":2}}}"#,
            "\n",
        );
        let resp = parse_rg_json(stdout, &roots(), &DEFAULT_SEARCH_LIMITS);
        assert!(!resp.truncated);
        assert_eq!(resp.files.len(), 1); // /outside is excluded as it is outside the root
        let f = &resp.files[0];
        assert_eq!(f.org, "org1");
        assert_eq!(f.repo, "repo-a");
        assert_eq!(f.rel_path, "src/x.ts");
        assert_eq!(f.matches.len(), 2);
        assert_eq!(f.matches[0].line, 3);
        assert_eq!(f.matches[0].text, "hello foo bar"); // trailing newline removed
        assert_eq!((f.matches[0].start, f.matches[0].end), (6, 9));
    }

    #[test]
    fn parse_rg_json_truncates_at_max_total() {
        let limits = SearchLimits {
            max_total: 1,
            max_per_file: 100,
            max_bytes_per_line: 500,
        };
        let stdout = concat!(
            r#"{"type":"match","data":{"path":{"text":"/r/org1/repo-a/a"},"lines":{"text":"x"},"line_number":1,"submatches":[{"start":0,"end":1}]}}"#,
            "\n",
            r#"{"type":"match","data":{"path":{"text":"/r/org1/repo-a/b"},"lines":{"text":"y"},"line_number":2,"submatches":[{"start":0,"end":1}]}}"#,
            "\n",
        );
        let resp = parse_rg_json(stdout, &roots(), &limits);
        assert!(resp.truncated);
        assert_eq!(resp.files.len(), 1);
    }

    #[test]
    fn parse_rg_json_relpath_is_repo_when_match_at_root_path() {
        let stdout = concat!(
            r#"{"type":"match","data":{"path":{"text":"/r/org1/repo-a"},"lines":{"text":"z"},"line_number":1,"submatches":[{"start":0,"end":1}]}}"#,
            "\n",
        );
        let resp = parse_rg_json(stdout, &roots(), &DEFAULT_SEARCH_LIMITS);
        assert_eq!(resp.files[0].rel_path, "repo-a");
    }

    #[tokio::test]
    async fn run_ripgrep_empty_paths_returns_empty() {
        let out = run_ripgrep(
            "rg",
            &build_rg_args(&req("x", false, false, false), &DEFAULT_SEARCH_LIMITS),
            &[],
        )
        .await
        .unwrap();
        assert_eq!(out, "");
    }

    #[tokio::test]
    async fn run_ripgrep_finds_matches_via_resolved_absolute_path() {
        // Skip in environments without rg (CI has ripgrep installed).
        if std::process::Command::new("rg")
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }
        // Spawning by the resolved absolute path is what keeps search working under a thin GUI/launchd PATH.
        let program = crate::session_launch::resolve_program("rg");
        assert!(program.starts_with('/'), "rg should resolve to an absolute path: {program}");
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("f.txt"), "alpha NEEDLE omega\n").unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let args = build_rg_args(&req("NEEDLE", false, false, false), &DEFAULT_SEARCH_LIMITS);
        let stdout = run_ripgrep(&program, &args, std::slice::from_ref(&root))
            .await
            .unwrap();
        let roots = vec![ScannedRoot {
            org: "o".to_string(),
            repo: "r".to_string(),
            path: root,
        }];
        let resp = parse_rg_json(&stdout, &roots, &DEFAULT_SEARCH_LIMITS);
        assert_eq!(resp.files.len(), 1);
        assert_eq!(resp.files[0].matches[0].line, 1);
        assert!(resp.files[0].matches[0].text.contains("NEEDLE"));
    }
}
