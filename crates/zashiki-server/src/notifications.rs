//! Pure functions for in-app notifications (NOTIFICATION).
//! The upsert, sorting, and eviction used for the hooks waiting/done accumulation, plus the notification builders.
//! The canonical source of behavior is the `tests` module at the end.

use crate::protocol::{Notification, NotificationLevel, NotifyKind};

/// Default cap on the list (a safeguard so unique-id notifications don't accumulate without bound).
pub const NOTIFICATIONS_MAX: usize = 100;

/// Notification that pushes a server error (`{t:"error"}`) into NOTIFICATION. Accumulates with a
/// unique id per occurrence. Uses code as the title and message as the body, and sets
/// `toast: Some(false)` to avoid double-display with the ErrorDialog (it still appears in the panel).
pub fn error_notification(id: String, code: &str, message: &str, created_at: u64) -> Notification {
    Notification {
        id,
        level: NotificationLevel::Error,
        title: code.to_string(),
        body: Some(message.to_string()),
        created_at,
        sticky: false,
        dismissible: true,
        toast: Some(false),
    }
}

/// Warning that pushes orphan/zombie process detection into NOTIFICATION. Deduplicated by id and manually
/// dismissible by the user (it holds no self-clearing state sync; it just names the process once).
pub fn warn_notification(
    id: String,
    title: String,
    body: Option<String>,
    created_at: u64,
) -> Notification {
    Notification {
        id,
        level: NotificationLevel::Warn,
        title,
        body,
        created_at,
        sticky: false,
        dismissible: true,
        toast: None,
    }
}

/// Notification that pushes the hooks waiting/done into NOTIFICATION. `toast: Some(false)` so it
/// appears only in NOTIFICATION: the transient toast is driven by the separate notify push, which
/// the client renders as a persistent, click-to-focus session toast (avoids double-display).
pub fn notify_notification(
    id: String,
    kind: NotifyKind,
    window_title: &str,
    created_at: u64,
) -> Notification {
    let label = match kind {
        NotifyKind::Waiting => "⏳ 応答待ち",
        NotifyKind::Done => "✅ 完了",
    };
    Notification {
        id,
        level: NotificationLevel::Info,
        title: format!("{label} {window_title}"),
        body: None,
        created_at,
        sticky: false,
        dismissible: true,
        toast: Some(false),
    }
}

/// Fixed id for the PTY-exhaustion notification. Coalesces consecutive failures into one entry (the upsert key).
pub const PTY_EXHAUSTION_ID: &str = "pty-exhausted";

/// Whether this is a PTY-exhaustion (ENXIO-family) message from PTY allocation.
/// A `fork failed` on EAGAIN alone (process-count limit) is a different cause, so it isn't caught.
pub fn is_pty_exhaustion(message: &str) -> bool {
    let m = message.to_lowercase();
    m.contains("device not configured")
        || m.contains("enxio")
        || m.contains("openpty")
        || m.contains("out of ptys")
        || m.contains("no more ptys")
        || m.contains("ptmx")
}

/// Warning pushed into NOTIFICATION when creation (session.new / term.open) fails due to PTY exhaustion.
/// With a fixed id, consecutive failures don't stack; only the timestamp is updated (upsert). Sticky and manually dismissible so it stays until resolved.
pub fn pty_exhaustion_notification(created_at: u64) -> Notification {
    Notification {
        id: PTY_EXHAUSTION_ID.to_string(),
        level: NotificationLevel::Warn,
        title: "⚠️ PTY（疑似端末）が枯渇".to_string(),
        body: Some(
            "セッション/タブを作成できませんでした。不要なタブ/セッションを閉じてから再試行してください。"
                .to_string(),
        ),
        created_at,
        sticky: true,
        dismissible: true,
        // Panel only, to avoid double-toasting with the ErrorDialog (same policy as error_notification).
        toast: Some(false),
    }
}

/// Fixed id for the scrollback-memory pressure notification. A singleton (upsert) that is refreshed
/// or withdrawn as aggregate usage crosses the danger threshold back and forth.
pub const SCROLLBACK_PRESSURE_ID: &str = "scrollback-pressure";

/// Warning pushed into NOTIFICATION when the total scrollback retained across all sessions enters the
/// danger zone. Session history is kept without eviction (so the first prompt stays reachable), so the
/// user is asked to close unneeded sessions rather than the server silently truncating history. Fixed
/// id (upsert), toast + panel, manually dismissible.
pub fn scrollback_pressure_notification(used_bytes: usize, created_at: u64) -> Notification {
    let used_mib = used_bytes / (1024 * 1024);
    Notification {
        id: SCROLLBACK_PRESSURE_ID.to_string(),
        level: NotificationLevel::Warn,
        title: "⚠️ スクロールバックのメモリ使用が増大".to_string(),
        body: Some(format!(
            "全セッションの履歴が約 {used_mib}MiB を占有しています。履歴は自動削除されません。不要なタブ/セッションを閉じてメモリを解放してください。"
        )),
        created_at,
        sticky: false,
        dismissible: true,
        toast: Some(true),
    }
}

/// Notification announcing that a newer stable release exists on GitHub than the running bundle (#26).
/// The id is per-version (`update-available:<version>`) so the same latest version does not re-stack on
/// every daily poll (singleton per version via upsert), while a genuinely newer version stacks as a new
/// entry. Toast + panel; sticky and non-dismissible so the update stays (and its header button keeps
/// showing) until the running bundle actually catches up to the latest version.
pub fn update_available_notification(version: &str, url: &str, created_at: u64) -> Notification {
    Notification {
        id: format!("update-available:{version}"),
        level: NotificationLevel::Warn,
        title: format!("🆕 新しいバージョン {version} が利用できます"),
        body: Some(format!(
            "最新の安定版 {version} が公開されています。更新は {url} を確認してください。"
        )),
        created_at,
        sticky: true,
        dismissible: false,
        toast: Some(true),
    }
}

/// An external-dependency boundary that failed to launch/read and would otherwise be swallowed silently.
/// Each variant carries a fixed notification id (upsert key), a ⚠️ Japanese title, and a body naming the
/// concrete thing to fix.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BoundaryFailure {
    /// ripgrep could not be spawned; a cross-repo search may be incomplete.
    RgMissing,
    /// The `ZK_EDITOR` binary could not be launched (not found / not executable).
    EditorFailed,
    /// The `claude` binary could not be resolved from PATH or the usual install dirs.
    ClaudeMissing,
    /// `~/.claude/settings.json` exists but could not be read (invalid JSON or permission error).
    SettingsUnreadable,
}

impl BoundaryFailure {
    pub fn id(self) -> &'static str {
        match self {
            Self::RgMissing => "boundary:rg-missing",
            Self::EditorFailed => "boundary:editor-failed",
            Self::ClaudeMissing => "boundary:claude-missing",
            Self::SettingsUnreadable => "boundary:settings-unreadable",
        }
    }

    /// Persistent misconfigurations (claude / settings) that only re-check at boot stay sticky so notification
    /// pressure can't evict them before they are fixed; the per-action causes (rg / editor) re-fire on the next
    /// search / click, so they auto-dismiss like other transient warns.
    pub fn sticky(self) -> bool {
        matches!(self, Self::ClaudeMissing | Self::SettingsUnreadable)
    }

    pub fn title(self) -> &'static str {
        match self {
            Self::RgMissing => "⚠️ 検索ツール（ripgrep）を起動できません",
            Self::EditorFailed => "⚠️ エディタを起動できません",
            Self::ClaudeMissing => "⚠️ claude コマンドが見つかりません",
            Self::SettingsUnreadable => "⚠️ settings.json を読み取れません",
        }
    }

    pub fn body(self) -> &'static str {
        match self {
            Self::RgMissing => {
                "ripgrep (rg) を起動できませんでした。検索結果が不完全な可能性があります。rg をインストールし PATH を確認してください。"
            }
            Self::EditorFailed => {
                "設定されたエディタ（環境変数 ZK_EDITOR）を起動できませんでした。コマンドが見つからないか実行できません。ZK_EDITOR の設定を確認してください。"
            }
            Self::ClaudeMissing => {
                "claude を PATH および ~/.claude/local・~/.local/bin・/opt/homebrew/bin などから解決できませんでした。claude をインストールし PATH を確認してください。"
            }
            Self::SettingsUnreadable => {
                "~/.claude/settings.json は存在しますが読み取れません（JSON が不正、または権限エラー）。ファイルを確認してください。連携状態は「未登録」と表示されます。"
            }
        }
    }
}

/// Warn notification for an external-dependency boundary failure (toast + panel). Fixed id upserts; sticky
/// per cause so persistent misconfigurations aren't evicted before they are fixed.
pub fn boundary_notification(failure: BoundaryFailure, created_at: u64) -> Notification {
    Notification {
        id: failure.id().to_string(),
        level: NotificationLevel::Warn,
        title: failure.title().to_string(),
        body: Some(failure.body().to_string()),
        created_at,
        sticky: failure.sticky(),
        dismissible: true,
        toast: None,
    }
}

/// Newest-first ordering (createdAt descending; ties by id ascending).
fn by_newest(a: &Notification, b: &Notification) -> std::cmp::Ordering {
    b.created_at.cmp(&a.created_at).then_with(|| a.id.cmp(&b.id))
}

/// Replace an entry with the same id, or append if none, then return sorted newest-first.
pub fn upsert_notification(list: &[Notification], n: Notification) -> Vec<Notification> {
    let mut next: Vec<Notification> = list.iter().filter(|x| x.id != n.id).cloned().collect();
    next.push(n);
    next.sort_by(by_newest);
    next
}

/// Upsert, sort newest-first, and evict oldest-first once `max` is exceeded. sticky or non-dismissible entries
/// (those that should remain until resolved) are not evicted. `max == 0` means no cap.
pub fn append_notification(list: &[Notification], n: Notification, max: usize) -> Vec<Notification> {
    let upserted = upsert_notification(list, n);
    if max == 0 || upserted.len() <= max {
        return upserted;
    }
    let evictable = |x: &Notification| !x.sticky && x.dismissible;
    let protected_count = upserted.iter().filter(|x| !evictable(x)).count();
    let allowed_evictable = max.saturating_sub(protected_count);
    let mut kept_evictable = 0usize;
    upserted
        .into_iter()
        .filter(|x| {
            if !evictable(x) {
                return true;
            }
            kept_evictable += 1;
            kept_evictable <= allowed_evictable
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(id: &str, created_at: u64) -> Notification {
        Notification {
            id: id.to_string(),
            level: NotificationLevel::Info,
            title: id.to_string(),
            body: None,
            created_at,
            sticky: false,
            dismissible: true,
            toast: None,
        }
    }

    #[test]
    fn error_notification_maps_code_message_and_suppresses_toast() {
        let e = error_notification("e1".to_string(), "internal", "boom", 7);
        assert_eq!(e.level, NotificationLevel::Error);
        assert_eq!(e.title, "internal");
        assert_eq!(e.body.as_deref(), Some("boom"));
        assert_eq!(e.toast, Some(false));
        assert!(e.dismissible && !e.sticky);
    }

    #[test]
    fn boundary_failure_ids_are_unique_and_prefixed() {
        let all = [
            BoundaryFailure::RgMissing,
            BoundaryFailure::EditorFailed,
            BoundaryFailure::ClaudeMissing,
            BoundaryFailure::SettingsUnreadable,
        ];
        for f in all {
            assert!(f.id().starts_with("boundary:"), "{:?} id is prefixed", f);
            assert!(f.title().starts_with("⚠️"), "{:?} title carries the warn glyph", f);
            assert!(!f.body().is_empty(), "{:?} body is non-empty", f);
        }
        let ids: std::collections::HashSet<_> = all.iter().map(|f| f.id()).collect();
        assert_eq!(ids.len(), all.len(), "each cause maps to a distinct upsert id");
    }

    #[test]
    fn boundary_notification_is_warn_and_sticky_only_for_persistent_causes() {
        // Persistent, boot-checked causes stay sticky so notification pressure can't evict them before a fix.
        for f in [BoundaryFailure::ClaudeMissing, BoundaryFailure::SettingsUnreadable] {
            let n = boundary_notification(f, 1);
            assert_eq!(n.level, NotificationLevel::Warn);
            assert_eq!(n.id, f.id());
            assert!(n.sticky, "{:?} must survive eviction", f);
            assert!(!evictable(&n), "{:?} must not be evictable", f);
        }
        // Per-action causes re-fire on the next search/click, so they auto-dismiss like other transient warns.
        for f in [BoundaryFailure::RgMissing, BoundaryFailure::EditorFailed] {
            let n = boundary_notification(f, 1);
            assert!(!n.sticky, "{:?} should not linger", f);
        }
    }

    fn evictable(n: &Notification) -> bool {
        !n.sticky && n.dismissible
    }

    #[test]
    fn boundary_failure_bodies_name_the_thing_to_fix() {
        // The body must point at the concrete lever (env var / file / binary), since it carries no dynamic detail.
        assert!(BoundaryFailure::RgMissing.body().contains("rg"));
        assert!(BoundaryFailure::EditorFailed.body().contains("ZK_EDITOR"));
        assert!(BoundaryFailure::ClaudeMissing.body().contains("claude"));
        assert!(BoundaryFailure::SettingsUnreadable.body().contains("settings.json"));
    }

    #[test]
    fn warn_notification_is_warn_level_and_dismissible() {
        let w = warn_notification(
            "orphan:42".to_string(),
            "👻 孤児プロセス pid 42".to_string(),
            Some("claude --resume".to_string()),
            9,
        );
        assert_eq!(w.level, NotificationLevel::Warn);
        assert_eq!(w.title, "👻 孤児プロセス pid 42");
        assert_eq!(w.body.as_deref(), Some("claude --resume"));
        assert!(w.dismissible && !w.sticky);
        assert_eq!(w.toast, None);
    }

    #[test]
    fn notify_notification_uses_toast_wording() {
        let w = notify_notification("id1".to_string(), NotifyKind::Waiting, "repo-a", 5);
        assert_eq!(w.title, "⏳ 応答待ち repo-a");
        assert_eq!(w.level, NotificationLevel::Info);
        assert!(w.dismissible && !w.sticky);
        assert_eq!(w.toast, Some(false));
        let d = notify_notification("id2".to_string(), NotifyKind::Done, "repo-b", 6);
        assert_eq!(d.title, "✅ 完了 repo-b");
    }

    #[test]
    fn scrollback_pressure_notification_is_warn_singleton_with_mib_body() {
        let n = scrollback_pressure_notification(600 * 1024 * 1024, 42);
        assert_eq!(n.id, SCROLLBACK_PRESSURE_ID);
        assert_eq!(n.level, NotificationLevel::Warn);
        assert!(n.body.as_deref().unwrap().contains("600MiB"));
        assert!(n.dismissible && !n.sticky);
        assert_eq!(n.toast, Some(true));
    }

    #[test]
    fn is_pty_exhaustion_matches_enxio_family_only() {
        assert!(is_pty_exhaustion("openpty(2) failed: Device not configured"));
        assert!(is_pty_exhaustion("spawn failed: ENXIO"));
        assert!(is_pty_exhaustion("no more ptys available"));
        // EAGAIN (process-count limit) alone is a different cause and isn't caught.
        assert!(!is_pty_exhaustion("fork failed: Resource temporarily unavailable"));
        assert!(!is_pty_exhaustion("permission denied"));
    }

    #[test]
    fn pty_exhaustion_notification_is_sticky_warn_with_fixed_id() {
        let n = pty_exhaustion_notification(42);
        assert_eq!(n.id, PTY_EXHAUSTION_ID);
        assert_eq!(n.level, NotificationLevel::Warn);
        assert!(n.sticky && n.dismissible);
        // With a fixed id, consecutive failures coalesce into one entry (upsert updates only the timestamp).
        let out = upsert_notification(
            &[pty_exhaustion_notification(1)],
            pty_exhaustion_notification(2),
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].created_at, 2);
    }

    #[test]
    fn update_available_notification_is_per_version_toasting_warn() {
        let n = update_available_notification("0.2.0", "https://example.test/rel", 11);
        assert_eq!(n.id, "update-available:0.2.0");
        assert_eq!(n.level, NotificationLevel::Warn);
        assert_eq!(n.toast, Some(true));
        assert!(!n.dismissible && n.sticky);
        assert!(n.body.as_deref().unwrap().contains("https://example.test/rel"));
        // Same version re-poll coalesces (singleton per version); a newer version stacks as a new entry.
        let same = upsert_notification(
            &[update_available_notification("0.2.0", "u", 1)],
            update_available_notification("0.2.0", "u", 2),
        );
        assert_eq!(same.len(), 1);
        let newer = upsert_notification(&same, update_available_notification("0.3.0", "u", 3));
        assert_eq!(newer.len(), 2);
    }

    #[test]
    fn update_available_survives_eviction_under_a_notification_storm() {
        let mut list = vec![update_available_notification("0.3.0", "u", 1)];
        for i in 0..50u64 {
            list = append_notification(&list, note(&format!("n{i}"), 100 + i), 5);
        }
        assert!(list.iter().any(|x| x.id == "update-available:0.3.0"));
    }

    #[test]
    fn upsert_replaces_same_id_and_sorts_newest_first() {
        let list = vec![note("a", 1), note("b", 2)];
        let out = upsert_notification(&list, note("a", 3));
        // Replace a with a newer createdAt -> newest-first a(3), b(2).
        assert_eq!(
            out.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(),
            vec!["a", "b"]
        );
        assert_eq!(out[0].created_at, 3);
    }

    #[test]
    fn same_time_ties_break_by_id_ascending() {
        let out = upsert_notification(&[note("b", 1)], note("a", 1));
        assert_eq!(
            out.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(),
            vec!["a", "b"]
        );
    }

    #[test]
    fn append_caps_at_max_evicting_oldest() {
        let mut list: Vec<Notification> = Vec::new();
        for i in 1..=5 {
            list = append_notification(&list, note(&format!("n{i}"), i), 3);
        }
        // Only the 3 newest remain (the older n1/n2 are evicted).
        assert_eq!(
            list.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(),
            vec!["n5", "n4", "n3"]
        );
    }

    #[test]
    fn append_does_not_evict_sticky_or_non_dismissible() {
        let mut sticky = note("keep", 1);
        sticky.sticky = true;
        let list = vec![sticky];
        let mut out = list;
        for i in 2..=5 {
            out = append_notification(&out, note(&format!("n{i}"), i), 2);
        }
        // sticky survives beyond max, and only the 1 newest evictable entry remains.
        assert!(out.iter().any(|n| n.id == "keep"));
        let evictable_ids: Vec<&str> = out
            .iter()
            .filter(|n| !n.sticky && n.dismissible)
            .map(|n| n.id.as_str())
            .collect();
        assert_eq!(evictable_ids, vec!["n5"]);
    }

    #[test]
    fn max_zero_means_unlimited() {
        let mut list: Vec<Notification> = Vec::new();
        for i in 1..=10 {
            list = append_notification(&list, note(&format!("n{i}"), i), 0);
        }
        assert_eq!(list.len(), 10);
    }
}
