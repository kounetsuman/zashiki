//! Reading and watching config.json (live-applied settings). Reads `notifySound`,
//! detects file changes, and publishes config.sync to `ControlHub`.
//!
//! Defaults are notifySound=true. Missing, corrupt, or empty files fall back to
//! defaults without panicking. On corruption (ok=false) the previous value is kept and nothing is
//! published. To avoid the notify crate, watching uses a tokio interval + mtime polling. The mtime
//! approach catches inode replacement (atomic rename save) via a re-stat each tick, but misses
//! writes that don't change the mtime and a second edit within the same second on
//! 1-second-granularity filesystems (weaker detection than an fs.watch-event approach). This is
//! harmless for the manual-save flow, a deliberate trade-off that prioritizes zero dependencies
//! and implementation simplicity.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use crate::control::{ConfigView, ControlHub};
use crate::protocol::{ElapsedBands, FooterBand, FooterThresholds, TokenBands, UsageBands};

/// Polling interval for config watching.
pub const CONFIG_POLL: Duration = Duration::from_millis(250);

/// Read and parse JSON. Returns None if unreadable or corrupt (deferring to default filling).
fn read_json(path: &Path) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// Parse config.json. Individual fields fall back to defaults when not a bool;
/// a non-object or missing object yields all defaults.
fn parse_config(input: Option<&serde_json::Value>) -> ConfigView {
    let obj = input.and_then(|v| v.as_object());
    let field = |key: &str, default: bool| {
        obj.and_then(|o| o.get(key))
            .and_then(|v| v.as_bool())
            .unwrap_or(default)
    };
    // The display language accepts only "ja"/"en"; unset or invalid values become None
    // (deferring to the client's browser detection).
    let language = obj
        .and_then(|o| o.get("language"))
        .and_then(|v| v.as_str())
        .filter(|s| *s == "ja" || *s == "en")
        .map(str::to_string);
    // Blank/whitespace is normalized to unset.
    let editor = obj
        .and_then(|o| o.get("editor"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    ConfigView {
        notify_sound: field("notifySound", true),
        update_check: field("updateCheck", true),
        language,
        account_usage: field("accountUsage", false),
        editor,
        footer_thresholds: parse_footer_thresholds(obj),
    }
}

/// One footer band, defaulting each sub-field independently and clamping the value to a finite,
/// non-negative number so a stale or hand-edited config can't feed the client a broken threshold.
fn read_band(
    ft: Option<&serde_json::Map<String, serde_json::Value>>,
    indicator: &str,
    band: &str,
    default: FooterBand,
) -> FooterBand {
    let node = ft.and_then(|o| o.get(indicator)).and_then(|v| v.get(band));
    let enabled = node
        .and_then(|n| n.get("enabled"))
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(default.enabled);
    let value = node
        .and_then(|n| n.get("value"))
        .and_then(serde_json::Value::as_i64)
        .filter(|n| *n >= 0)
        .unwrap_or(default.value);
    FooterBand::new(enabled, value)
}

fn parse_footer_thresholds(
    obj: Option<&serde_json::Map<String, serde_json::Value>>,
) -> FooterThresholds {
    let ft = obj
        .and_then(|o| o.get("footerThresholds"))
        .and_then(|v| v.as_object());
    let d = FooterThresholds::default();
    FooterThresholds {
        usage_percent: UsageBands {
            warn: read_band(ft, "usagePercent", "warn", d.usage_percent.warn),
            high: read_band(ft, "usagePercent", "high", d.usage_percent.high),
            crit: read_band(ft, "usagePercent", "crit", d.usage_percent.crit),
        },
        session_tokens: TokenBands {
            warn: read_band(ft, "sessionTokens", "warn", d.session_tokens.warn),
            crit: read_band(ft, "sessionTokens", "crit", d.session_tokens.crit),
        },
        elapsed_ms: ElapsedBands {
            crit: read_band(ft, "elapsedMs", "crit", d.elapsed_ms.crit),
        },
    }
}

/// Merge a single key into config.json and write it back atomically. Existing fields (including
/// unknown keys) are preserved. After the write, the watch picks up the mtime change and publishes
/// config.sync to all connections. Atomic replacement (temp→rename) keeps the watch from reading
/// half-written JSON (consistent with the parse-failure = keep-previous contract).
fn write_config_field(path: &Path, key: &str, value: serde_json::Value) -> std::io::Result<()> {
    let mut obj = match read_json(path) {
        Some(serde_json::Value::Object(m)) => m,
        _ => serde_json::Map::new(),
    };
    obj.insert(key.to_string(), value);
    let text = serde_json::to_string_pretty(&serde_json::Value::Object(obj))? + "\n";
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(".config.json.tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)
}

pub fn write_config_language(path: &Path, language: &str) -> std::io::Result<()> {
    write_config_field(path, "language", serde_json::Value::String(language.to_string()))
}

pub fn write_config_account_usage(path: &Path, enabled: bool) -> std::io::Result<()> {
    write_config_field(path, "accountUsage", serde_json::Value::Bool(enabled))
}

pub fn write_config_editor(path: &Path, editor: &str) -> std::io::Result<()> {
    write_config_field(path, "editor", serde_json::Value::String(editor.to_string()))
}

pub fn write_config_footer_thresholds(
    path: &Path,
    thresholds: &FooterThresholds,
) -> std::io::Result<()> {
    let value = serde_json::to_value(thresholds).unwrap_or(serde_json::Value::Null);
    write_config_field(path, "footerThresholds", value)
}

/// Read the live-applied settings along with whether they were read successfully.
/// ok=false means missing, corrupt, or empty (config is the
/// default-filled value). The watcher keeps the previous value and does not publish when ok=false.
pub fn read_config_result(path: &Path) -> (ConfigView, bool) {
    let json = read_json(path);
    (parse_config(json.as_ref()), json.is_some())
}

/// Read the live-applied settings. Missing, corrupt, or empty yields defaults.
pub fn read_config(path: &Path) -> ConfigView {
    read_config_result(path).0
}

fn file_mtime(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// Spawn a resident task that periodically polls config.json and, on mtime change, re-reads
/// it and publishes config.sync to the hub.
/// ok=false (missing or corrupt) keeps the previous value and does not publish. The mtime at
/// startup is ignored as the initial value (the startup delivery is handled by connect_messages
/// on control connect, so only subsequent changes are pushed). The baseline mtime is captured
/// synchronously before spawning, so a config change during the task's scheduling delay isn't
/// swallowed into the baseline.
pub fn spawn_config_watch(
    path: PathBuf,
    hub: Arc<ControlHub>,
    poll: Duration,
) -> tokio::task::JoinHandle<()> {
    let mut last_mtime = file_mtime(&path);
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(poll);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            let mtime = file_mtime(&path);
            if mtime == last_mtime {
                continue;
            }
            last_mtime = mtime;
            let (config, ok) = read_config_result(&path);
            if ok {
                hub.publish_config(config);
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::ServerMessage;
    use serde_json::json;

    fn parse(v: serde_json::Value) -> ConfigView {
        parse_config(Some(&v))
    }

    #[test]
    fn parse_config_reads_notify_sound() {
        let c = parse(json!({"notifySound": false}));
        assert!(!c.notify_sound);
    }

    #[test]
    fn parse_config_default_notify_on() {
        // Missing keys use the defaults (notifySound=true).
        let c = parse(json!({}));
        assert!(c.notify_sound);
    }

    #[test]
    fn parse_config_update_check_defaults_on_and_reads_bool() {
        // Missing key defaults to on (opt-out flag); an explicit false disables the egress; a wrong type falls back to on.
        assert!(parse(json!({})).update_check);
        assert!(!parse(json!({"updateCheck": false})).update_check);
        assert!(parse(json!({"updateCheck": "no"})).update_check);
    }

    #[test]
    fn parse_config_wrong_type_field_falls_back_to_default() {
        // zod `.catch()`: a field with a mismatched type falls back to the default (other fields are kept).
        let c = parse(json!({"notifySound": "yes", "updateCheck": false}));
        assert!(c.notify_sound); // string → default true
        assert!(!c.update_check); // other fields are kept
    }

    #[test]
    fn parse_config_non_object_is_all_defaults() {
        let c = parse(json!(42));
        assert!(c.notify_sound);
        assert_eq!(c.language, None);
    }

    #[test]
    fn parse_config_reads_language_ja_en_only() {
        assert_eq!(parse(json!({"language": "ja"})).language, Some("ja".into()));
        assert_eq!(parse(json!({"language": "en"})).language, Some("en".into()));
        // Unsupported values, type mismatches, and missing keys become None (= deferring to the client's browser detection).
        assert_eq!(parse(json!({"language": "fr"})).language, None);
        assert_eq!(parse(json!({"language": 1})).language, None);
        assert_eq!(parse(json!({})).language, None);
    }

    #[test]
    fn write_config_language_sets_and_preserves_other_fields() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, r#"{"notifySound": false}"#).unwrap();

        write_config_language(&path, "en").unwrap();
        let c = read_config(&path);
        assert_eq!(c.language, Some("en".into()));
        assert!(!c.notify_sound); // existing fields are preserved

        // Overwriting also works.
        write_config_language(&path, "ja").unwrap();
        assert_eq!(read_config(&path).language, Some("ja".into()));
    }

    #[test]
    fn write_config_language_creates_file_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/config.json");
        write_config_language(&path, "ja").unwrap();
        assert_eq!(read_config(&path).language, Some("ja".into()));
    }

    #[test]
    fn parse_config_account_usage_defaults_off_and_reads_bool() {
        assert!(!parse(json!({})).account_usage);
        assert!(parse(json!({"accountUsage": true})).account_usage);
        assert!(!parse(json!({"accountUsage": "yes"})).account_usage);
    }

    #[test]
    fn write_config_account_usage_sets_and_preserves_other_fields() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, r#"{"language": "en"}"#).unwrap();

        write_config_account_usage(&path, true).unwrap();
        let c = read_config(&path);
        assert!(c.account_usage);
        assert_eq!(c.language, Some("en".into())); // existing fields are preserved

        write_config_account_usage(&path, false).unwrap();
        assert!(!read_config(&path).account_usage);
    }

    #[test]
    fn parse_config_reads_editor_and_treats_blank_as_unset() {
        assert_eq!(parse(json!({"editor": "code -w"})).editor, Some("code -w".into()));
        // Surrounding whitespace is trimmed; a blank or whitespace-only value is unset (fall back to ZK_EDITOR / cursor -g).
        assert_eq!(parse(json!({"editor": "  vim  "})).editor, Some("vim".into()));
        assert_eq!(parse(json!({"editor": "   "})).editor, None);
        assert_eq!(parse(json!({"editor": ""})).editor, None);
        assert_eq!(parse(json!({"editor": 1})).editor, None);
        assert_eq!(parse(json!({})).editor, None);
    }

    #[test]
    fn write_config_editor_sets_and_preserves_other_fields() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, r#"{"language": "en"}"#).unwrap();

        write_config_editor(&path, "code -w").unwrap();
        let c = read_config(&path);
        assert_eq!(c.editor, Some("code -w".into()));
        assert_eq!(c.language, Some("en".into())); // existing fields are preserved

        // Clearing writes a blank value, which reads back as unset.
        write_config_editor(&path, "").unwrap();
        assert_eq!(read_config(&path).editor, None);
    }

    #[test]
    fn parse_config_footer_thresholds_default_when_absent() {
        assert_eq!(parse(json!({})).footer_thresholds, FooterThresholds::default());
    }

    #[test]
    fn parse_config_footer_thresholds_merges_per_field_and_clamps() {
        let c = parse(json!({
            "footerThresholds": {
                "usagePercent": { "warn": { "enabled": false, "value": 40 } },
                "elapsedMs": { "crit": { "value": -5 } }
            }
        }));
        // The specified band is honored.
        assert_eq!(c.footer_thresholds.usage_percent.warn, FooterBand::new(false, 40));
        // Unspecified bands keep their defaults (no drop to zero).
        let d = FooterThresholds::default();
        assert_eq!(c.footer_thresholds.usage_percent.high, d.usage_percent.high);
        assert_eq!(c.footer_thresholds.session_tokens, d.session_tokens);
        // A negative value is rejected back to the default.
        assert_eq!(c.footer_thresholds.elapsed_ms.crit, d.elapsed_ms.crit);
    }

    #[test]
    fn write_config_footer_thresholds_roundtrips_and_preserves_other_fields() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, r#"{"language": "en"}"#).unwrap();

        let mut t = FooterThresholds::default();
        t.usage_percent.crit = FooterBand::new(false, 88);
        write_config_footer_thresholds(&path, &t).unwrap();

        let c = read_config(&path);
        assert_eq!(c.footer_thresholds, t);
        assert_eq!(c.language, Some("en".into())); // existing fields are preserved
    }

    #[test]
    fn read_config_result_missing_file_is_defaults_not_ok() {
        let (c, ok) = read_config_result(Path::new("/no/such/config.json"));
        assert!(!ok);
        assert!(c.notify_sound);
    }

    #[test]
    fn read_config_result_broken_json_is_defaults_not_ok() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, "{ not json").unwrap();
        let (c, ok) = read_config_result(&path);
        assert!(!ok);
        assert!(c.notify_sound);
    }

    #[test]
    fn read_config_result_valid_is_ok() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, r#"{"notifySound": false}"#).unwrap();
        let (c, ok) = read_config_result(&path);
        assert!(ok);
        assert!(!c.notify_sound);
    }

    fn empty_hub() -> Arc<ControlHub> {
        ControlHub::new(
            ConfigView::default(),
            vec![],
            crate::status_poller::StateSnapshot {
                sessions: vec![],
                orgs: vec![],
                org_colors: std::collections::BTreeMap::new(),
                org_aliases: std::collections::BTreeMap::new(),
            },
        )
    }

    /// Waits until the watch captures the file's initial mtime as its baseline (the startup value is not
    /// delivered; the design only detects changes after the baseline, so the test mutates after this capture).
    async fn settle() {
        tokio::time::sleep(Duration::from_millis(60)).await;
    }

    #[tokio::test]
    async fn watch_publishes_config_sync_on_change() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        // Place the initial state (equivalent to defaults) first and let the watch capture the baseline mtime.
        std::fs::write(&path, r#"{"notifySound": true}"#).unwrap();
        let hub = empty_hub();
        let mut rx = hub.subscribe();
        let _task = spawn_config_watch(path.clone(), hub.clone(), Duration::from_millis(10));
        settle().await;

        // Change (notifySound off) → detected, re-read, and published.
        std::fs::write(&path, r#"{"notifySound": false}"#).unwrap();

        let msg = tokio::time::timeout(Duration::from_secs(3), rx.recv())
            .await
            .expect("watch should publish within timeout")
            .expect("broadcast open");
        match msg {
            ServerMessage::ConfigSync { notify_sound, .. } => {
                assert!(!notify_sound);
            }
            other => panic!("expected config.sync, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn watch_keeps_previous_value_on_broken_write() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, r#"{"notifySound": true}"#).unwrap();
        let hub = empty_hub();
        let mut rx = hub.subscribe();
        let _task = spawn_config_watch(path.clone(), hub.clone(), Duration::from_millis(10));
        settle().await;

        // Writing broken JSON changes the mtime but does not publish because ok=false (the previous value is kept).
        std::fs::write(&path, "{ broken").unwrap();
        let got = tokio::time::timeout(Duration::from_millis(200), rx.recv()).await;
        assert!(got.is_err(), "broken write must not publish config.sync");

        // A subsequent valid write is published = the watch only "ignored" the corruption and is still alive
        // (the ok gate explicitly verifies "fired but did not publish", distinguishing it from mere unresponsiveness).
        std::fs::write(&path, r#"{"notifySound": false}"#).unwrap();
        let msg = tokio::time::timeout(Duration::from_secs(3), rx.recv())
            .await
            .expect("valid write after broken should publish")
            .expect("broadcast open");
        assert!(
            matches!(
                msg,
                ServerMessage::ConfigSync { notify_sound: false, .. }
            ),
            "expected config.sync(notifySound=false) after recovery, got {msg:?}"
        );
    }
}
