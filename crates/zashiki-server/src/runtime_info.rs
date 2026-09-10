//! Detected Claude Code CLI installations on this machine (which one is active + any leftovers).
//!
//! A machine often carries several `claude` installs at once (the native installer, an npm global, a
//! volta-managed npm global, Homebrew). Only the one resolved first on `$PATH` actually launches
//! Cockpit Terminals; the rest are leftovers that tend to confuse (a stale version, `claude update`
//! warnings). This module gathers them for the SETTINGS "Claude Code" tab. The source of truth for
//! classification and assembly is the `tests` below.

use std::collections::BTreeSet;
use std::path::Path;
use std::time::Duration;

use tokio::task::JoinSet;

use crate::protocol::{ClaudeInstall, InstallMethod};

/// A binary discovered on disk, with its install method already resolved by the discovery source
/// (npm membership is authoritative; everything else is inferred from the path).
struct DetectedInstall {
    method: InstallMethod,
    path: String,
    version: Option<String>,
}

/// Scans the machine for Claude Code CLI installations and returns them with the active one first.
pub async fn gather() -> Vec<ClaudeInstall> {
    let active = active_canonical_path();
    let mut candidates: Vec<(String, InstallMethod)> = Vec::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();

    // npm-discovered first so npm membership wins over the path-based guess for the same binary.
    for path in npm_bin_candidates().await {
        if seen.insert(path.clone()) {
            let method = classify_npm(&path);
            candidates.push((path, method));
        }
    }
    for dir in crate::session_launch::program_search_dirs() {
        if let Some(path) = canonical_if_executable(&Path::new(&dir).join("claude")) {
            if seen.insert(path.clone()) {
                let method = classify_method(&path);
                candidates.push((path, method));
            }
        }
    }
    // Probe versions concurrently so one slow/hung binary can't serialize the whole scan.
    let mut set: JoinSet<(usize, Option<String>)> = JoinSet::new();
    for (idx, (path, _)) in candidates.iter().enumerate() {
        let path = path.clone();
        set.spawn(async move { (idx, read_version(&path).await) });
    }
    let mut versions: Vec<Option<String>> = vec![None; candidates.len()];
    while let Some(Ok((idx, version))) = set.join_next().await {
        versions[idx] = version;
    }
    let detected = candidates
        .into_iter()
        .zip(versions)
        .map(|((path, method), version)| DetectedInstall { method, path, version })
        .collect();
    assemble(detected, active.as_deref())
}

/// The canonical (symlink-resolved) path of the `claude` that actually runs (first on `$PATH` and the
/// typical install locations), or None when none resolves.
fn active_canonical_path() -> Option<String> {
    let resolved = crate::session_launch::resolve_program_path("claude")?;
    Some(canonicalize_or(&resolved))
}

/// The install method of the active `claude`, for the update gate (`claude update` is offered only for
/// the native installer). Cheaper than [`gather`]: it classifies just the active path, no version
/// probing. Agrees with [`gather`]'s active entry on whether it is [`InstallMethod::Native`].
pub(crate) fn active_install_method() -> Option<InstallMethod> {
    active_canonical_path().map(|path| classify_method(&path))
}

/// Candidate binary from the npm global bin dir (`<npm root -g>/../../bin/claude`), even when that dir
/// is not on `$PATH` (a common volta setup, where npm's shim dir is not shimmed for `claude`).
async fn npm_bin_candidates() -> Vec<String> {
    let root = match tokio::process::Command::new("npm")
        .args(["root", "-g"])
        .output()
        .await
    {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).trim().to_string(),
        _ => return Vec::new(),
    };
    let Some(bin_dir) = npm_bin_dir_from_root(&root) else {
        return Vec::new();
    };
    canonical_if_executable(&Path::new(&bin_dir).join("claude"))
        .into_iter()
        .collect()
}

/// Runs `<path> --version` (bounded) and parses the version, or None on any failure.
async fn read_version(path: &str) -> Option<String> {
    let output = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::process::Command::new(path).arg("--version").output(),
    )
    .await
    .ok()?
    .ok()?;
    parse_version_output(&String::from_utf8_lossy(&output.stdout))
}

/// The canonical path of `path` if it is an executable file, else None.
fn canonical_if_executable(path: &Path) -> Option<String> {
    crate::session_launch::is_executable_file(path)
        .then(|| canonicalize_or(&path.to_string_lossy()))
}

/// The symlink-resolved path, falling back to the input when it cannot be canonicalized.
fn canonicalize_or(path: &str) -> String {
    std::fs::canonicalize(path)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_string())
}

/// The npm global bin dir derived from `npm root -g` (`<prefix>/lib/node_modules` → `<prefix>/bin`).
pub(crate) fn npm_bin_dir_from_root(root: &str) -> Option<String> {
    root.strip_suffix("/lib/node_modules")
        .or_else(|| root.strip_suffix("/node_modules"))
        .map(|prefix| format!("{prefix}/bin"))
}

/// The install method for a binary known to come from the npm global bin dir (volta manages node when
/// its dir is in the path, otherwise a plain npm global).
pub(crate) fn classify_npm(path: &str) -> InstallMethod {
    if path.contains("/.volta/") {
        InstallMethod::Volta
    } else {
        InstallMethod::NpmGlobal
    }
}

/// The install method inferred from a binary path found on `$PATH` / the typical install locations.
pub(crate) fn classify_method(path: &str) -> InstallMethod {
    if path.contains("/.volta/") {
        InstallMethod::Volta
    } else if path.contains("/.local/share/claude/")
        || path.contains("/.claude/local/")
        || path.contains("/.local/bin/claude")
    {
        InstallMethod::Native
    } else if path.contains("/homebrew/")
        || path.contains("/.linuxbrew/")
        || path.contains("/Cellar/")
    {
        InstallMethod::Homebrew
    } else if path.contains("/node_modules/") {
        InstallMethod::NpmGlobal
    } else {
        InstallMethod::Unknown
    }
}

/// Extracts the version from `claude --version` output (`"2.1.236 (Claude Code)"` → `"2.1.236"`).
/// Returns None when the first token is not version-like (no leading digit), so unreadable output
/// leaves the version blank rather than showing noise.
pub(crate) fn parse_version_output(output: &str) -> Option<String> {
    let token = output.split_whitespace().next()?;
    token
        .chars()
        .next()
        .filter(char::is_ascii_digit)
        .map(|_| token.to_string())
}

/// Turns detected binaries into the wire list: dedupe by path (first wins), mark the one matching the
/// active path, and order the active install first (discovery order is kept within each group).
fn assemble(detected: Vec<DetectedInstall>, active_path: Option<&str>) -> Vec<ClaudeInstall> {
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut installs: Vec<ClaudeInstall> = Vec::new();
    for d in detected {
        if !seen.insert(d.path.clone()) {
            continue;
        }
        let is_active = active_path == Some(d.path.as_str());
        installs.push(ClaudeInstall {
            method: d.method,
            path: d.path,
            version: d.version,
            is_active,
        });
    }
    installs.sort_by_key(|i| !i.is_active);
    installs
}

#[cfg(test)]
mod tests {
    use super::*;

    fn detected(method: InstallMethod, path: &str, version: Option<&str>) -> DetectedInstall {
        DetectedInstall {
            method,
            path: path.to_string(),
            version: version.map(str::to_string),
        }
    }

    #[test]
    fn parses_version_from_first_token() {
        assert_eq!(
            parse_version_output("2.1.236 (Claude Code)\n"),
            Some("2.1.236".to_string())
        );
        assert_eq!(parse_version_output("1.0.0\n"), Some("1.0.0".to_string()));
    }

    #[test]
    fn version_is_none_for_non_versionlike_or_empty() {
        assert_eq!(parse_version_output(""), None);
        assert_eq!(parse_version_output("command not found"), None);
        assert_eq!(parse_version_output("   "), None);
    }

    #[test]
    fn classifies_native_paths() {
        assert_eq!(
            classify_method("/Users/x/.local/share/claude/versions/2.1.236"),
            InstallMethod::Native
        );
        assert_eq!(
            classify_method("/Users/x/.claude/local/claude"),
            InstallMethod::Native
        );
    }

    #[test]
    fn classifies_homebrew_and_unknown_paths() {
        assert_eq!(
            classify_method("/opt/homebrew/Cellar/foo/1/bin/claude"),
            InstallMethod::Homebrew
        );
        assert_eq!(
            classify_method("/home/linuxbrew/.linuxbrew/bin/claude"),
            InstallMethod::Homebrew
        );
        assert_eq!(classify_method("/usr/local/bin/claude"), InstallMethod::Unknown);
    }

    #[test]
    fn npm_membership_beats_path_for_bin_dirs_without_node_modules() {
        // The npm global *binary* lives in a node bin dir (no `node_modules` in its path), so only the
        // discovery source can tell it apart — volta by its dir, otherwise a plain npm global.
        assert_eq!(
            classify_npm("/Users/x/.volta/tools/image/node/22.14.0/bin/claude"),
            InstallMethod::Volta
        );
        assert_eq!(
            classify_npm("/Users/x/.nvm/versions/node/v20/bin/claude"),
            InstallMethod::NpmGlobal
        );
    }

    #[test]
    fn npm_bin_dir_is_sibling_of_lib_node_modules() {
        assert_eq!(
            npm_bin_dir_from_root("/Users/x/.volta/tools/image/node/22.14.0/lib/node_modules"),
            Some("/Users/x/.volta/tools/image/node/22.14.0/bin".to_string())
        );
        assert_eq!(
            npm_bin_dir_from_root("/opt/homebrew/lib/node_modules"),
            Some("/opt/homebrew/bin".to_string())
        );
        assert_eq!(npm_bin_dir_from_root("/weird/path"), None);
    }

    #[test]
    fn assemble_marks_active_and_orders_it_first() {
        let installs = assemble(
            vec![
                detected(InstallMethod::Volta, "/v/bin/claude", Some("2.1.191")),
                detected(InstallMethod::Native, "/n/versions/2.1.236", Some("2.1.236")),
            ],
            Some("/n/versions/2.1.236"),
        );
        assert_eq!(installs.len(), 2);
        assert!(installs[0].is_active);
        assert_eq!(installs[0].path, "/n/versions/2.1.236");
        assert_eq!(installs[0].method, InstallMethod::Native);
        assert!(!installs[1].is_active);
        assert_eq!(installs[1].method, InstallMethod::Volta);
    }

    #[test]
    fn assemble_dedupes_by_path_keeping_first() {
        let installs = assemble(
            vec![
                detected(InstallMethod::NpmGlobal, "/dup/claude", Some("2.0.0")),
                detected(InstallMethod::Unknown, "/dup/claude", Some("2.0.0")),
            ],
            None,
        );
        assert_eq!(installs.len(), 1);
        assert_eq!(installs[0].method, InstallMethod::NpmGlobal);
    }

    #[test]
    fn assemble_with_no_active_leaves_all_inactive() {
        let installs = assemble(
            vec![detected(InstallMethod::Native, "/n/claude", None)],
            Some("/somewhere/else/claude"),
        );
        assert!(!installs[0].is_active);
    }
}
