//! Background task that notifies when the running bundle is outdated (#26). It polls GitHub's
//! `releases/latest` (which already excludes prereleases) once on startup and every 3h, compares the
//! latest stable tag against the running app version (`ZK_APP_VERSION`, injected by the Tauri shell from
//! `app.package_info().version`), and pushes an "update available" notification when a newer stable
//! release exists. Gated by the live `updateCheck` config flag and silent on any failure
//! (offline / non-2xx / parse). Dev builds (version `0.0.0`) never poll (no egress).
//!
//! SETTINGS' "Check for updates" runs the same check on demand via `check_now`, which — unlike the
//! background poll — reports up-to-date / failure back to the requester so the UI can give feedback (#62).
//!
//! The version-comparison behavior is canonicalized by the `tests` module below.

use std::sync::Arc;
use std::time::Duration;

use crate::control::ControlHub;

const UPDATE_CHECK_INTERVAL: Duration = Duration::from_secs(3 * 60 * 60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const LATEST_RELEASE_URL: &str =
    "https://api.github.com/repos/kounetsuman/zashiki/releases/latest";
const RELEASES_URL: &str = "https://github.com/kounetsuman/zashiki/releases/latest";

/// Parse the running app version. Returns None for the `0.0.0` dev placeholder or anything unparseable,
/// which both mean "don't check for updates" (so dev never emits outbound egress).
pub fn parse_running_version(current: &str) -> Option<semver::Version> {
    let v = semver::Version::parse(current.trim().trim_start_matches('v')).ok()?;
    (v != semver::Version::new(0, 0, 0)).then_some(v)
}

/// The newer stable version, if the release `tag_name` parses to something strictly newer than `current`.
/// Prerelease precedence applies (`1.0.0-rc.1 < 1.0.0`), so an rc build is correctly told a stable `1.0.0` is newer.
pub fn newer_release(current: &semver::Version, tag_name: &str) -> Option<semver::Version> {
    let latest = semver::Version::parse(tag_name.trim().trim_start_matches('v')).ok()?;
    (latest > *current).then_some(latest)
}

/// Extract `(tag_name, html_url)` from a `releases/latest` JSON body, comparing the tag against `current`.
/// Returns the newer `(version, url)` or None (not newer / unparseable / missing tag). Pure, for testability.
fn evaluate_release(current: &semver::Version, body: &str) -> Option<(String, String)> {
    let json: serde_json::Value = serde_json::from_str(body).ok()?;
    let tag = json.get("tag_name")?.as_str()?;
    let latest = newer_release(current, tag)?;
    let url = json
        .get("html_url")
        .and_then(|v| v.as_str())
        .unwrap_or(RELEASES_URL)
        .to_string();
    Some((latest.to_string(), url))
}

/// Blocking GET of the latest-release body (run on a blocking thread). None on offline / non-2xx / read error.
fn fetch_latest_release() -> Option<String> {
    ureq::get(LATEST_RELEASE_URL)
        .set("User-Agent", "zashiki-update-check")
        .set("Accept", "application/vnd.github+json")
        .timeout(REQUEST_TIMEOUT)
        .call()
        .ok()?
        .into_string()
        .ok()
}

/// The raw `tag_name` from a `releases/latest` body (e.g. `v0.14.0`) — the exact release the self-updater
/// pins the download to, so it installs the same version detection resolved rather than re-resolving with
/// different endpoint semantics. Pure, for testability.
pub fn latest_release_tag(body: &str) -> Option<String> {
    let json: serde_json::Value = serde_json::from_str(body).ok()?;
    json.get("tag_name")?.as_str().map(str::to_string)
}

/// Resolve the latest stable release tag over the network (blocking fetch on a blocking thread). None on
/// offline / non-2xx / unparseable, so the self-updater can report the failure while the app is still alive
/// rather than tearing it down for an update that cannot proceed.
pub async fn resolve_latest_tag() -> Option<String> {
    let body = tokio::task::spawn_blocking(fetch_latest_release).await.ok().flatten()?;
    latest_release_tag(&body)
}

/// Outcome of a single check, distinguishing "up to date" from "the fetch failed" so a manual
/// check can tell the user which happened (the background poll ignores both — it only acts on `Newer`).
#[derive(Debug, PartialEq, Eq)]
pub enum CheckOutcome {
    Newer { version: String, url: String },
    UpToDate,
    Failed,
}

/// Classify an already-fetched body (or a fetch failure, `None`). Pure, for testability. A present-but-not-newer
/// or unparseable body is treated as up to date — the manual UI distinguishes only "failed to reach GitHub".
fn evaluate_outcome(current: &semver::Version, fetched: Option<&str>) -> CheckOutcome {
    match fetched {
        None => CheckOutcome::Failed,
        Some(body) => match evaluate_release(current, body) {
            Some((version, url)) => CheckOutcome::Newer { version, url },
            None => CheckOutcome::UpToDate,
        },
    }
}

async fn check_now(current: &semver::Version) -> CheckOutcome {
    let fetched = tokio::task::spawn_blocking(fetch_latest_release)
        .await
        .ok()
        .flatten();
    evaluate_outcome(current, fetched.as_deref())
}

/// Run a check on demand (SETTINGS' "Check for updates") and record a notification when newer. Explicit user
/// intent, so it ignores the background `updateCheck` egress flag. Returns the outcome for the UI reply.
pub async fn run_manual_check(hub: &ControlHub, current: &semver::Version) -> CheckOutcome {
    let outcome = check_now(current).await;
    if let CheckOutcome::Newer { version, url } = &outcome {
        hub.record_update_available(version.clone(), url.clone(), crate::now_ms());
    }
    outcome
}

/// Resident task: poll once on startup then every 3h, gated per-tick by the live `updateCheck` flag.
/// No-ops entirely (never spawns network I/O) when the running version is the dev placeholder / unparseable.
pub fn spawn_update_checker(hub: Arc<ControlHub>, current: semver::Version) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(UPDATE_CHECK_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            if !hub.update_check_enabled() {
                continue;
            }
            if let CheckOutcome::Newer { version, url } = check_now(&current).await {
                hub.record_update_available(version, url, crate::now_ms());
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_running_version_treats_dev_placeholder_as_no_check() {
        // 0.0.0 (repo placeholder / dev shell) means "don't check" so no egress happens.
        assert_eq!(parse_running_version("0.0.0"), None);
        assert_eq!(parse_running_version(""), None);
        assert_eq!(parse_running_version("not-a-version"), None);
        assert_eq!(
            parse_running_version("0.1.1"),
            Some(semver::Version::new(0, 1, 1))
        );
        // A leading v (as used by some tools) is tolerated.
        assert_eq!(
            parse_running_version("v0.2.0"),
            Some(semver::Version::new(0, 2, 0))
        );
    }

    #[test]
    fn newer_release_compares_by_semver() {
        let current = semver::Version::new(0, 1, 1);
        assert_eq!(
            newer_release(&current, "v0.1.2"),
            Some(semver::Version::new(0, 1, 2))
        );
        assert_eq!(newer_release(&current, "v0.1.1"), None); // same
        assert_eq!(newer_release(&current, "v0.1.0"), None); // older
        assert_eq!(newer_release(&current, "garbage"), None); // unparseable
    }

    #[test]
    fn newer_release_honors_prerelease_precedence() {
        // An rc build is told the stable release of the same number is newer (1.0.0-rc.1 < 1.0.0).
        let rc = semver::Version::parse("1.0.0-rc.1").unwrap();
        assert_eq!(
            newer_release(&rc, "v1.0.0"),
            Some(semver::Version::new(1, 0, 0))
        );
        // ...but the very rc it is already running is not "newer".
        assert_eq!(newer_release(&rc, "v1.0.0-rc.1"), None);
    }

    #[test]
    fn evaluate_release_reads_tag_and_url() {
        let current = semver::Version::new(0, 1, 1);
        let body = r#"{"tag_name":"v0.2.0","html_url":"https://github.com/kounetsuman/zashiki/releases/tag/v0.2.0"}"#;
        assert_eq!(
            evaluate_release(&current, body),
            Some((
                "0.2.0".to_string(),
                "https://github.com/kounetsuman/zashiki/releases/tag/v0.2.0".to_string()
            ))
        );
    }

    #[test]
    fn evaluate_release_falls_back_to_releases_page_when_url_missing() {
        let current = semver::Version::new(0, 1, 1);
        let (version, url) = evaluate_release(&current, r#"{"tag_name":"v0.2.0"}"#).unwrap();
        assert_eq!(version, "0.2.0");
        assert_eq!(url, RELEASES_URL);
    }

    #[test]
    fn latest_release_tag_keeps_the_v_prefixed_tag_verbatim() {
        assert_eq!(latest_release_tag(r#"{"tag_name":"v0.14.0"}"#), Some("v0.14.0".to_string()));
        assert_eq!(latest_release_tag(r#"{"foo":1}"#), None);
        assert_eq!(latest_release_tag("not json"), None);
    }

    #[test]
    fn evaluate_release_none_for_not_newer_or_malformed() {
        let current = semver::Version::new(0, 2, 0);
        assert_eq!(evaluate_release(&current, r#"{"tag_name":"v0.1.0"}"#), None); // older
        assert_eq!(evaluate_release(&current, r#"{"foo":1}"#), None); // no tag_name
        assert_eq!(evaluate_release(&current, "not json"), None); // parse failure
    }

    #[test]
    fn evaluate_outcome_distinguishes_newer_uptodate_and_failed() {
        let current = semver::Version::new(0, 1, 1);
        assert_eq!(
            evaluate_outcome(&current, Some(r#"{"tag_name":"v0.2.0"}"#)),
            CheckOutcome::Newer {
                version: "0.2.0".to_string(),
                url: RELEASES_URL.to_string(),
            }
        );
        // Present-but-not-newer and unparseable both read as up to date; only a fetch failure is Failed.
        assert_eq!(
            evaluate_outcome(&current, Some(r#"{"tag_name":"v0.1.1"}"#)),
            CheckOutcome::UpToDate
        );
        assert_eq!(
            evaluate_outcome(&current, Some("not json")),
            CheckOutcome::UpToDate
        );
        assert_eq!(evaluate_outcome(&current, None), CheckOutcome::Failed);
    }
}
