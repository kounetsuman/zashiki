//! Pure merge/unmerge of `~/.claude/settings.json` for zashiki's Claude Code integration
//! (hooks + statusLine). No I/O — the infra adapter (`claude_settings_io`) owns the fs. `cargo test`
//! in this module is the canonical spec; the invariants (idempotent byte-identical no-op, foreign
//! entries preserved, `unregister(register(x)) == x`) are pinned there.

use serde_json::{json, Map, Value};

pub const NOTIFY_SCRIPT: &str = "notify-event.sh";
pub const STATUSLINE_SCRIPT: &str = "statusline.sh";
/// Claude Code's `refreshInterval` (seconds): re-runs the statusLine on a timer on top of its
/// event-driven renders, so the account-usage footer keeps refreshing rate_limits while a session
/// idles at a reached limit. Added only when zashiki owns the whole statusLine; wrapping a user's
/// command leaves their sibling fields (a refreshInterval of their own included) untouched.
const STATUSLINE_REFRESH_INTERVAL_SECS: u64 = 10;
const LEGACY_STATUSLINE_PREFIX: &str = "ZK_LEGACY_STATUSLINE=";
/// Env-assignment prefix zashiki writes on every command it registers. An entry is "ours" iff it
/// carries this marker or its command path equals the currently resolved script — path-independent so
/// entries survive the app moving, yet never matching a user's own same-named script.
const MARKER_PREFIX: &str = "ZK_ZASHIKI=";
const MARKER_ASSIGNMENT: &str = "ZK_ZASHIKI=1";

/// (Claude Code hook event name, the `kind` arg passed to notify-event.sh).
const EVENTS: [(&str, &str); 5] = [
    ("UserPromptSubmit", "prompt"),
    ("PostToolUse", "tool"),
    ("Notification", "waiting"),
    ("Stop", "done"),
    ("SubagentStop", "subagent_end"),
];

/// Absolute paths to the two bundled scripts, derived from the resolved hooks directory.
#[derive(Debug, Clone)]
pub struct ScriptPaths {
    pub notify_event: String,
    pub statusline: String,
}

impl ScriptPaths {
    pub fn from_hooks_dir(dir: &str) -> Self {
        let dir = dir.trim_end_matches('/');
        Self {
            notify_event: format!("{dir}/{NOTIFY_SCRIPT}"),
            statusline: format!("{dir}/{STATUSLINE_SCRIPT}"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RegistrationStatus {
    /// Every hook event in `EVENTS` carries a zashiki entry.
    pub hooks_registered: bool,
    /// A zashiki statusLine (plain or wrapping a legacy one) is present.
    pub status_line_registered: bool,
    /// A non-zashiki statusLine occupies the slot (registering will wrap it to preserve it).
    pub status_line_conflict: bool,
}

// ---- shell quoting / tokenizing (the encoder and its exact inverse) ----

/// POSIX single-quote escaping: wrap in `'…'`, and render an embedded `'` as `'\''`.
/// `shell_split` is the exact inverse, so `split(shq(s)) == [s]` for any `s` (see tests).
fn shq(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        if c == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

/// Splits a command string into shell words, honoring single quotes and backslash escapes — enough
/// to invert `shq` and to isolate the command token from leading `VAR=value` env assignments.
fn shell_split(s: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut cur = String::new();
    let mut started = false;
    let mut in_single = false;
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if in_single {
            if c == '\'' {
                in_single = false;
            } else {
                cur.push(c);
            }
            continue;
        }
        match c {
            '\'' => {
                started = true;
                in_single = true;
            }
            '\\' => {
                if let Some(n) = chars.next() {
                    cur.push(n);
                    started = true;
                }
            }
            c if c.is_whitespace() => {
                if started {
                    words.push(std::mem::take(&mut cur));
                    started = false;
                }
            }
            c => {
                cur.push(c);
                started = true;
            }
        }
    }
    if started {
        words.push(cur);
    }
    words
}

fn is_env_assignment(word: &str) -> bool {
    match word.find('=') {
        Some(0) | None => false,
        Some(eq) => word[..eq]
            .chars()
            .enumerate()
            .all(|(i, c)| if i == 0 { c.is_ascii_alphabetic() || c == '_' } else { c.is_ascii_alphanumeric() || c == '_' }),
    }
}

/// The parsed view of a command string: leading env assignments (our marker + any legacy statusLine)
/// and the command path token that follows them.
struct ParsedCommand {
    command_token: Option<String>,
    legacy_statusline: Option<String>,
    has_marker: bool,
}

fn parse_command(command: &str) -> ParsedCommand {
    let words = shell_split(command);
    let mut i = 0;
    let mut legacy = None;
    let mut has_marker = false;
    while i < words.len() && is_env_assignment(&words[i]) {
        if let Some(rest) = words[i].strip_prefix(LEGACY_STATUSLINE_PREFIX) {
            legacy = Some(rest.to_string());
        } else if words[i].starts_with(MARKER_PREFIX) {
            has_marker = true;
        }
        i += 1;
    }
    ParsedCommand {
        command_token: words.get(i).cloned(),
        legacy_statusline: legacy,
        has_marker,
    }
}

/// A command is zashiki's iff it carries the marker (survives the app moving) or its command path is
/// the currently resolved script (recognizes a hand-registered command at the current location).
fn command_is_ours(command: &str, our_path: &str) -> bool {
    let parsed = parse_command(command);
    parsed.has_marker || parsed.command_token.as_deref() == Some(our_path)
}

// ---- command builders ----

fn hook_command(paths: &ScriptPaths, kind: &str) -> String {
    format!("{} {} {}", MARKER_ASSIGNMENT, shq(&paths.notify_event), kind)
}

fn statusline_plain(paths: &ScriptPaths) -> String {
    format!("{} {}", MARKER_ASSIGNMENT, shq(&paths.statusline))
}

fn statusline_wrapped(paths: &ScriptPaths, legacy_original: &str) -> String {
    format!(
        "{} {}{} {}",
        MARKER_ASSIGNMENT,
        LEGACY_STATUSLINE_PREFIX,
        shq(legacy_original),
        shq(&paths.statusline),
    )
}

fn desired_hook_entry(paths: &ScriptPaths, kind: &str) -> Value {
    json!({ "hooks": [ { "type": "command", "command": hook_command(paths, kind) } ] })
}

fn entry_is_ours_hook(entry: &Value, notify_path: &str) -> bool {
    entry
        .get("hooks")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items.iter().any(|it| {
                it.get("command")
                    .and_then(Value::as_str)
                    .is_some_and(|cmd| command_is_ours(cmd, notify_path))
            })
        })
}

// ---- register ----

pub fn merge_register(current: &Value, paths: &ScriptPaths) -> (Value, bool) {
    let mut next = current.clone();
    let root = ensure_object(&mut next);
    register_hooks(root, paths);
    register_statusline(root, paths);
    let changed = &next != current;
    (next, changed)
}

fn register_hooks(root: &mut Map<String, Value>, paths: &ScriptPaths) {
    let hooks = match root.entry("hooks").or_insert_with(|| Value::Object(Map::new())) {
        Value::Object(m) => m,
        _ => return,
    };
    for (event, kind) in EVENTS {
        let slot = hooks.entry(event.to_string()).or_insert_with(|| Value::Array(Vec::new()));
        let Some(arr) = slot.as_array_mut() else { continue };
        let desired = desired_hook_entry(paths, kind);
        let ours: Vec<usize> = arr
            .iter()
            .enumerate()
            .filter(|(_, e)| entry_is_ours_hook(e, &paths.notify_event))
            .map(|(i, _)| i)
            .collect();
        if ours.len() == 1 && arr[ours[0]] == desired {
            continue;
        }
        for &i in ours.iter().rev() {
            arr.remove(i);
        }
        arr.push(desired);
    }
}

fn register_statusline(root: &mut Map<String, Value>, paths: &ScriptPaths) {
    match root.get("statusLine") {
        None => {
            root.insert(
                "statusLine".to_string(),
                json!({
                    "type": "command",
                    "command": statusline_plain(paths),
                    "refreshInterval": STATUSLINE_REFRESH_INTERVAL_SECS,
                }),
            );
        }
        Some(Value::Object(_)) => {
            let obj = root.get_mut("statusLine").and_then(Value::as_object_mut).unwrap();
            let Some(cmd) = obj.get("command").and_then(Value::as_str).map(str::to_string) else {
                return;
            };
            let parsed = parse_command(&cmd);
            let is_ours = parsed.has_marker || parsed.command_token.as_deref() == Some(paths.statusline.as_str());
            let legacy = if is_ours { parsed.legacy_statusline } else { Some(cmd.clone()) };
            let desired = match &legacy {
                Some(legacy) => statusline_wrapped(paths, legacy),
                None => statusline_plain(paths),
            };
            if cmd != desired {
                obj.insert("command".to_string(), Value::String(desired));
            }
            if legacy.is_none() {
                obj.insert(
                    "refreshInterval".to_string(),
                    json!(STATUSLINE_REFRESH_INTERVAL_SECS),
                );
            }
        }
        Some(_) => {}
    }
}

/// Adds the hook events an existing registration is missing — what a build that registers a new
/// event finds on an install registered by an older one. Acts only when every zashiki entry already
/// runs this build's script, so a server started from another checkout (a test, e2e, a dev sandbox)
/// never rewrites the installed app's registration; touches nothing when no event carries a zashiki
/// entry (never registered, or turned off). Existing entries and the statusLine are left as they are.
pub fn merge_top_up(current: &Value, paths: &ScriptPaths) -> (Value, bool) {
    let ours = our_hook_entries(current, paths);
    let all_run_this_build = ours.iter().all(|e| entry_runs_script(e, &paths.notify_event));
    if ours.is_empty() || !all_run_this_build {
        return (current.clone(), false);
    }
    let mut next = current.clone();
    let Some(hooks) = next.get_mut("hooks").and_then(Value::as_object_mut) else {
        return (current.clone(), false);
    };
    for (event, kind) in EVENTS {
        if event_registered(current, event, paths) {
            continue;
        }
        let slot = hooks.entry(event.to_string()).or_insert_with(|| Value::Array(Vec::new()));
        if let Some(arr) = slot.as_array_mut() {
            arr.push(desired_hook_entry(paths, kind));
        }
    }
    let changed = &next != current;
    (next, changed)
}

fn our_hook_entries<'a>(current: &'a Value, paths: &ScriptPaths) -> Vec<&'a Value> {
    EVENTS
        .iter()
        .filter_map(|(event, _)| current.get("hooks")?.get(event)?.as_array())
        .flatten()
        .filter(|e| entry_is_ours_hook(e, &paths.notify_event))
        .collect()
}

fn entry_runs_script(entry: &Value, script: &str) -> bool {
    entry
        .get("hooks")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items.iter().any(|it| {
                it.get("command")
                    .and_then(Value::as_str)
                    .is_some_and(|cmd| parse_command(cmd).command_token.as_deref() == Some(script))
            })
        })
}

// ---- unregister ----

pub fn merge_unregister(current: &Value, paths: &ScriptPaths) -> (Value, bool) {
    let mut next = current.clone();
    if let Value::Object(root) = &mut next {
        unregister_hooks(root, &paths.notify_event);
        unregister_statusline(root, &paths.statusline);
    }
    let changed = &next != current;
    (next, changed)
}

fn unregister_hooks(root: &mut Map<String, Value>, notify_path: &str) {
    let Some(hooks) = root.get_mut("hooks").and_then(Value::as_object_mut) else {
        return;
    };
    for (event, _) in EVENTS {
        let Some(arr) = hooks.get_mut(event).and_then(Value::as_array_mut) else {
            continue;
        };
        let before = arr.len();
        arr.retain(|e| !entry_is_ours_hook(e, notify_path));
        if before > 0 && arr.is_empty() {
            hooks.remove(event);
        }
    }
    if hooks.is_empty() {
        root.remove("hooks");
    }
}

fn unregister_statusline(root: &mut Map<String, Value>, statusline_path: &str) {
    let Some(cmd) = root
        .get("statusLine")
        .and_then(Value::as_object)
        .and_then(|o| o.get("command"))
        .and_then(Value::as_str)
        .map(str::to_string)
    else {
        return;
    };
    let parsed = parse_command(&cmd);
    let is_ours = parsed.has_marker || parsed.command_token.as_deref() == Some(statusline_path);
    if !is_ours {
        return;
    }
    match parsed.legacy_statusline {
        Some(legacy) => {
            let obj = root.get_mut("statusLine").and_then(Value::as_object_mut).unwrap();
            obj.insert("command".to_string(), Value::String(legacy));
        }
        None => {
            root.remove("statusLine");
        }
    }
}

// ---- status ----

fn event_registered(current: &Value, event: &str, paths: &ScriptPaths) -> bool {
    current
        .get("hooks")
        .and_then(|h| h.get(event))
        .and_then(Value::as_array)
        .is_some_and(|arr| arr.iter().any(|e| entry_is_ours_hook(e, &paths.notify_event)))
}

pub fn registration_status(current: &Value, paths: &ScriptPaths) -> RegistrationStatus {
    let hooks_registered = EVENTS.iter().all(|(event, _)| event_registered(current, event, paths));

    let (status_line_registered, status_line_conflict) = match current.get("statusLine") {
        None => (false, false),
        Some(Value::Object(o)) => match o.get("command").and_then(Value::as_str) {
            Some(cmd) if command_is_ours(cmd, &paths.statusline) => (true, false),
            _ => (false, true),
        },
        Some(_) => (false, true),
    };

    RegistrationStatus {
        hooks_registered,
        status_line_registered,
        status_line_conflict,
    }
}

fn ensure_object(value: &mut Value) -> &mut Map<String, Value> {
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    value.as_object_mut().unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths() -> ScriptPaths {
        ScriptPaths::from_hooks_dir("/opt/zashiki/hooks")
    }

    fn v(s: &str) -> Value {
        serde_json::from_str(s).unwrap()
    }

    fn bytes(v: &Value) -> String {
        serde_json::to_string_pretty(v).unwrap()
    }

    // ---- shell helpers (the encode/decode contract everything else rests on) ----

    #[test]
    fn shq_split_roundtrip_for_hostile_strings() {
        for s in [
            "",
            "plain",
            "/Users/My Name/.claude/hooks/statusline.sh",
            "a'b",
            "a'\\''b",
            "trailing ",
            "$HOME && echo x",
            "bun run status --json",
            "back\\slash",
        ] {
            let split = shell_split(&shq(s));
            assert_eq!(split, vec![s.to_string()], "shq/split must round-trip {s:?}");
        }
    }

    #[test]
    fn parse_isolates_marker_legacy_and_command_token() {
        let cmd = format!(
            "{} {}{} {}",
            MARKER_ASSIGNMENT,
            LEGACY_STATUSLINE_PREFIX,
            shq("bun run x"),
            shq("/a b/statusline.sh"),
        );
        let parsed = parse_command(&cmd);
        assert!(parsed.has_marker);
        assert_eq!(parsed.command_token.as_deref(), Some("/a b/statusline.sh"));
        assert_eq!(parsed.legacy_statusline.as_deref(), Some("bun run x"));
    }

    // ---- register: fresh + idempotent ----

    #[test]
    fn register_fresh_adds_every_hook_and_the_statusline() {
        let (out, changed) = merge_register(&v("{}"), &paths());
        assert!(changed);
        let st = registration_status(&out, &paths());
        assert!(st.hooks_registered);
        assert!(st.status_line_registered);
        assert!(!st.status_line_conflict);
        assert_eq!(
            out["statusLine"]["command"],
            json!("ZK_ZASHIKI=1 '/opt/zashiki/hooks/statusline.sh'")
        );
        assert_eq!(out["statusLine"]["refreshInterval"], json!(10));
        assert_eq!(
            out["hooks"]["Stop"][0]["hooks"][0]["command"],
            json!("ZK_ZASHIKI=1 '/opt/zashiki/hooks/notify-event.sh' done")
        );
        assert_eq!(
            out["hooks"]["SubagentStop"][0]["hooks"][0]["command"],
            json!("ZK_ZASHIKI=1 '/opt/zashiki/hooks/notify-event.sh' subagent_end")
        );
    }

    #[test]
    fn register_upgrades_plain_ours_statusline_with_refresh_interval() {
        let input = v(r#"{"statusLine":{"type":"command","command":"ZK_ZASHIKI=1 '/opt/zashiki/hooks/statusline.sh'"}}"#);
        let (out, changed) = merge_register(&input, &paths());
        assert!(changed);
        assert_eq!(out["statusLine"]["refreshInterval"], json!(10));
    }

    #[test]
    fn register_does_not_add_refresh_interval_to_a_wrapped_foreign_statusline() {
        let input = v(r#"{"statusLine":{"type":"command","command":"~/bin/my-statusline.sh"}}"#);
        let (out, _) = merge_register(&input, &paths());
        assert!(out["statusLine"].get("refreshInterval").is_none());
    }

    #[test]
    fn register_preserves_a_foreign_statuslines_own_refresh_interval_across_round_trip() {
        let input = v(r#"{"statusLine":{"type":"command","command":"~/mine.sh","refreshInterval":3}}"#);
        let (reg, _) = merge_register(&input, &paths());
        assert_eq!(reg["statusLine"]["refreshInterval"], json!(3));
        let (back, _) = merge_unregister(&reg, &paths());
        assert_eq!(bytes(&back), bytes(&input));
    }

    #[test]
    fn register_twice_is_a_byte_identical_noop() {
        let (once, _) = merge_register(&v("{}"), &paths());
        let (twice, changed) = merge_register(&once, &paths());
        assert!(!changed, "second register must not change anything");
        assert_eq!(bytes(&once), bytes(&twice));
    }

    #[test]
    fn register_preserves_unrelated_keys_and_order() {
        let input = v(r#"{"model":"opus","permissions":{"allow":["Bash"]},"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"/x/scan.sh"}]}]}}"#);
        let (out, _) = merge_register(&input, &paths());
        assert_eq!(out["model"], json!("opus"));
        assert_eq!(out["permissions"]["allow"][0], json!("Bash"));
        assert_eq!(out["hooks"]["PreToolUse"][0]["hooks"][0]["command"], json!("/x/scan.sh"));
        let keys: Vec<&str> = out.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(&keys[..3], &["model", "permissions", "hooks"]);
    }

    #[test]
    fn register_pathfix_replaces_stale_marked_entry_without_duplicating() {
        // A marked entry from an earlier install at a different path is still ours (marker) and gets
        // its path corrected, not duplicated.
        let input = v(r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"ZK_ZASHIKI=1 '/old/path/notify-event.sh' done"}]}]}}"#);
        let (out, changed) = merge_register(&input, &paths());
        assert!(changed);
        let stop = out["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 1);
        assert_eq!(
            stop[0]["hooks"][0]["command"],
            json!("ZK_ZASHIKI=1 '/opt/zashiki/hooks/notify-event.sh' done")
        );
    }

    #[test]
    fn register_recognizes_hand_registered_entry_at_current_path() {
        // A manual (unmarked) registration at the current path is ours by path, so it is not duplicated.
        let input = v(r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"/opt/zashiki/hooks/notify-event.sh done"}]}]}}"#);
        let (out, _) = merge_register(&input, &paths());
        assert_eq!(out["hooks"]["Stop"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn register_dedupes_multiple_ours_entries_in_one_event() {
        let input = v(r#"{"hooks":{"Stop":[
            {"hooks":[{"type":"command","command":"ZK_ZASHIKI=1 '/a/notify-event.sh' done"}]},
            {"hooks":[{"type":"command","command":"ZK_ZASHIKI=1 '/b/notify-event.sh' done"}]}
        ]}}"#);
        let (out, _) = merge_register(&input, &paths());
        assert_eq!(out["hooks"]["Stop"].as_array().unwrap().len(), 1);
    }

    // ---- foreign preservation (the data-loss guard) ----

    #[test]
    fn register_preserves_foreign_hook_entry_in_same_event() {
        let input = v(r#"{"hooks":{"Stop":[{"matcher":"X","hooks":[{"type":"command","command":"~/my-stop.sh"}]}]}}"#);
        let (out, _) = merge_register(&input, &paths());
        let stop = out["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2);
        assert_eq!(stop[0]["matcher"], json!("X"));
        assert_eq!(stop[0]["hooks"][0]["command"], json!("~/my-stop.sh"));
    }

    #[test]
    fn users_own_exact_basename_scripts_are_not_clobbered() {
        // A user whose own scripts are literally named statusline.sh / notify-event.sh in another
        // directory must be preserved: the statusLine is wrapped (not overwritten) and the hook kept.
        let input = v(r#"{
            "hooks":{"Stop":[{"hooks":[{"type":"command","command":"/home/me/notify-event.sh mykind"}]}]},
            "statusLine":{"type":"command","command":"/home/me/statusline.sh --flag"}
        }"#);
        let st = registration_status(&input, &paths());
        assert!(!st.hooks_registered, "a foreign same-named hook is not ours");
        assert!(st.status_line_conflict, "a foreign same-named statusLine conflicts, not registered");

        let (reg, _) = merge_register(&input, &paths());
        assert_eq!(
            reg["statusLine"]["command"],
            json!("ZK_ZASHIKI=1 ZK_LEGACY_STATUSLINE='/home/me/statusline.sh --flag' '/opt/zashiki/hooks/statusline.sh'")
        );
        assert_eq!(reg["hooks"]["Stop"].as_array().unwrap().len(), 2, "foreign hook kept alongside ours");

        let (out, changed) = merge_unregister(&input, &paths());
        assert!(!changed);
        assert_eq!(bytes(&out), bytes(&input));
    }

    #[test]
    fn register_wraps_foreign_statusline_preserving_it() {
        let input = v(r#"{"statusLine":{"type":"command","command":"~/bin/my-statusline.sh"}}"#);
        let (out, _) = merge_register(&input, &paths());
        assert_eq!(
            out["statusLine"]["command"],
            json!("ZK_ZASHIKI=1 ZK_LEGACY_STATUSLINE='~/bin/my-statusline.sh' '/opt/zashiki/hooks/statusline.sh'")
        );
        let st = registration_status(&out, &paths());
        assert!(st.status_line_registered);
        assert!(!st.status_line_conflict, "a wrapped foreign statusLine is resolved, not a conflict");
    }

    #[test]
    fn register_does_not_double_wrap_foreign_statusline() {
        let input = v(r#"{"statusLine":{"type":"command","command":"bun run status"}}"#);
        let (once, _) = merge_register(&input, &paths());
        let (twice, changed) = merge_register(&once, &paths());
        assert!(!changed);
        assert_eq!(bytes(&once), bytes(&twice));
        assert!(!once["statusLine"]["command"].as_str().unwrap().contains("ZK_LEGACY_STATUSLINE='ZK_LEGACY"));
    }

    #[test]
    fn register_preserves_sibling_statusline_fields_when_wrapping() {
        let input = v(r#"{"statusLine":{"type":"command","command":"~/s.sh","padding":0}}"#);
        let (out, _) = merge_register(&input, &paths());
        assert_eq!(out["statusLine"]["padding"], json!(0));
    }

    // ---- unregister ----

    #[test]
    fn unregister_removes_only_ours_and_keeps_order_and_matcher() {
        let input = v(r#"{"hooks":{"Stop":[
            {"matcher":"A","hooks":[{"type":"command","command":"~/a.sh"}]},
            {"hooks":[{"type":"command","command":"ZK_ZASHIKI=1 '/opt/zashiki/hooks/notify-event.sh' done"}]},
            {"matcher":"B","hooks":[{"type":"command","command":"~/b.sh"}]}
        ]}}"#);
        let (out, changed) = merge_unregister(&input, &paths());
        assert!(changed);
        let stop = out["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop.len(), 2);
        assert_eq!(stop[0]["matcher"], json!("A"));
        assert_eq!(stop[1]["matcher"], json!("B"));
    }

    #[test]
    fn unregister_drops_emptied_event_and_hooks_key_but_keeps_foreign_events() {
        let input = v(r#"{"hooks":{
            "PreToolUse":[{"hooks":[{"type":"command","command":"/x/scan.sh"}]}],
            "Stop":[{"hooks":[{"type":"command","command":"ZK_ZASHIKI=1 '/opt/zashiki/hooks/notify-event.sh' done"}]}]
        }}"#);
        let (out, _) = merge_unregister(&input, &paths());
        assert!(out["hooks"].get("Stop").is_none(), "emptied event key removed");
        assert!(out["hooks"].get("PreToolUse").is_some(), "foreign event kept");
    }

    #[test]
    fn unregister_removes_hooks_key_when_only_ours_existed() {
        let (registered, _) = merge_register(&v("{}"), &paths());
        let (out, _) = merge_unregister(&registered, &paths());
        assert!(out.get("hooks").is_none());
    }

    #[test]
    fn unregister_plain_statusline_removes_key() {
        let (registered, _) = merge_register(&v("{}"), &paths());
        let (out, _) = merge_unregister(&registered, &paths());
        assert!(out.get("statusLine").is_none());
    }

    #[test]
    fn unregister_leaves_foreign_statusline_untouched() {
        let input = v(r#"{"statusLine":{"type":"command","command":"~/s.sh"}}"#);
        let (out, changed) = merge_unregister(&input, &paths());
        assert!(!changed);
        assert_eq!(out["statusLine"]["command"], json!("~/s.sh"));
    }

    // ---- round-trip identity (the crux, incl. hostile foreign commands) ----

    #[test]
    fn register_then_unregister_is_identity() {
        let cases = [
            r#"{}"#,
            r#"{"model":"opus"}"#,
            r#"{"statusLine":{"type":"command","command":"~/bin/my-statusline.sh"}}"#,
            r#"{"statusLine":{"type":"command","command":"/home/me/statusline.sh --flag"}}"#,
            r#"{"statusLine":{"type":"command","command":"bun run status --json"}}"#,
            r#"{"statusLine":{"type":"command","command":"echo it's here"}}"#,
            r#"{"statusLine":{"type":"command","command":"printf 'x' && echo $HOME "}}"#,
            r#"{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"/x/scan.sh"}]}]}}"#,
        ];
        for case in cases {
            let input = v(case);
            let (registered, _) = merge_register(&input, &paths());
            let (back, _) = merge_unregister(&registered, &paths());
            assert_eq!(bytes(&back), bytes(&input), "round-trip must be identity for {case}");
        }
    }

    #[test]
    fn wrapped_statusline_with_space_in_hooksdir_roundtrips() {
        let spaced = ScriptPaths::from_hooks_dir("/Users/My Name/.claude/hooks");
        let input = v(r#"{"statusLine":{"type":"command","command":"~/legacy.sh"}}"#);
        let (registered, _) = merge_register(&input, &spaced);
        assert!(registered["statusLine"]["command"]
            .as_str()
            .unwrap()
            .ends_with("'/Users/My Name/.claude/hooks/statusline.sh'"));
        let (back, _) = merge_unregister(&registered, &spaced);
        assert_eq!(bytes(&back), bytes(&input));
    }

    // ---- status ----

    #[test]
    fn status_fresh_is_all_false() {
        let st = registration_status(&v("{}"), &paths());
        assert!(!st.hooks_registered && !st.status_line_registered && !st.status_line_conflict);
    }

    #[test]
    fn status_reports_foreign_statusline_conflict() {
        let st = registration_status(
            &v(r#"{"statusLine":{"type":"command","command":"~/s.sh"}}"#),
            &paths(),
        );
        assert!(!st.status_line_registered);
        assert!(st.status_line_conflict);
    }

    /// A hook the server registers has to be one the shell forwards and the intake route accepts.
    /// The three lists are written by hand in three files, and registering an event the other two do
    /// not carry fails silently: Claude Code calls the script, the script drops through to its
    /// fall-through, and nothing ever reaches zashiki.
    #[test]
    fn every_registered_event_is_carried_by_the_script_and_the_wire() {
        let script = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../hooks/notify-event.sh"),
        )
        .expect("hooks/notify-event.sh");
        for (event, kind) in EVENTS {
            let arm_head = format!("{event} | {kind})");
            let arm_start = script
                .find(&arm_head)
                .unwrap_or_else(|| panic!("notify-event.sh has no case arm for {event}"));
            let arm_end = script[arm_start..]
                .find(";;")
                .map(|end| arm_start + end)
                .unwrap_or(script.len());
            assert!(
                script[arm_start..arm_end].contains(&format!("kind={kind}")),
                "notify-event.sh's {event} arm does not forward {kind}"
            );
            serde_json::from_value::<crate::protocol::HookKind>(json!(kind))
                .unwrap_or_else(|_| panic!("{kind} is not a HookKind the intake route accepts"));
        }
    }

    /// A `subagent_end` that names no agent is discarded by the intake route, so the two lines that
    /// read `agent_id` out of the payload and put it in the body are load-bearing: lose either and
    /// every stop is dropped, no tray is ever released, and nothing says so.
    #[test]
    fn the_script_forwards_the_agent_a_subagent_stop_names() {
        let script = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../hooks/notify-event.sh"),
        )
        .expect("hooks/notify-event.sh");
        assert!(
            script.contains(".agent_id // \"\""),
            "notify-event.sh no longer reads agent_id out of the hook payload"
        );
        assert!(
            script.contains("{agent_id: $agent}"),
            "notify-event.sh no longer puts agent_id in the POST body"
        );
    }

    #[test]
    fn status_hooks_registered_requires_every_event() {
        let three = v(r#"{"hooks":{
            "UserPromptSubmit":[{"hooks":[{"type":"command","command":"ZK_ZASHIKI=1 '/h/notify-event.sh' prompt"}]}],
            "PostToolUse":[{"hooks":[{"type":"command","command":"ZK_ZASHIKI=1 '/h/notify-event.sh' tool"}]}],
            "Notification":[{"hooks":[{"type":"command","command":"ZK_ZASHIKI=1 '/h/notify-event.sh' waiting"}]}]
        }}"#);
        assert!(!registration_status(&three, &paths()).hooks_registered);
    }

    /// An install that predates SubagentStop reads as unregistered, and registering again adds only
    /// the missing event while leaving the four it already had byte-identical.
    #[test]
    fn register_tops_up_an_install_that_predates_subagent_stop() {
        let before = merge_register(&v("{}"), &paths()).0;
        let mut without = before.clone();
        without["hooks"]
            .as_object_mut()
            .unwrap()
            .remove("SubagentStop");
        assert!(!registration_status(&without, &paths()).hooks_registered);

        let (after, changed) = merge_register(&without, &paths());
        assert!(changed);
        assert!(registration_status(&after, &paths()).hooks_registered);
        assert_eq!(bytes(&after), bytes(&before));
    }

    fn without_subagent_stop(registered: &Value) -> Value {
        let mut without = registered.clone();
        without["hooks"].as_object_mut().unwrap().remove("SubagentStop");
        without
    }

    /// Foreign hooks beside ours, a foreign statusLine wrapped by ours, and unrelated settings.
    fn lived_in() -> Value {
        v(r#"{"model":"opus",
            "hooks":{"Stop":[{"matcher":"","hooks":[{"type":"command","command":"~/my-stop.sh"}]}]},
            "statusLine":{"type":"command","command":"~/legacy.sh"}}"#)
    }

    #[test]
    fn top_up_adds_the_missing_event_and_leaves_the_rest_byte_identical() {
        let registered = merge_register(&lived_in(), &paths()).0;
        let (after, changed) = merge_top_up(&without_subagent_stop(&registered), &paths());
        assert!(changed);
        assert_eq!(bytes(&after), bytes(&registered));
    }

    #[test]
    fn top_up_leaves_the_statusline_as_it_finds_it() {
        let mut registered = merge_register(&v("{}"), &paths()).0;
        registered.as_object_mut().unwrap().remove("statusLine");
        let foreign = v(r#"{"type":"command","command":"~/other-statusline.sh"}"#);
        for status_line in [None, Some(foreign)] {
            let mut input = without_subagent_stop(&registered);
            if let Some(s) = &status_line {
                input["statusLine"] = s.clone();
            }
            let (after, _) = merge_top_up(&input, &paths());
            assert!(registration_status(&after, &paths()).hooks_registered);
            assert_eq!(after.get("statusLine"), status_line.as_ref());
        }
    }

    /// The hand registration the hooks README shows, chained to a legacy notifier, on two events only.
    #[test]
    fn top_up_keeps_a_hand_registered_entry_and_its_legacy_notifier() {
        let input = v(r#"{"hooks":{
            "Notification":[{"hooks":[{"type":"command","command":"ZK_LEGACY_NOTIFY=/l.sh /opt/zashiki/hooks/notify-event.sh waiting"}]}],
            "Stop":[{"hooks":[{"type":"command","command":"ZK_LEGACY_NOTIFY=/l.sh /opt/zashiki/hooks/notify-event.sh done"}]}]
        }}"#);
        let (after, changed) = merge_top_up(&input, &paths());
        assert!(changed);
        assert!(registration_status(&after, &paths()).hooks_registered);
        assert_eq!(after["hooks"]["Notification"], input["hooks"]["Notification"]);
        assert_eq!(after["hooks"]["Stop"], input["hooks"]["Stop"]);
    }

    #[test]
    fn top_up_leaves_a_registration_by_another_build_alone() {
        let elsewhere = ScriptPaths::from_hooks_dir("/Applications/zashiki.app/Contents/Resources/hooks");
        let input = without_subagent_stop(&merge_register(&lived_in(), &elsewhere).0);
        let (after, changed) = merge_top_up(&input, &paths());
        assert!(!changed);
        assert_eq!(bytes(&after), bytes(&input));
    }

    #[test]
    fn top_up_leaves_an_unregistered_install_unregistered() {
        let registered = merge_register(&lived_in(), &paths()).0;
        let turned_off = merge_unregister(&registered, &paths()).0;
        for case in [v("{}"), lived_in(), turned_off] {
            let (after, changed) = merge_top_up(&case, &paths());
            assert!(!changed);
            assert_eq!(bytes(&after), bytes(&case));
        }
    }

    #[test]
    fn top_up_is_a_no_op_on_a_full_registration() {
        let registered = merge_register(&lived_in(), &paths()).0;
        assert!(!merge_top_up(&registered, &paths()).1);
    }

    #[test]
    fn foreign_lookalike_scripts_are_not_ours() {
        let input = v(r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"~/my-notify-event.sh done"}]}]},"statusLine":{"type":"command","command":"~/my-statusline.sh"}}"#);
        let st = registration_status(&input, &paths());
        assert!(!st.hooks_registered);
        assert!(st.status_line_conflict);
        let (out, changed) = merge_unregister(&input, &paths());
        assert!(!changed);
        assert_eq!(bytes(&out), bytes(&input));
    }

    // ---- malformed shapes: never panic, never destroy user data ----

    #[test]
    fn malformed_shapes_are_handled_safely() {
        let cases = [
            r#"{"hooks":"nope"}"#,
            r#"{"hooks":{"Stop":"nope"}}"#,
            r#"{"hooks":{"Stop":[{"no_hooks_key":1}]}}"#,
            r#"{"hooks":{"Stop":[{"hooks":[{"type":"command"}]}]}}"#,
            r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":123}]}]}}"#,
            r#"{"statusLine":"nope"}"#,
            r#"{"statusLine":{"type":"command"}}"#,
            r#"{"statusLine":[1,2,3]}"#,
        ];
        for case in cases {
            let input = v(case);
            let (reg, _) = merge_register(&input, &paths());
            let _ = registration_status(&reg, &paths());
            let (_unreg, _) = merge_unregister(&input, &paths());
        }
    }

    #[test]
    fn register_does_not_overwrite_non_object_statusline() {
        let input = v(r#"{"statusLine":"custom-string"}"#);
        let (out, _) = merge_register(&input, &paths());
        assert_eq!(out["statusLine"], json!("custom-string"));
    }

    #[test]
    fn register_leaves_non_object_hooks_untouched() {
        let input = v(r#"{"hooks":"custom"}"#);
        let (out, _) = merge_register(&input, &paths());
        assert_eq!(out["hooks"], json!("custom"));
    }
}
