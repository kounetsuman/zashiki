//! Wire types for `/ws/control` (a port of `ClientMessage` / `ServerMessage` / `SessionInfo` from
//! the TS `packages/shared/src/protocol.ts` using serde internally-tagged enums). The JSON is
//! byte-equivalent to the TS, which is the condition for leaving the client unmodified. Not yet wired
//! into the WS handler (only the type foundation; non-breaking).

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
pub struct SessionInfo {
    /// The id of the owned PTY session (the session UUID when owned).
    pub window_id: String,
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
        window_id: Option<String>,
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
    TermSelect { term_id: String, window_id: String },
    #[serde(rename = "term.close", rename_all = "camelCase")]
    TermClose { term_id: String },
    /// Flow-control ACK. `bytes` is the amount xterm.js has finished writing (in UTF-16 code units).
    #[serde(rename = "term.ack", rename_all = "camelCase")]
    TermAck { term_id: String, bytes: u64 },
    #[serde(rename = "session.new")]
    SessionNew { org: String },
    #[serde(rename = "session.close", rename_all = "camelCase")]
    SessionClose { window_id: String },
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
    /// On-demand "Check for updates" from SETTINGS. The server checks GitHub Releases now and replies
    /// with an `update.check.result` (a newer version additionally lands as a notification).
    #[serde(rename = "update.check")]
    UpdateCheck,
}

/// Result of an on-demand update check, sent only to the requester so SETTINGS can show feedback.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateCheckStatus {
    Available,
    UpToDate,
    Error,
}

/// The kind of notify.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NotifyKind {
    Waiting,
    Done,
}

/// The kind of Claude Code hook event (TS `hookEventKindSchema`).
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

/// Request for `POST /api/hooks/event` (TS `hookEventRequestSchema`).
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

/// Response for `POST /api/hooks/event` (TS `hookEventResponseSchema`). `ok` is always true.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HookEventResponse {
    pub ok: bool,
    pub matched: bool,
}

/// Request for `POST /api/focus` (TS `focusRequestSchema`). Resolved like a hook event (sid then cwd).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct FocusRequest {
    #[serde(default)]
    pub sid: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
}

/// Response for `POST /api/focus` (TS `focusResponseSchema`). `window_id` is present only when resolved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusResponse {
    pub resolved: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_id: Option<String>,
}

/// In-app notification level (TS `notificationLevelSchema` in `notifications.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NotificationLevel {
    Info,
    Warn,
    Error,
}

/// An in-app notification (an element of notifications.sync). A port of `notificationSchema` in the
/// TS `notifications.ts`. The field order matches the TS schema definition order = the wire order.
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
    /// this value (TS `notificationSchema.toast`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub toast: Option<bool>,
}

/// Messages from server to client (discriminated by `t`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t")]
pub enum ServerMessage {
    #[serde(rename = "state.sync", rename_all = "camelCase")]
    StateSync {
        sessions: Vec<SessionInfo>,
        orgs: Vec<String>,
        /// org name -> display color. An empty map when omitted (tolerant of rolling updates).
        #[serde(default)]
        org_colors: BTreeMap<String, String>,
    },
    #[serde(rename = "term.reconnect", rename_all = "camelCase")]
    TermReconnect { term_ids: Vec<String> },
    #[serde(rename = "git.dirty")]
    GitDirty,
    #[serde(rename = "notify", rename_all = "camelCase")]
    Notify {
        kind: NotifyKind,
        window_id: String,
        title: String,
    },
    /// Selects a window without a notification (TS `selectSchema`). Broadcast on POST /api/focus.
    #[serde(rename = "select", rename_all = "camelCase")]
    Select { window_id: String },
    #[serde(rename = "error")]
    Error { code: String, message: String },
    /// Distribution of live-applied settings (to all control connections right after connecting and
    /// on config.json changes). The wire form is flat. `language` is the persisted display language
    /// value (null when unset = defer to the client's browser detection).
    #[serde(rename = "config.sync", rename_all = "camelCase")]
    ConfigSync {
        notify_sound: bool,
        debug: bool,
        update_check: bool,
        language: Option<String>,
    },
    /// Full distribution of in-app notifications (to all control connections right after connecting
    /// and on changes; a full replacement, not a diff).
    #[serde(rename = "notifications.sync")]
    NotificationsSync { items: Vec<Notification> },
    /// Reply to a `update.check`, sent only to the requester. `version` carries the newer version when
    /// `status` is `available`, and is null otherwise.
    #[serde(rename = "update.check.result", rename_all = "camelCase")]
    UpdateCheckResult {
        status: UpdateCheckStatus,
        version: Option<String>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    fn to_json(v: &impl Serialize) -> String {
        serde_json::to_string(v).unwrap()
    }

    // ---- client -> server: byte-equivalent to the TS JSON shape (t tag + camelCase) ----

    #[test]
    fn term_open_roundtrips_and_matches_wire() {
        let json = r#"{"t":"term.open","termId":"abc","windowId":"@3","cols":80,"rows":24}"#;
        let msg: ClientMessage = serde_json::from_str(json).unwrap();
        assert_eq!(
            msg,
            ClientMessage::TermOpen {
                term_id: "abc".into(),
                window_id: Some("@3".into()),
                cols: 80,
                rows: 24,
            }
        );
        assert_eq!(to_json(&msg), json);
    }

    #[test]
    fn term_open_omits_absent_window_id() {
        let json = r#"{"t":"term.open","termId":"abc","cols":80,"rows":24}"#;
        let msg: ClientMessage = serde_json::from_str(json).unwrap();
        assert!(matches!(
            msg,
            ClientMessage::TermOpen {
                window_id: None,
                ..
            }
        ));
        assert_eq!(to_json(&msg), json); // windowId is omitted
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
                r#"{"t":"term.select","termId":"t1","windowId":"@2"}"#,
                ClientMessage::TermSelect {
                    term_id: "t1".into(),
                    window_id: "@2".into(),
                },
            ),
            (
                r#"{"t":"term.close","termId":"t1"}"#,
                ClientMessage::TermClose {
                    term_id: "t1".into(),
                },
            ),
            (
                r#"{"t":"session.new","org":"charlie"}"#,
                ClientMessage::SessionNew {
                    org: "charlie".into(),
                },
            ),
            (
                r#"{"t":"session.close","windowId":"@5"}"#,
                ClientMessage::SessionClose {
                    window_id: "@5".into(),
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
            sessions: vec![SessionInfo {
                window_id: "@1".into(),
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
        };
        let json = r##"{"t":"state.sync","sessions":[{"windowId":"@1","name":"repo","org":"org1","repo":"repo","state":"running","title":null,"active":true}],"orgs":["org1"],"orgColors":{"org1":"#7ec699"}}"##;
        assert_eq!(to_json(&msg), json);
        assert_eq!(serde_json::from_str::<ServerMessage>(json).unwrap(), msg);
    }

    #[test]
    fn state_sync_accepts_missing_org_colors() {
        // Backward compatibility with older servers: a missing orgColors collapses to an empty map.
        let json = r#"{"t":"state.sync","sessions":[],"orgs":[]}"#;
        let msg: ServerMessage = serde_json::from_str(json).unwrap();
        assert_eq!(
            msg,
            ServerMessage::StateSync {
                sessions: vec![],
                orgs: vec![],
                org_colors: BTreeMap::new(),
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
                r#"{"t":"notify","kind":"waiting","windowId":"@1","title":"hi"}"#,
                ServerMessage::Notify {
                    kind: NotifyKind::Waiting,
                    window_id: "@1".into(),
                    title: "hi".into(),
                },
            ),
            (
                r#"{"t":"select","windowId":"@1"}"#,
                ServerMessage::Select {
                    window_id: "@1".into(),
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
    fn focus_response_omits_window_id_when_unresolved() {
        assert_eq!(
            to_json(&FocusResponse {
                resolved: true,
                window_id: Some("@1".into()),
            }),
            r#"{"resolved":true,"windowId":"@1"}"#
        );
        assert_eq!(
            to_json(&FocusResponse {
                resolved: false,
                window_id: None,
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

    // ---- wire parity coverage (notification.dismiss / config.sync /
    //      notifications.sync / SessionInfo.runningSubagents) ----

    #[test]
    fn session_info_serializes_running_subagents_when_present() {
        let msg = ServerMessage::StateSync {
            sessions: vec![SessionInfo {
                window_id: "@1".into(),
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
        };
        let json = r#"{"t":"state.sync","sessions":[{"windowId":"@1","name":"repo","org":"o","repo":"repo","state":"running_bg_agent","title":null,"active":true,"runningSubagents":3}],"orgs":[],"orgColors":{}}"#;
        assert_eq!(to_json(&msg), json);
        assert_eq!(serde_json::from_str::<ServerMessage>(json).unwrap(), msg);
    }

    #[test]
    fn session_info_serializes_shells_running_when_present() {
        let info = SessionInfo {
            window_id: "@1".into(),
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
        let json = r#"{"windowId":"@1","name":"repo","org":"o","repo":"repo","state":"idle","title":null,"active":false,"shellsRunning":2}"#;
        assert_eq!(to_json(&info), json);
        assert_eq!(serde_json::from_str::<SessionInfo>(json).unwrap(), info);
    }

    #[test]
    fn session_info_omits_running_subagents_when_absent() {
        let info = SessionInfo {
            window_id: "@1".into(),
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
        let json = r#"{"windowId":"@1","name":"repo","org":"o","repo":"repo","state":"running","title":null,"active":false}"#;
        assert_eq!(to_json(&info), json);
        // Backward compatibility with older servers: a missing runningSubagents collapses to None.
        assert_eq!(serde_json::from_str::<SessionInfo>(json).unwrap(), info);
    }

    #[test]
    fn session_info_serializes_sid_when_present() {
        let info = SessionInfo {
            window_id: "@1".into(),
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
        let json = r#"{"windowId":"@1","name":"repo","org":"o","repo":"repo","state":"running","title":null,"sid":"0b6cbc45-83a9-4f2e-9c3d-1a2b3c4d5e6f","active":true}"#;
        assert_eq!(to_json(&info), json);
        assert_eq!(serde_json::from_str::<SessionInfo>(json).unwrap(), info);
    }

    #[test]
    fn session_info_serializes_usage_with_limits() {
        let info = SessionInfo {
            window_id: "@1".into(),
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
        let json = r#"{"windowId":"@1","name":"repo","org":"o","repo":"repo","state":"running","title":null,"active":true,"usage":{"turnTokens":1200,"sessionTokens":3400000,"turnStartedAt":1700000000000,"sessionStartedAt":1699999000000,"limits":{"fiveHour":{"usedPercent":42,"resetsAt":1700010000000},"week":{"usedPercent":61}}}}"#;
        assert_eq!(to_json(&info), json);
        assert_eq!(serde_json::from_str::<SessionInfo>(json).unwrap(), info);
    }

    #[test]
    fn session_info_usage_omits_limits_when_absent() {
        let info = SessionInfo {
            window_id: "@1".into(),
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
        let json = r#"{"windowId":"@1","name":"repo","org":"o","repo":"repo","state":"idle","title":null,"active":false,"usage":{"turnTokens":0,"sessionTokens":500,"turnStartedAt":10,"sessionStartedAt":10}}"#;
        assert_eq!(to_json(&info), json);
        assert_eq!(serde_json::from_str::<SessionInfo>(json).unwrap(), info);
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
            debug: false,
            update_check: true,
            language: Some("ja".into()),
        };
        let json =
            r#"{"t":"config.sync","notifySound":true,"debug":false,"updateCheck":true,"language":"ja"}"#;
        assert_eq!(to_json(&msg), json);
        assert_eq!(serde_json::from_str::<ServerMessage>(json).unwrap(), msg);
    }

    #[test]
    fn config_sync_language_null_when_unset() {
        let msg = ServerMessage::ConfigSync {
            notify_sound: true,
            debug: false,
            update_check: false,
            language: None,
        };
        let json =
            r#"{"t":"config.sync","notifySound":true,"debug":false,"updateCheck":false,"language":null}"#;
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
    fn update_check_roundtrips_and_matches_wire() {
        let json = r#"{"t":"update.check"}"#;
        let msg: ClientMessage = serde_json::from_str(json).unwrap();
        assert_eq!(msg, ClientMessage::UpdateCheck);
        assert_eq!(to_json(&msg), json);
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
}
