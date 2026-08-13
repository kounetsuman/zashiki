//! Reading and watching config.json (live-applied settings). Port of TS
//! `packages/server/src/infra/config.ts` + `config-watch.ts`. Reads `notifySound`/`debug`,
//! detects file changes, and publishes config.sync to `ControlHub` (TS `app.updateConfig`).
//!
//! Defaults are notifySound=true / debug=false (TS `DEFAULT_CONFIG`). Missing, corrupt, or
//! empty files fall back to defaults without panicking (the fallback contract of TS
//! `parseConfig`). On corruption (ok=false) the previous value is kept and nothing is
//! published. This port avoids the notify crate, using a tokio interval + mtime polling
//! instead. The mtime approach catches inode replacement (atomic rename save) via a re-stat
//! each tick, but misses writes that don't change the mtime and a second edit within the same
//! second on 1-second-granularity filesystems (weaker detection than the fs.watch event
//! approach in TS). This is harmless for the manual-save flow, a deliberate trade-off that
//! prioritizes zero dependencies and implementation simplicity.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use crate::control::{ConfigView, ControlHub};

/// Polling interval for config watching (equivalent to the TS directory watch + 150ms debounce).
pub const CONFIG_POLL: Duration = Duration::from_millis(250);

/// Read and parse JSON. Returns None if unreadable or corrupt (deferring to default filling; TS `readJson`).
fn read_json(path: &Path) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// Parse config.json. Individual fields fall back to defaults when not a bool (zod `.catch()`);
/// a non-object or missing object yields all defaults (TS `parseConfig`).
fn parse_config(input: Option<&serde_json::Value>) -> ConfigView {
    let obj = input.and_then(|v| v.as_object());
    let field = |key: &str, default: bool| {
        obj.and_then(|o| o.get(key))
            .and_then(|v| v.as_bool())
            .unwrap_or(default)
    };
    // The display language accepts only "ja"/"en"; unset or invalid values become None
    // (deferring to the client's browser detection; equivalent to zod `.enum().nullable().catch(null)`).
    let language = obj
        .and_then(|o| o.get("language"))
        .and_then(|v| v.as_str())
        .filter(|s| *s == "ja" || *s == "en")
        .map(str::to_string);
    ConfigView {
        notify_sound: field("notifySound", true),
        debug: field("debug", false),
        language,
    }
}

/// Write the display language into config.json (read the existing JSON, update only the
/// `language` key, and write it back atomically). Existing fields (notifySound/debug/unknown
/// keys) are preserved. After the write, the watch picks up the mtime change and publishes
/// config.sync to all connections. Atomic replacement (temp→rename) keeps the watch from
/// reading half-written JSON (consistent with the parse-failure = keep-previous contract).
pub fn write_config_language(path: &Path, language: &str) -> std::io::Result<()> {
    let mut obj = match read_json(path) {
        Some(serde_json::Value::Object(m)) => m,
        _ => serde_json::Map::new(),
    };
    obj.insert(
        "language".to_string(),
        serde_json::Value::String(language.to_string()),
    );
    let text = serde_json::to_string_pretty(&serde_json::Value::Object(obj))? + "\n";
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(".config.json.tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)
}

/// Read the live-applied settings along with whether they were read successfully (TS
/// `readConfigResult`). ok=false means missing, corrupt, or empty (config is the
/// default-filled value). The watcher keeps the previous value and does not publish when ok=false.
pub fn read_config_result(path: &Path) -> (ConfigView, bool) {
    let json = read_json(path);
    (parse_config(json.as_ref()), json.is_some())
}

/// Read the live-applied settings (TS `readConfig`). Missing, corrupt, or empty yields defaults.
pub fn read_config(path: &Path) -> ConfigView {
    read_config_result(path).0
}

fn file_mtime(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// Spawn a resident task that periodically polls config.json and, on mtime change, re-reads
/// it and publishes config.sync to the hub (TS `watchConfig` → `onChange` → `updateConfig`).
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
    fn parse_config_reads_both_fields() {
        let c = parse(json!({"notifySound": false, "debug": true}));
        assert!(!c.notify_sound);
        assert!(c.debug);
    }

    #[test]
    fn parse_config_defaults_are_notify_on_debug_off() {
        // Missing keys use the defaults (notifySound=true / debug=false).
        let c = parse(json!({}));
        assert!(c.notify_sound);
        assert!(!c.debug);
    }

    #[test]
    fn parse_config_wrong_type_field_falls_back_to_default() {
        // zod `.catch()`: a field with a mismatched type falls back to the default (other fields are kept).
        let c = parse(json!({"notifySound": "yes", "debug": true}));
        assert!(c.notify_sound); // string → default true
        assert!(c.debug);
    }

    #[test]
    fn parse_config_non_object_is_all_defaults() {
        let c = parse(json!(42));
        assert!(c.notify_sound);
        assert!(!c.debug);
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
        std::fs::write(&path, r#"{"notifySound": false, "debug": true}"#).unwrap();

        write_config_language(&path, "en").unwrap();
        let c = read_config(&path);
        assert_eq!(c.language, Some("en".into()));
        assert!(!c.notify_sound); // existing fields are preserved
        assert!(c.debug);

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
    fn read_config_result_missing_file_is_defaults_not_ok() {
        let (c, ok) = read_config_result(Path::new("/no/such/config.json"));
        assert!(!ok);
        assert!(c.notify_sound);
        assert!(!c.debug);
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
        std::fs::write(&path, r#"{"notifySound": false, "debug": true}"#).unwrap();
        let (c, ok) = read_config_result(&path);
        assert!(ok);
        assert!(!c.notify_sound);
        assert!(c.debug);
    }

    fn empty_hub() -> Arc<ControlHub> {
        ControlHub::new(
            ConfigView::default(),
            vec![],
            crate::status_poller::StateSnapshot {
                sessions: vec![],
                orgs: vec![],
                org_colors: std::collections::BTreeMap::new(),
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
        std::fs::write(&path, r#"{"notifySound": true, "debug": false}"#).unwrap();
        let hub = empty_hub();
        let mut rx = hub.subscribe();
        let _task = spawn_config_watch(path.clone(), hub.clone(), Duration::from_millis(10));
        settle().await;

        // Change (notifySound off / debug on) → detected, re-read, and published.
        std::fs::write(&path, r#"{"notifySound": false, "debug": true}"#).unwrap();

        let msg = tokio::time::timeout(Duration::from_secs(3), rx.recv())
            .await
            .expect("watch should publish within timeout")
            .expect("broadcast open");
        match msg {
            ServerMessage::ConfigSync { notify_sound, debug, .. } => {
                assert!(!notify_sound);
                assert!(debug);
            }
            other => panic!("expected config.sync, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn watch_keeps_previous_value_on_broken_write() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, r#"{"notifySound": true, "debug": false}"#).unwrap();
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
        std::fs::write(&path, r#"{"notifySound": false, "debug": true}"#).unwrap();
        let msg = tokio::time::timeout(Duration::from_secs(3), rx.recv())
            .await
            .expect("valid write after broken should publish")
            .expect("broadcast open");
        assert!(
            matches!(
                msg,
                ServerMessage::ConfigSync { notify_sound: false, debug: true, .. }
            ),
            "expected config.sync(false,true) after recovery, got {msg:?}"
        );
    }
}
