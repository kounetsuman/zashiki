//! Pure functions behind the Claude Code hooks endpoint `POST /api/hooks/event`.
//!
//! Asynchronous fetching (refresh / listCockpitTerminals / ps snapshot) is done by the REST handler; here we
//! keep only **window resolution ([`resolve_window`])** and **delivery decisions ([`notify_delivery`] / [`decide`])**
//! as pure functions (separated into a testable form).
//! The canonical source of behavior is the `tests` module at the end.

use std::sync::Arc;

use serde_json::Value;
use zashiki_core::process_tree::{build_process_maps, find_sid_in_tree, parse_ps_snapshot};

use crate::protocol::{HookKind, NotifyKind, UsageLimit, UsageLimits};
use crate::status_poller::CockpitTerminal;

/// Reads one `{used_percentage, resets_at}` block Claude Code exposes to its statusLine.
/// `used_percentage` rounds to an integer; `resets_at` is unix seconds, converted to epoch ms.
fn parse_usage_limit(v: &Value) -> Option<UsageLimit> {
    let used_percent = v.get("used_percentage").and_then(Value::as_f64)?.round();
    let resets_at = v
        .get("resets_at")
        .and_then(Value::as_f64)
        .map(|s| (s * 1000.0) as u64);
    Some(UsageLimit {
        used_percent: used_percent.max(0.0) as u32,
        resets_at,
    })
}

/// Extracts the sid and account usage limits from a Claude Code statusLine payload
/// (`POST /api/hooks/statusline`). None when there is no session_id or no reportable limit,
/// so an unconfigured/partial statusLine simply reports nothing.
pub fn parse_statusline_limits(json: &Value) -> Option<(String, UsageLimits)> {
    let sid = json.get("session_id").and_then(Value::as_str)?;
    let rl = json.get("rate_limits")?;
    let five_hour = rl.get("five_hour").and_then(parse_usage_limit);
    let week = rl.get("seven_day").and_then(parse_usage_limit);
    if five_hour.is_none() && week.is_none() {
        return None;
    }
    Some((
        sid.to_string(),
        UsageLimits {
            five_hour,
            week,
            updated_at: None,
        },
    ))
}

/// Notification destination (ZK_NOTIFY; defaults to web).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum NotifyMode {
    #[default]
    Web,
    Macos,
    Both,
    Off,
}

impl NotifyMode {
    /// Interpret the ZK_NOTIFY string (unknown or empty defaults to web).
    pub fn from_str_or_default(s: &str) -> NotifyMode {
        match s {
            "macos" => NotifyMode::Macos,
            "both" => NotifyMode::Both,
            "off" => NotifyMode::Off,
            _ => NotifyMode::Web,
        }
    }
}

/// Delivery targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NotifyDelivery {
    /// notify push over the control WS.
    pub push: bool,
    /// macOS notification via terminal-notifier.
    pub mac: bool,
}

/// Decide delivery targets from ZK_NOTIFY and the number of connected browsers.
/// web falls back to macOS only when there are 0 browser connections. macos never pushes over the WS.
pub fn notify_delivery(mode: NotifyMode, client_count: usize) -> NotifyDelivery {
    match mode {
        NotifyMode::Off => NotifyDelivery { push: false, mac: false },
        NotifyMode::Web => NotifyDelivery {
            push: true,
            mac: client_count == 0,
        },
        NotifyMode::Macos => NotifyDelivery { push: false, mac: true },
        NotifyMode::Both => NotifyDelivery { push: true, mac: true },
    }
}

/// A resolved window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedWindow {
    pub cockpit_terminal_id: String,
    pub name: String,
}

/// Map a hook event / focus request (sid / cwd) to a work window.
/// The primary key is the sid (via process-tree traversal); the fallback is an exact match on the pane cwd.
pub fn resolve_window(
    sid: Option<&str>,
    cwd: Option<&str>,
    windows: &[CockpitTerminal],
    ps_output: &str,
) -> Option<ResolvedWindow> {
    let sid = sid.map(|s| s.to_lowercase()).filter(|s| !s.is_empty());
    if let Some(sid) = sid {
        let maps = build_process_maps(&parse_ps_snapshot(ps_output));
        for win in windows {
            for pane in &win.panes {
                if find_sid_in_tree(pane.pid, &maps).as_deref() == Some(sid.as_str()) {
                    return Some(ResolvedWindow {
                        cockpit_terminal_id: win.cockpit_terminal_id.clone(),
                        name: win.name.clone(),
                    });
                }
            }
        }
    }
    if let Some(cwd) = cwd.filter(|c| !c.is_empty()) {
        for win in windows {
            if win.panes.iter().any(|p| p.current_path == cwd) {
                return Some(ResolvedWindow {
                    cockpit_terminal_id: win.cockpit_terminal_id.clone(),
                    name: win.name.clone(),
                });
            }
        }
    }
    None
}

/// Contents of a macOS notification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MacNotification {
    pub kind: NotifyKind,
    /// Material for the notification title (window name = repo name).
    pub title: String,
    /// Body (e.g. the session's summary title; empty string if absent).
    pub message: String,
    /// Whether to play the notification sound (the category's `sound` toggle).
    pub sound: bool,
}

/// Executor for macOS notifications (terminal-notifier by default; swapped out in tests; fire-and-forget).
pub type MacNotify = Arc<dyn Fn(MacNotification) + Send + Sync>;

/// A resolved notification to deliver. Delivery — web push vs macOS, plus per-category gating — is
/// the hub's job ([`crate::control::ControlHub::notify`]); this only carries the material.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotifyEvent {
    pub kind: NotifyKind,
    pub cockpit_terminal_id: String,
    /// Window/repo name — the WS push title and the macOS title.
    pub name: String,
    /// Session summary — the macOS body (empty string if absent).
    pub session_title: String,
}

/// The plan of side effects to run for a hook event (output of the pure function [`decide`]).
/// Given the results of the asynchronous fetches, the decision completes synchronously and the handler only executes the plan.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HookActions {
    /// Whether the event was mapped to a work window (response `matched`).
    pub matched: bool,
    /// Trigger to refetch the git panel (PostToolUse).
    pub git_dirty: bool,
    /// Accumulate into ACTIVITY (kind, Cockpit Terminal id, window name). None when off.
    pub record: Option<(NotifyKind, String, String)>,
    /// The notification to hand to the hub for delivery. None when there is nothing to deliver.
    pub notify: Option<NotifyEvent>,
}

fn notify_kind_of(kind: HookKind) -> Option<NotifyKind> {
    match kind {
        HookKind::Waiting => Some(NotifyKind::Waiting),
        HookKind::Done => Some(NotifyKind::Done),
        _ => None,
    }
}

/// Maps a wire hook kind to its domain [`HookEvent`] for the shared store (a 1:1 crossing of the
/// web-adapter / domain seam).
pub fn hook_event_of(kind: HookKind) -> zashiki_core::session_state::HookEvent {
    use zashiki_core::session_state::HookEvent;
    match kind {
        HookKind::Waiting => HookEvent::Waiting,
        HookKind::Done => HookEvent::Done,
        HookKind::Prompt => HookEvent::Prompt,
        HookKind::Tool => HookEvent::Tool,
    }
}

/// Decide the side-effect plan from the hook kind and resolution result. `snap_title` is the current
/// title of the resolved window, used for the mac notification body (empty string if absent). `mode`
/// gates only whether the event is surfaced at all (`Off` records nothing and delivers nothing); the
/// web-vs-mac routing and per-category gating happen at delivery time in the hub.
pub fn decide(
    kind: HookKind,
    resolved: Option<&ResolvedWindow>,
    mode: NotifyMode,
    record_history: bool,
    snap_title: Option<String>,
) -> HookActions {
    if kind == HookKind::Tool {
        return HookActions {
            git_dirty: true,
            ..Default::default()
        };
    }
    let (Some(nk), Some(win)) = (notify_kind_of(kind), resolved) else {
        return HookActions::default();
    };
    let mut actions = HookActions {
        matched: true,
        ..Default::default()
    };
    if mode == NotifyMode::Off {
        return actions;
    }
    // The panel record is additionally suppressed when history is off (ZK_NOTIFY_HISTORY=off), which
    // still delivers the toast; the caller further gates it by the per-category switches.
    if record_history {
        actions.record = Some((nk, win.cockpit_terminal_id.clone(), win.name.clone()));
    }
    actions.notify = Some(NotifyEvent {
        kind: nk,
        cockpit_terminal_id: win.cockpit_terminal_id.clone(),
        name: win.name.clone(),
        session_title: snap_title.unwrap_or_default(),
    });
    actions
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::status_poller::CockpitTerminalPane;
    use serde_json::json;

    #[test]
    fn statusline_parses_sid_and_both_limits() {
        let payload = json!({
            "session_id": "abc",
            "rate_limits": {
                "five_hour": {"used_percentage": 42.4, "resets_at": 1_700_000_000},
                "seven_day": {"used_percentage": 61.6},
            },
        });
        let (sid, limits) = parse_statusline_limits(&payload).unwrap();
        assert_eq!(sid, "abc");
        assert_eq!(
            limits.five_hour,
            Some(UsageLimit {
                used_percent: 42,
                resets_at: Some(1_700_000_000_000),
            })
        );
        assert_eq!(
            limits.week,
            Some(UsageLimit {
                used_percent: 62,
                resets_at: None,
            })
        );
    }

    #[test]
    fn statusline_none_without_sid_or_reportable_limit() {
        assert!(parse_statusline_limits(
            &json!({"rate_limits": {"five_hour": {"used_percentage": 5}}})
        )
        .is_none());
        assert!(parse_statusline_limits(&json!({"session_id": "abc"})).is_none());
        assert!(parse_statusline_limits(&json!({"session_id": "abc", "rate_limits": {}})).is_none());
    }

    fn pane(pid: i64, cwd: &str) -> CockpitTerminalPane {
        CockpitTerminalPane {
            pane_id: "%0".to_string(),
            active: true,
            pid,
            left: 0,
            in_mode: false,
            current_path: cwd.to_string(),
        }
    }

    fn window(id: &str, name: &str, panes: Vec<CockpitTerminalPane>) -> CockpitTerminal {
        CockpitTerminal {
            cockpit_terminal_id: id.to_string(),
            name: name.to_string(),
            active: true,
            panes,
        }
    }

    #[test]
    fn delivery_web_falls_back_to_mac_only_when_no_clients() {
        assert_eq!(
            notify_delivery(NotifyMode::Web, 1),
            NotifyDelivery { push: true, mac: false }
        );
        assert_eq!(
            notify_delivery(NotifyMode::Web, 0),
            NotifyDelivery { push: true, mac: true }
        );
        assert_eq!(
            notify_delivery(NotifyMode::Macos, 3),
            NotifyDelivery { push: false, mac: true }
        );
        assert_eq!(
            notify_delivery(NotifyMode::Both, 3),
            NotifyDelivery { push: true, mac: true }
        );
        assert_eq!(
            notify_delivery(NotifyMode::Off, 0),
            NotifyDelivery { push: false, mac: false }
        );
    }

    #[test]
    fn resolve_by_cwd_when_no_sid() {
        let windows = vec![
            window("@1", "repo-a", vec![pane(100, "/repos/a")]),
            window("@2", "repo-b", vec![pane(200, "/repos/b")]),
        ];
        let got = resolve_window(None, Some("/repos/b"), &windows, "");
        assert_eq!(got.unwrap().cockpit_terminal_id, "@2");
    }

    #[test]
    fn resolve_by_sid_via_process_tree() {
        let sid = "579fa8cf-4901-45cb-b9ec-17e229231a37";
        let windows = vec![window("@1", "repo-a", vec![pane(4242, "/repos/a")])];
        // ps snapshot in which a child of pid 4242 is running claude --session-id <sid>.
        let ps = format!("4242 1 -zsh\n5000 4242 claude --session-id {sid}\n");
        let got = resolve_window(Some(&sid.to_uppercase()), None, &windows, &ps);
        assert_eq!(got.unwrap().name, "repo-a");
    }

    #[test]
    fn resolve_returns_none_when_unmatched() {
        let windows = vec![window("@1", "repo-a", vec![pane(100, "/repos/a")])];
        assert!(resolve_window(None, Some("/nope"), &windows, "").is_none());
        assert!(resolve_window(None, None, &windows, "").is_none());
    }

    #[test]
    fn decide_tool_only_marks_git_dirty() {
        let a = decide(HookKind::Tool, None, NotifyMode::Web, true, None);
        assert!(a.git_dirty && !a.matched && a.record.is_none() && a.notify.is_none());
    }

    #[test]
    fn decide_prompt_does_nothing() {
        let a = decide(HookKind::Prompt, None, NotifyMode::Web, true, None);
        assert_eq!(a, HookActions::default());
    }

    #[test]
    fn decide_unresolved_waiting_is_not_matched() {
        let a = decide(HookKind::Waiting, None, NotifyMode::Web, true, None);
        assert!(!a.matched && a.record.is_none() && a.notify.is_none());
    }

    #[test]
    fn decide_matched_records_and_yields_a_notify_event() {
        let win = ResolvedWindow {
            cockpit_terminal_id: "@1".to_string(),
            name: "repo-a".to_string(),
        };
        let a = decide(HookKind::Waiting, Some(&win), NotifyMode::Web, true, Some("題名".to_string()));
        assert!(a.matched);
        assert_eq!(
            a.record,
            Some((NotifyKind::Waiting, "@1".to_string(), "repo-a".to_string()))
        );
        assert_eq!(
            a.notify,
            Some(NotifyEvent {
                kind: NotifyKind::Waiting,
                cockpit_terminal_id: "@1".to_string(),
                name: "repo-a".to_string(),
                session_title: "題名".to_string(),
            })
        );
    }

    #[test]
    fn decide_history_off_still_notifies_but_does_not_record() {
        let win = ResolvedWindow {
            cockpit_terminal_id: "@1".to_string(),
            name: "repo-a".to_string(),
        };
        let a = decide(HookKind::Done, Some(&win), NotifyMode::Web, false, None);
        assert!(a.matched);
        assert!(a.record.is_none());
        assert!(a.notify.is_some());
    }

    #[test]
    fn decide_off_matched_but_no_record_no_notify() {
        let win = ResolvedWindow {
            cockpit_terminal_id: "@1".to_string(),
            name: "repo-a".to_string(),
        };
        let a = decide(HookKind::Waiting, Some(&win), NotifyMode::Off, true, None);
        assert!(a.matched);
        assert!(a.record.is_none() && a.notify.is_none());
    }
}
