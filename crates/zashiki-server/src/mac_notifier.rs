//! The executor for macOS notifications. A fallback path that
//! surfaces "awareness" via terminal-notifier when no browser is connected. Absence or failure is silently
//! skipped (best-effort). No click navigation (-execute) is attached (the destination is handled by the browser's Web Notification).

use std::process::{Command, Stdio};

use crate::protocol::NotifyKind;
use crate::hooks::{MacNotification, MacNotify};

/// Creates the executor that emits notifications via terminal-notifier.
pub fn terminal_notifier() -> MacNotify {
    std::sync::Arc::new(|n: MacNotification| {
        // Sounds: waiting=Funk / done=Glass.
        let (emoji, sound) = match n.kind {
            NotifyKind::Waiting => ("⏳", "Funk"),
            NotifyKind::Done => ("✅", "Glass"),
        };
        let title = format!("zashiki {emoji} {}", n.title);
        let message = if n.message.is_empty() {
            n.title.clone()
        } else {
            n.message.clone()
        };
        let group = format!("zashiki-{}", n.title);
        // fire-and-forget. Absence (ENOENT) and execution failure are swallowed (best-effort).
        let _ = Command::new("terminal-notifier")
            .args([
                "-title", &title, "-message", &message, "-sound", sound, "-group", &group,
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    })
}
