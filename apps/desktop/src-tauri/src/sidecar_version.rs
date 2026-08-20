//! server version / ride-along-vs-stale decision (pure).

/// This build's own git SHA (embedded by build.rs). Compared against healthz's `git_sha` to avoid
/// riding along on a stale server. On builds where embedding is not possible it becomes "unknown",
/// in which case no comparison is done (with no basis to decide, it falls back to riding along).
pub const EXPECTED_GIT_SHA: &str = env!("ZK_GIT_SHA");

/// Result of the ride-along decision. `Reuse` rides along as before; `Stale` re-acquires (kill -> spawn our own).
#[derive(Debug, PartialEq, Eq)]
pub enum ReuseDecision {
    Reuse,
    Stale,
}

/// Extracts a top-level string field from healthz (JSON).
fn healthz_str_field(body: &str, key: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()?
        .get(key)?
        .as_str()
        .map(str::to_string)
}

/// The server's own pid as declared by healthz. None for old servers that don't support the build ID.
/// pid <= 0 is not accepted: passing a negative value or 0 to `libc::kill` sends the signal to a
/// process group or all processes (POSIX), so this structurally prevents self-destruction from a
/// corrupt or malicious healthz.
pub fn healthz_pid(body: &str) -> Option<i32> {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()?
        .get("pid")?
        .as_i64()
        .and_then(|p| i32::try_from(p).ok())
        .filter(|&p| p > 0)
}

/// Pure function that, assuming healthz is healthy ([`is_healthy_response`]==true), decides whether
/// it is OK to ride along.
/// - dev(debug) build: always rides along, since `git_sha` changes on every rebuild and would drag
///   the session down with it.
/// - this build's `git_sha` is "unknown" (a build where embedding is not possible): rides along, as
///   there is no basis to decide.
/// - healthz's `git_sha` matches expected: rides along.
/// - mismatch, or `git_sha` missing (an old server that doesn't support the build ID): stale.
pub fn classify_reuse(is_dev: bool, expected_sha: &str, body: &str) -> ReuseDecision {
    if is_dev || expected_sha == "unknown" {
        return ReuseDecision::Reuse;
    }
    match healthz_str_field(body, "git_sha") {
        Some(sha) if sha == expected_sha => ReuseDecision::Reuse,
        _ => ReuseDecision::Stale,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const CURRENT_BUILD: &str =
        r#"{"status":"ok","version":"0.0.0","git_sha":"abc123","pid":4242}"#;
    const OTHER_BUILD: &str =
        r#"{"status":"ok","version":"0.0.0","git_sha":"def456","pid":4242}"#;
    const LEGACY_BUILD: &str = r#"{"status":"ok"}"#; // an old server that doesn't support the build ID

    #[test]
    fn classify_reuse_は現行ビルドにのみ相乗りしstaleを掴み直す() {
        // release: git_sha matches -> ride along; mismatch/missing -> stale (re-acquire).
        assert_eq!(
            classify_reuse(false, "abc123", CURRENT_BUILD),
            ReuseDecision::Reuse
        );
        assert_eq!(
            classify_reuse(false, "abc123", OTHER_BUILD),
            ReuseDecision::Stale
        );
        assert_eq!(
            classify_reuse(false, "abc123", LEGACY_BUILD),
            ReuseDecision::Stale
        );
    }

    #[test]
    fn classify_reuse_はdevと不明ビルドでは常に相乗りする() {
        // dev(debug) changes git_sha on every rebuild = no comparison, to avoid dragging it down.
        assert_eq!(
            classify_reuse(true, "abc123", OTHER_BUILD),
            ReuseDecision::Reuse
        );
        // If this build's git_sha is unknown (embedding not possible), there is no basis to decide, so ride along.
        assert_eq!(
            classify_reuse(false, "unknown", OTHER_BUILD),
            ReuseDecision::Reuse
        );
    }

    #[test]
    fn healthz_pid_は数値pidのみ取り出す() {
        assert_eq!(healthz_pid(CURRENT_BUILD), Some(4242));
        assert_eq!(healthz_pid(LEGACY_BUILD), None); // no pid field
        assert_eq!(healthz_pid("not json"), None);
    }

    #[test]
    fn healthz_pid_は非正値や型違いを拒否する() {
        // pid <= 0 is not accepted, since it triggers a runaway kill (-1 = all processes, 0 = caller's pgrp).
        assert_eq!(healthz_pid(r#"{"status":"ok","pid":-1}"#), None);
        assert_eq!(healthz_pid(r#"{"status":"ok","pid":0}"#), None);
        // A type mismatch (string pid) yields None from as_i64.
        assert_eq!(healthz_pid(r#"{"status":"ok","pid":"4242"}"#), None);
        // A huge value exceeding i32 is rejected by try_from.
        assert_eq!(healthz_pid(r#"{"status":"ok","pid":9999999999}"#), None);
        // The valid minimum is accepted.
        assert_eq!(healthz_pid(r#"{"status":"ok","pid":1}"#), Some(1));
    }
}
