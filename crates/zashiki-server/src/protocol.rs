//! Wire types for `/ws/control` (`ClientMessage` / `ServerMessage` / `CockpitTerminalInfo`, using serde
//! internally-tagged enums). The JSON shape is the contract the client depends on, so it must stay stable.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// One account usage limit: the rounded used percentage and, when known, the epoch-ms reset time.
/// Populated from the statusLine bridge (`POST /api/hooks/statusline`); the client renders a live
/// reset countdown from `resets_at`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageLimit {
    pub used_percent: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<u64>,
}

/// Account usage limits Claude Code exposes to its statusLine (5-hour session window and weekly).
/// Each is absent until the bridge has reported it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageLimits {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub five_hour: Option<UsageLimit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub week: Option<UsageLimit>,
}

/// A colored band of a status-footer indicator: whether it paints and the value at or above which it
/// applies. Mirrors the shared `FooterBand` (guarded by the client's protocol tests).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct FooterBand {
    pub enabled: bool,
    pub value: i64,
}

impl FooterBand {
    pub const fn new(enabled: bool, value: i64) -> Self {
        Self { enabled, value }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct UsageBands {
    pub warn: FooterBand,
    pub high: FooterBand,
    pub crit: FooterBand,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenBands {
    pub warn: FooterBand,
    pub crit: FooterBand,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ElapsedBands {
    pub crit: FooterBand,
}

/// Per-indicator status-footer severity thresholds. Mirrors the shared `FooterThresholds`; `Default`
/// reproduces the built-in bands (kept in sync with shared/config by the client's protocol tests).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FooterThresholds {
    pub usage_percent: UsageBands,
    pub session_tokens: TokenBands,
    pub elapsed_ms: ElapsedBands,
}

impl Default for FooterThresholds {
    fn default() -> Self {
        Self {
            usage_percent: UsageBands {
                warn: FooterBand::new(true, 50),
                high: FooterBand::new(true, 75),
                crit: FooterBand::new(true, 91),
            },
            session_tokens: TokenBands {
                warn: FooterBand::new(true, 1_500_000),
                crit: FooterBand::new(true, 3_000_000),
            },
            elapsed_ms: ElapsedBands {
                crit: FooterBand::new(true, 86_400_000),
            },
        }
    }
}

/// Session status-footer material: token totals plus the epoch-ms starting points for live elapsed.
/// `turn` is measured from the most recent human prompt; `session` spans the whole transcript.
/// Tokens/timestamps come from the transcript (no user setup); `limits` arrives via the statusLine bridge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsage {
    pub turn_tokens: u64,
    pub session_tokens: u64,
    pub turn_started_at: u64,
    pub session_started_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limits: Option<UsageLimits>,
}

/// One window's snapshot distributed via state.sync.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CockpitTerminalInfo {
    /// The id of the owned PTY session (the session UUID when owned).
    pub cockpit_terminal_id: String,
    pub name: String,
    pub org: String,
    pub repo: String,
    /// State string (`waiting_input`/`running`/`idle`/`no_claude`/`unknown`).
    pub state: String,
    /// Summary of the first user utterance (null if absent).
    pub title: Option<String>,
    /// The running claude's session id (sid), used to build the client's resume command. Absent for
    /// windows where claude is not started, when sid detection fails, or with old servers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sid: Option<String>,
    pub active: bool,
    /// Total number of running subagents (including nested). An approximate value that is only
    /// meaningful when running_bg_agent. Optional for backward compatibility with older servers (not
    /// sent when unavailable or in other states).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub running_subagents: Option<u32>,
    /// Number of persistent background shells (Bash run_in_background) whose output fd is still held
    /// by a live wrapper. Orthogonal to the primary state (meaningful in any state). Absent when zero
    /// or unfetched (older servers).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shells_running: Option<u32>,
    /// Flag indicating the Claude Code usage limit has been reached. Detected from the limit banner
    /// text at the bottom of the screen. Orthogonal to the primary state (meaningful in any state).
    /// For backward compatibility with older servers, false is not sent (not sent = treated as false).
    #[serde(default, skip_serializing_if = "is_false")]
    pub limited: bool,
    /// Token totals and elapsed anchors for the session status footer (absent for old servers, or
    /// while there is no readable transcript). `limits` inside is filled only when the statusLine
    /// bridge is configured.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<SessionUsage>,
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// Control messages from client to server (discriminated by `t`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t")]
pub enum ClientMessage {
    #[serde(rename = "term.open", rename_all = "camelCase")]
    TermOpen {
        term_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cockpit_terminal_id: Option<String>,
        cols: u32,
        rows: u32,
    },
    #[serde(rename = "term.resize", rename_all = "camelCase")]
    TermResize {
        term_id: String,
        cols: u32,
        rows: u32,
    },
    #[serde(rename = "term.select", rename_all = "camelCase")]
    TermSelect { term_id: String, cockpit_terminal_id: String },
    #[serde(rename = "term.close", rename_all = "camelCase")]
    TermClose { term_id: String },
    /// Flow-control ACK. `bytes` is the amount xterm.js has finished writing (in UTF-16 code units).
    #[serde(rename = "term.ack", rename_all = "camelCase")]
    TermAck { term_id: String, bytes: u64 },
    #[serde(rename = "cockpitTerminal.new", rename_all = "camelCase")]
    CockpitTerminalNew {
        org: String,
        /// Source Claude session id to fork into the new terminal (duplicate). Absent for a plain new session.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resume_sid: Option<String>,
    },
    #[serde(rename = "cockpitTerminal.close", rename_all = "camelCase")]
    CockpitTerminalClose { cockpit_terminal_id: String },
    #[serde(rename = "state.refresh")]
    StateRefresh,
    /// Manual dismissal of a notification (the ✕ in the NOTIFICATION panel). Only dismissible
    /// notifications are removed.
    #[serde(rename = "notification.dismiss")]
    NotificationDismiss { id: String },
    /// Configuration change from SETTINGS (currently only the display language). The server persists
    /// it to config.json and distributes config.sync to all connections via watch.
    #[serde(rename = "config.update", rename_all = "camelCase")]
    ConfigUpdate { language: String },
    /// Opt-in toggle for the account-usage bridge from SETTINGS / the footer modal. Persisted to
    /// config.json and distributed via config.sync, like the language change.
    #[serde(rename = "config.setAccountUsage", rename_all = "camelCase")]
    ConfigSetAccountUsage { enabled: bool },
    /// External editor command change from SETTINGS. Persisted to config.json and distributed via
    /// config.sync, like the language change. A blank value clears it.
    #[serde(rename = "config.setEditor", rename_all = "camelCase")]
    ConfigSetEditor { editor: String },
    /// Status-footer severity threshold change from SETTINGS. Persisted to config.json and distributed
    /// via config.sync, like the language change.
    #[serde(rename = "config.setFooterThresholds", rename_all = "camelCase")]
    ConfigSetFooterThresholds { footer_thresholds: FooterThresholds },
    /// Install zashiki's Claude Code hooks + statusLine into ~/.claude/settings.json (first-run
    /// wizard or SETTINGS). Idempotent merge; the resulting hooks.status is broadcast.
    #[serde(rename = "hooks.register")]
    HooksRegister,
    /// Remove only zashiki's entries from ~/.claude/settings.json (restoring any wrapped legacy
    /// statusLine). The resulting hooks.status is broadcast.
    #[serde(rename = "hooks.unregister")]
    HooksUnregister,
    /// On-demand "Check for updates" from SETTINGS. The server checks GitHub Releases now and replies
    /// with an `update.check.result` (a newer version additionally lands as a notification).
    #[serde(rename = "update.check")]
    UpdateCheck,
    /// Trigger a self-update from the header Update button. On a Homebrew-cask desktop install this
    /// pre-downloads the cask, then a detached helper upgrades and relaunches; otherwise it opens the
    /// releases page. Progress is reported to all connections via `update.status`.
    #[serde(rename = "update.perform")]
    UpdatePerform,
    /// Re-read the signed-in Claude account and reply with `account.status`. When `restart_sessions`
    /// is true the server first restarts every Cockpit Terminal with `--resume` so their `claude`
    /// re-reads the switched account (the client sets it only after confirming, and only when running
    /// Cockpit Terminals exist).
    #[serde(rename = "account.refresh", rename_all = "camelCase")]
    AccountRefresh { restart_sessions: bool },
}

/// Result of an on-demand update check, sent only to the requester so SETTINGS can show feedback.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateCheckStatus {
    Available,
    UpToDate,
    Error,
}

/// Progress of an `update.perform`, broadcast to all connections. `running` while the download runs,
/// `relaunching` once the download is verified and the detached updater has started (the app is about
/// to quit, upgrade, and reopen), `opened` when the env isn't a cask install so the releases page was
/// opened instead, `failed` when the download or launching the updater fails (detail carries the brew
/// stderr tail). A failure during the detached upgrade is surfaced by the updater itself (a
/// notification plus `~/Library/Logs/zashiki/update.log`), not here, since the server is gone by then.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateStatusState {
    Running,
    Relaunching,
    Opened,
    Failed,
}

/// The kind of notify.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NotifyKind {
    Waiting,
    Done,
}

/// The kind of Claude Code hook event.
/// prompt only refreshes (no notification), tool triggers git.dirty, and waiting/done deliver
/// notifications.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HookKind {
    Prompt,
    Tool,
    Waiting,
    Done,
}

/// Request for `POST /api/hooks/event`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct HookEventRequest {
    pub kind: HookKind,
    /// The Claude Code session_id (the primary key for sid -> window resolution).
    #[serde(default)]
    pub sid: Option<String>,
    /// The cwd at hook firing time (a fallback key when resolution by sid fails).
    #[serde(default)]
    pub cwd: Option<String>,
}

/// Response for `POST /api/hooks/event`. `ok` is always true.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HookEventResponse {
    pub ok: bool,
    pub matched: bool,
}

/// Request for `POST /api/focus`. Resolved like a hook event (sid then cwd).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct FocusRequest {
    #[serde(default)]
    pub sid: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
}

/// Response for `POST /api/focus`. `cockpit_terminal_id` is present only when resolved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusResponse {
    pub resolved: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cockpit_terminal_id: Option<String>,
}

/// In-app notification level.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NotificationLevel {
    Info,
    Warn,
    Error,
}

/// An in-app notification (an element of notifications.sync). The field order is the wire order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    /// Deduplication key for identical notifications.
    pub id: String,
    pub level: NotificationLevel,
    pub title: String,
    /// Supplementary body text (null if absent).
    pub body: Option<String>,
    /// Creation time (epoch ms).
    pub created_at: u64,
    /// While true, the toast is not auto-dismissed.
    pub sticky: bool,
    /// Whether the user can dismiss it manually.
    pub dismissible: bool,
    /// Whether to show it as a toast (true when omitted). An error that has a separate surface
    /// (ErrorDialog) uses `Some(false)` to avoid double display. It appears in the panel regardless of
    /// this value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub toast: Option<bool>,
}

/// Messages from server to client (discriminated by `t`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t")]
pub enum ServerMessage {
    #[serde(rename = "state.sync", rename_all = "camelCase")]
    StateSync {
        cockpit_terminals: Vec<CockpitTerminalInfo>,
        orgs: Vec<String>,
        /// org name -> display color. An empty map when omitted (tolerant of rolling updates).
        #[serde(default)]
        org_colors: BTreeMap<String, String>,
        /// org name -> display alias. An empty map when omitted (tolerant of rolling updates).
        #[serde(default)]
        org_aliases: BTreeMap<String, String>,
    },
    #[serde(rename = "term.reconnect", rename_all = "camelCase")]
    TermReconnect { term_ids: Vec<String> },
    #[serde(rename = "git.dirty")]
    GitDirty,
    #[serde(rename = "notify", rename_all = "camelCase")]
    Notify {
        kind: NotifyKind,
        cockpit_terminal_id: String,
        title: String,
    },
    /// Selects a window without a notification. Broadcast on POST /api/focus.
    #[serde(rename = "select", rename_all = "camelCase")]
    Select { cockpit_terminal_id: String },
    #[serde(rename = "error")]
    Error { code: String, message: String },
    /// Distribution of live-applied settings (to all control connections right after connecting and
    /// on config.json changes). The wire form is flat. `language` is the persisted display language
    /// value (null when unset = defer to the client's browser detection).
    #[serde(rename = "config.sync", rename_all = "camelCase")]
    ConfigSync {
        notify_sound: bool,
        update_check: bool,
        language: Option<String>,
        account_usage: bool,
        editor: Option<String>,
        footer_thresholds: FooterThresholds,
    },
    /// Full distribution of in-app notifications (to all control connections right after connecting
    /// and on changes; a full replacement, not a diff).
    #[serde(rename = "notifications.sync")]
    NotificationsSync { items: Vec<Notification> },
    /// Full distribution of per-org notes (org → Markdown text; to all control connections right after
    /// connecting and whenever a note is written or externally edited). A full replacement, not a diff.
    #[serde(rename = "notes.sync", rename_all = "camelCase")]
    NotesSync { notes: BTreeMap<String, String> },
    /// Whether zashiki's Claude Code integration is present in ~/.claude/settings.json (sent right
    /// after connecting and after each register/unregister). Drives the first-run wizard and the
    /// SETTINGS toggle. `status_line_conflict` means a non-zashiki statusLine is present (registering
    /// will wrap it to preserve it).
    #[serde(rename = "hooks.status", rename_all = "camelCase")]
    HooksStatus {
        hooks_registered: bool,
        status_line_registered: bool,
        status_line_conflict: bool,
    },
    /// Reply to a `update.check`, sent only to the requester. `version` carries the newer version when
    /// `status` is `available`, and is null otherwise.
    #[serde(rename = "update.check.result", rename_all = "camelCase")]
    UpdateCheckResult {
        status: UpdateCheckStatus,
        version: Option<String>,
    },
    /// Progress of an `update.perform`, broadcast to all connections. `detail` is null except on
    /// `failed`, where it carries the brew stderr tail.
    #[serde(rename = "update.status", rename_all = "camelCase")]
    UpdateStatus {
        state: UpdateStatusState,
        detail: Option<String>,
    },
    /// The signed-in Claude account (from `claude auth status`), sent right after connecting and again
    /// in reply to each `account.refresh`. `email` is null when not signed in or the status is
    /// unreadable. Auth is global per OS user, so this reflects every session at once.
    #[serde(rename = "account.status", rename_all = "camelCase")]
    AccountStatus {
        logged_in: bool,
        email: Option<String>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    fn to_json(v: &impl Serialize) -> String {
        serde_json::to_string(v).unwrap()
    }

    // ---- client -> server: the wire JSON shape (t tag + camelCase) ----

    #[test]
    fn term_open_roundtrips_and_matches_wire() {
        let json = r#"{"t":"term.open","termId":"abc","cockpitTerminalId":"@3","cols":80,"rows":24}"#;
        let msg: ClientMessage = serde_json::from_str(json).unwrap();
        assert_eq!(
            msg,
            ClientMessage::TermOpen {
                term_id: "abc".into(),
                cockpit_terminal_id: Some("@3".into()),
                cols: 80,
                rows: 24,
            }
        );
        assert_eq!(to_json(&msg), json);
    }

    #[test]
    fn term_open_omits_absent_cockpit_terminal_id() {
        let json = r#"{"t":"term.open","termId":"abc","cols":80,"rows":24}"#;
        let msg: ClientMessage = serde_json::from_str(json).unwrap();
        assert!(matches!(
            msg,
            ClientMessage::TermOpen {
                cockpit_terminal_id: None,
                ..
            }
        ));
        assert_eq!(to_json(&msg), json); // cockpitTerminalId is omitted
    }

    #[test]
    fn term_ack_and_others() {
        for (json, expected) in [
            (
                r#"{"t":"term.ack","termId":"t1","bytes":4096}"#,
                ClientMessage::TermAck {
                    term_id: "t1".into(),
                    bytes: 4096,
                },
            ),
            (
                r#"{"t":"term.resize","termId":"t1","cols":120,"rows":40}"#,
                ClientMessage::TermResize {
                    term_id: "t1".into(),
                    cols: 120,
                    rows: 40,
                },
            ),
            (
                r#"{"t":"term.select","termId":"t1","cockpitTerminalId":"@2"}"#,
                ClientMessage::TermSelect {
                    term_id: "t1".into(),
                    cockpit_terminal_id: "@2".into(),
                },
            ),
            (
                r#"{"t":"term.close","termId":"t1"}"#,
                ClientMessage::TermClose {
                    term_id: "t1".into(),
                },
            ),
            (
                r#"{"t":"cockpitTerminal.new","org":"charlie"}"#,
                ClientMessage::CockpitTerminalNew {
                    org: "charlie".into(),
                    resume_sid: None,
                },
            ),
            (
                r#"{"t":"cockpitTerminal.new","org":"charlie","resumeSid":"1b4e28ba-2fa1-11d2-883f-0016d3cca427"}"#,
                ClientMessage::CockpitTerminalNew {
                    org: "charlie".into(),
                    resume_sid: Some("1b4e28ba-2fa1-11d2-883f-0016d3cca427".into()),
                },
            ),
            (
                r#"{"t":"cockpitTerminal.close","cockpitTerminalId":"@5"}"#,
                ClientMessage::CockpitTerminalClose {
                    cockpit_terminal_id: "@5".into(),
                },
            ),
            (r#"{"t":"state.refresh"}"#, ClientMessage::StateRefresh),
        ] {
            let msg: ClientMessage = serde_json::from_str(json).unwrap();
            assert_eq!(msg, expected);
            assert_eq!(to_json(&msg), json);
        }
    }

    // ---- server -> client ----

    #[test]
    fn state_sync_matches_wire() {
        let msg = ServerMessage::StateSync {
            cockpit_terminals: vec![CockpitTerminalInfo {
                cockpit_terminal_id: "@1".into(),
                name: "repo".into(),
                org: "org1".into(),
                repo: "repo".into(),
                state: "running".into(),
                title: None,
                sid: None,
                active: true,
                running_subagents: None,
                shells_running: None,
                limited: false,
                usage: None,
            }],
            orgs: vec!["org1".into()],
            org_colors: BTreeMap::from([("org1".to_string(), "#7ec699".to_string())]),
            org_aliases: BTreeMap::from([("org1".to_string(), "Team One".to_string())]),
        };
        let json = r##"{"t":"state.sync","cockpitTerminals":[{"cockpitTerminalId":"@1","name":"repo","org":"org1","repo":"repo","state":"running","title":null,"active":true}],"orgs":["org1"],"orgColors":{"org1":"#7ec699"},"orgAliases":{"org1":"Team One"}}"##;
        assert_eq!(to_json(&msg), json);
        assert_eq!(serde_json::from_str::<ServerMessage>(json).unwrap(), msg);
    }

    #[test]
    fn state_sync_accepts_missing_org_colors() {
        // Backward compatibility with older servers: a missing orgColors collapses to an empty map.
        let json = r#"{"t":"state.sync","cockpitTerminals":[],"orgs":[]}"#;
        let msg: ServerMessage = serde_json::from_str(json).unwrap();
        assert_eq!(
            msg,
            ServerMessage::StateSync {
                cockpit_terminals: vec![],
                orgs: vec![],
                org_colors: BTreeMap::new(),
                org_aliases: BTreeMap::new(),
            }
        );
    }

    #[test]
    fn server_messages_match_wire() {
        for (json, msg) in [
            (
                r#"{"t":"term.reconnect","termIds":["a","b"]}"#,
                ServerMessage::TermReconnect {
                    term_ids: vec!["a".into(), "b".into()],
                },
            ),
            (r#"{"t":"git.dirty"}"#, ServerMessage::GitDirty),
            (
                r#"{"t":"notify","kind":"waiting","cockpitTerminalId":"@1","title":"hi"}"#,
                ServerMessage::Notify {
                    kind: NotifyKind::Waiting,
                    cockpit_terminal_id: "@1".into(),
                    title: "hi".into(),
                },
            ),
            (
                r#"{"t":"select","cockpitTerminalId":"@1"}"#,
                ServerMessage::Select {
                    cockpit_terminal_id: "@1".into(),
                },
            ),
            (
                r#"{"t":"error","code":"unknown_org","message":"no"}"#,
                ServerMessage::Error {
                    code: "unknown_org".into(),
                    message: "no".into(),
                },
            ),
        ] {
            assert_eq!(to_json(&msg), json);
            assert_eq!(serde_json::from_str::<ServerMessage>(json).unwrap(), msg);
        }
    }

    #[test]
    fn focus_response_omits_cockpit_terminal_id_when_unresolved() {
        assert_eq!(
            to_json(&FocusResponse {
                resolved: true,
                cockpit_terminal_id: Some("@1".into()),
            }),
            r#"{"resolved":true,"cockpitTerminalId":"@1"}"#
        );
        assert_eq!(
            to_json(&FocusResponse {
                resolved: false,
                cockpit_terminal_id: None,
            }),
            r#"{"resolved":false}"#
        );
    }

    #[test]
    fn focus_request_defaults_absent_fields_to_none() {
        assert_eq!(
            serde_json::from_str::<FocusRequest>(r#"{"sid":"abc"}"#).unwrap(),
            FocusRequest {
                sid: Some("abc".into()),
                cwd: None,
            }
        );
        assert_eq!(
            serde_json::from_str::<FocusRequest>(r#"{}"#).unwrap(),
            FocusRequest { sid: None, cwd: None }
        );
    }

    #[test]
    fn unknown_tag_is_rejected() {
        assert!(serde_json::from_str::<ClientMessage>(r#"{"t":"bogus"}"#).is_err());
    }

    // ---- wire-shape coverage (notification.dismiss / config.sync /
    //      notifications.sync / CockpitTerminalInfo.runningSubagents) ----

    #[test]
    fn session_info_serializes_running_subagents_when_present() {
        let msg = ServerMessage::StateSync {
            cockpit_terminals: vec![CockpitTerminalInfo {
                cockpit_terminal_id: "@1".into(),
                name: "repo".into(),
                org: "o".into(),
                repo: "repo".into(),
                state: "running_bg_agent".into(),
                title: None,
                sid: None,
                active: true,
                running_subagents: Some(3),
                shells_running: None,
                limited: false,
                usage: None,
            }],
            orgs: vec![],
            org_colors: BTreeMap::new(),
            org_aliases: BTreeMap::new(),
        };
        let json = r#"{"t":"state.sync","cockpitTerminals":[{"cockpitTerminalId":"@1","name":"repo","org":"o","repo":"repo","state":"running_bg_agent","title":null,"active":true,"runningSubagents":3}],"orgs":[],"orgColors":{},"orgAliases":{}}"#;
        assert_eq!(to_json(&msg), json);
        assert_eq!(serde_json::from_str::<ServerMessage>(json).unwrap(), msg);
    }

    #[test]
    fn session_info_serializes_shells_running_when_present() {
        let info = CockpitTerminalInfo {
            cockpit_terminal_id: "@1".into(),
            name: "repo".into(),
            org: "o".into(),
            repo: "repo".into(),
            state: "idle".into(),
            title: None,
            sid: None,
            active: false,
            running_subagents: None,
            shells_running: Some(2),
            limited: false,
            usage: None,
        };
        let json = r#"{"cockpitTerminalId":"@1","name":"repo","org":"o","repo":"repo","state":"idle","title":null,"active":false,"shellsRunning":2}"#;
        assert_eq!(to_json(&info), json);
        assert_eq!(serde_json::from_str::<CockpitTerminalInfo>(json).unwrap(), info);
    }

    #[test]
    fn session_info_omits_running_subagents_when_absent() {
        let info = CockpitTerminalInfo {
            cockpit_terminal_id: "@1".into(),
            name: "repo".into(),
            org: "o".into(),
            repo: "repo".into(),
            state: "running".into(),
            title: None,
            sid: None,
            active: false,
            running_subagents: None,
            shells_running: None,
            limited: false,
            usage: None,
        };
        let json = r#"{"cockpitTerminalId":"@1","name":"repo","org":"o","repo":"repo","state":"running","title":null,"active":false}"#;
        assert_eq!(to_json(&info), json);
        // Backward compatibility with older servers: a missing runningSubagents collapses to None.
        assert_eq!(serde_json::from_str::<CockpitTerminalInfo>(json).unwrap(), info);
    }

    #[test]
    fn session_info_serializes_sid_when_present() {
        let info = CockpitTerminalInfo {
            cockpit_terminal_id: "@1".into(),
            name: "repo".into(),
            org: "o".into(),
            repo: "repo".into(),
            state: "running".into(),
            title: None,
            sid: Some("0b6cbc45-83a9-4f2e-9c3d-1a2b3c4d5e6f".into()),
            active: true,
            running_subagents: None,
            shells_running: None,
            limited: false,
            usage: None,
        };
        let json = r#"{"cockpitTerminalId":"@1","name":"repo","org":"o","repo":"repo","state":"running","title":null,"sid":"0b6cbc45-83a9-4f2e-9c3d-1a2b3c4d5e6f","active":true}"#;
        assert_eq!(to_json(&info), json);
        assert_eq!(serde_json::from_str::<CockpitTerminalInfo>(json).unwrap(), info);
    }

    #[test]
    fn session_info_serializes_usage_with_limits() {
        let info = CockpitTerminalInfo {
            cockpit_terminal_id: "@1".into(),
            name: "repo".into(),
            org: "o".into(),
            repo: "repo".into(),
            state: "running".into(),
            title: None,
            sid: None,
            active: true,
            running_subagents: None,
            shells_running: None,
            limited: false,
            usage: Some(SessionUsage {
                turn_tokens: 1200,
                session_tokens: 3_400_000,
                turn_started_at: 1_700_000_000_000,
                session_started_at: 1_699_999_000_000,
                limits: Some(UsageLimits {
                    five_hour: Some(UsageLimit {
                        used_percent: 42,
                        resets_at: Some(1_700_010_000_000),
                    }),
                    week: Some(UsageLimit {
                        used_percent: 61,
                        resets_at: None,
                    }),
                }),
            }),
        };
        let json = r#"{"cockpitTerminalId":"@1","name":"repo","org":"o","repo":"repo","state":"running","title":null,"active":true,"usage":{"turnTokens":1200,"sessionTokens":3400000,"turnStartedAt":1700000000000,"sessionStartedAt":1699999000000,"limits":{"fiveHour":{"usedPercent":42,"resetsAt":1700010000000},"week":{"usedPercent":61}}}}"#;
        assert_eq!(to_json(&info), json);
        assert_eq!(serde_json::from_str::<CockpitTerminalInfo>(json).unwrap(), info);
    }

    #[test]
    fn session_info_usage_omits_limits_when_absent() {
        let info = CockpitTerminalInfo {
            cockpit_terminal_id: "@1".into(),
            name: "repo".into(),
            org: "o".into(),
            repo: "repo".into(),
            state: "idle".into(),
            title: None,
            sid: None,
            active: false,
            running_subagents: None,
            shells_running: None,
            limited: false,
            usage: Some(SessionUsage {
                turn_tokens: 0,
                session_tokens: 500,
                turn_started_at: 10,
                session_started_at: 10,
                limits: None,
            }),
        };
        let json = r#"{"cockpitTerminalId":"@1","name":"repo","org":"o","repo":"repo","state":"idle","title":null,"active":false,"usage":{"turnTokens":0,"sessionTokens":500,"turnStartedAt":10,"sessionStartedAt":10}}"#;
        assert_eq!(to_json(&info), json);
        assert_eq!(serde_json::from_str::<CockpitTerminalInfo>(json).unwrap(), info);
    }

    #[test]
    fn notification_dismiss_roundtrips_and_matches_wire() {
        let json = r#"{"t":"notification.dismiss","id":"restart-required"}"#;
        let msg: ClientMessage = serde_json::from_str(json).unwrap();
        assert_eq!(
            msg,
            ClientMessage::NotificationDismiss {
                id: "restart-required".into(),
            }
        );
        assert_eq!(to_json(&msg), json);
    }

    #[test]
    fn config_sync_matches_wire() {
        let msg = ServerMessage::ConfigSync {
            notify_sound: true,
            update_check: true,
            language: Some("ja".into()),
            account_usage: false,
            editor: Some("cursor -g".into()),
            footer_thresholds: FooterThresholds::default(),
        };
        let json = concat!(
            r#"{"t":"config.sync","notifySound":true,"updateCheck":true,"language":"ja","accountUsage":false,"editor":"cursor -g","footerThresholds":"#,
            r#"{"usagePercent":{"warn":{"enabled":true,"value":50},"high":{"enabled":true,"value":75},"crit":{"enabled":true,"value":91}},"#,
            r#""sessionTokens":{"warn":{"enabled":true,"value":1500000},"crit":{"enabled":true,"value":3000000}},"#,
            r#""elapsedMs":{"crit":{"enabled":true,"value":86400000}}}}"#
        );
        assert_eq!(to_json(&msg), json);
        assert_eq!(serde_json::from_str::<ServerMessage>(json).unwrap(), msg);
    }

    #[test]
    fn config_sync_language_null_when_unset() {
        let msg = ServerMessage::ConfigSync {
            notify_sound: true,
            update_check: false,
            language: None,
            account_usage: true,
            editor: None,
            footer_thresholds: FooterThresholds::default(),
        };
        let json = concat!(
            r#"{"t":"config.sync","notifySound":true,"updateCheck":false,"language":null,"accountUsage":true,"editor":null,"footerThresholds":"#,
            r#"{"usagePercent":{"warn":{"enabled":true,"value":50},"high":{"enabled":true,"value":75},"crit":{"enabled":true,"value":91}},"#,
            r#""sessionTokens":{"warn":{"enabled":true,"value":1500000},"crit":{"enabled":true,"value":3000000}},"#,
            r#""elapsedMs":{"crit":{"enabled":true,"value":86400000}}}}"#
        );
        assert_eq!(to_json(&msg), json);
        assert_eq!(serde_json::from_str::<ServerMessage>(json).unwrap(), msg);
    }

    #[test]
    fn config_update_roundtrips_and_matches_wire() {
        let json = r#"{"t":"config.update","language":"en"}"#;
        let msg: ClientMessage = serde_json::from_str(json).unwrap();
        assert_eq!(msg, ClientMessage::ConfigUpdate { language: "en".into() });
        assert_eq!(to_json(&msg), json);
    }

    #[test]
    fn config_set_account_usage_roundtrips_and_matches_wire() {
        let json = r#"{"t":"config.setAccountUsage","enabled":true}"#;
        let msg: ClientMessage = serde_json::from_str(json).unwrap();
        assert_eq!(msg, ClientMessage::ConfigSetAccountUsage { enabled: true });
        assert_eq!(to_json(&msg), json);
    }

    #[test]
    fn update_check_roundtrips_and_matches_wire() {
        let json = r#"{"t":"update.check"}"#;
        let msg: ClientMessage = serde_json::from_str(json).unwrap();
        assert_eq!(msg, ClientMessage::UpdateCheck);
        assert_eq!(to_json(&msg), json);
    }

    #[test]
    fn update_perform_roundtrips_and_matches_wire() {
        let json = r#"{"t":"update.perform"}"#;
        let msg: ClientMessage = serde_json::from_str(json).unwrap();
        assert_eq!(msg, ClientMessage::UpdatePerform);
        assert_eq!(to_json(&msg), json);
    }

    #[test]
    fn account_refresh_roundtrips_and_matches_wire() {
        let json = r#"{"t":"account.refresh","restartSessions":true}"#;
        let msg: ClientMessage = serde_json::from_str(json).unwrap();
        assert_eq!(msg, ClientMessage::AccountRefresh { restart_sessions: true });
        assert_eq!(to_json(&msg), json);
    }

    #[test]
    fn account_status_matches_wire() {
        let signed_in = ServerMessage::AccountStatus {
            logged_in: true,
            email: Some("user@example.com".into()),
        };
        assert_eq!(
            to_json(&signed_in),
            r#"{"t":"account.status","loggedIn":true,"email":"user@example.com"}"#
        );
        let signed_out = ServerMessage::AccountStatus {
            logged_in: false,
            email: None,
        };
        assert_eq!(
            to_json(&signed_out),
            r#"{"t":"account.status","loggedIn":false,"email":null}"#
        );
    }

    #[test]
    fn update_status_matches_wire() {
        let running = ServerMessage::UpdateStatus {
            state: UpdateStatusState::Running,
            detail: None,
        };
        assert_eq!(
            to_json(&running),
            r#"{"t":"update.status","state":"running","detail":null}"#
        );
        let failed = ServerMessage::UpdateStatus {
            state: UpdateStatusState::Failed,
            detail: Some("boom".into()),
        };
        assert_eq!(
            to_json(&failed),
            r#"{"t":"update.status","state":"failed","detail":"boom"}"#
        );
    }

    #[test]
    fn update_check_result_matches_wire() {
        let available = ServerMessage::UpdateCheckResult {
            status: UpdateCheckStatus::Available,
            version: Some("0.2.0".into()),
        };
        assert_eq!(
            to_json(&available),
            r#"{"t":"update.check.result","status":"available","version":"0.2.0"}"#
        );
        let up_to_date = ServerMessage::UpdateCheckResult {
            status: UpdateCheckStatus::UpToDate,
            version: None,
        };
        assert_eq!(
            to_json(&up_to_date),
            r#"{"t":"update.check.result","status":"upToDate","version":null}"#
        );
    }

    #[test]
    fn notifications_sync_matches_wire() {
        let msg = ServerMessage::NotificationsSync {
            items: vec![
                Notification {
                    id: "restart-required".into(),
                    level: NotificationLevel::Warn,
                    title: "cfg".into(),
                    body: Some("b".into()),
                    created_at: 1000,
                    sticky: true,
                    dismissible: false,
                    toast: None,
                },
                Notification {
                    id: "n2".into(),
                    level: NotificationLevel::Info,
                    title: "t".into(),
                    body: None,
                    created_at: 2000,
                    sticky: false,
                    dismissible: true,
                    toast: None,
                },
            ],
        };
        let json = r#"{"t":"notifications.sync","items":[{"id":"restart-required","level":"warn","title":"cfg","body":"b","createdAt":1000,"sticky":true,"dismissible":false},{"id":"n2","level":"info","title":"t","body":null,"createdAt":2000,"sticky":false,"dismissible":true}]}"#;
        assert_eq!(to_json(&msg), json);
        assert_eq!(serde_json::from_str::<ServerMessage>(json).unwrap(), msg);
    }

    #[test]
    fn error_notification_wire_carries_toast_false() {
        let msg = ServerMessage::NotificationsSync {
            items: vec![Notification {
                id: "e1".into(),
                level: NotificationLevel::Error,
                title: "internal".into(),
                body: Some("boom".into()),
                created_at: 3000,
                sticky: false,
                dismissible: true,
                toast: Some(false),
            }],
        };
        let json = r#"{"t":"notifications.sync","items":[{"id":"e1","level":"error","title":"internal","body":"boom","createdAt":3000,"sticky":false,"dismissible":true,"toast":false}]}"#;
        assert_eq!(to_json(&msg), json);
        assert_eq!(serde_json::from_str::<ServerMessage>(json).unwrap(), msg);
    }

    #[test]
    fn notes_sync_matches_wire() {
        let msg = ServerMessage::NotesSync {
            notes: BTreeMap::from([("acme".to_string(), "# Acme\n".to_string())]),
        };
        let json = r##"{"t":"notes.sync","notes":{"acme":"# Acme\n"}}"##;
        assert_eq!(to_json(&msg), json);
        assert_eq!(serde_json::from_str::<ServerMessage>(json).unwrap(), msg);
    }
}
