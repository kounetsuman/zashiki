//! In-app update of the active Claude Code CLI (the SETTINGS "Claude Code" tab Update button).
//!
//! Supported only for a native active install (`claude update`); any other method reports
//! `unsupported`. Runs off the WS loop (the update is long-running); progress rides
//! `runtime.update.status` and a fresh `runtime.info` follows on completion.

use std::sync::Arc;

use crate::control_hub::ControlHub;
use crate::protocol::{InstallMethod, RuntimeUpdateState};

/// Runs `claude update` when the active install is the native installer, broadcasting progress and a
/// re-scanned `runtime.info` on completion. A non-native (or absent) active install is a no-op that
/// reports `unsupported`.
pub(crate) async fn run_runtime_update(hub: Arc<ControlHub>) {
    if crate::runtime_info::active_install_method() != Some(InstallMethod::Native) {
        hub.publish_runtime_update_status(RuntimeUpdateState::Unsupported, None);
        return;
    }

    hub.publish_runtime_update_status(RuntimeUpdateState::Running, None);
    let claude = crate::session_launch::resolve_claude_program();
    let outcome = tokio::process::Command::new(&claude)
        .arg("update")
        .output()
        .await;
    match outcome {
        Ok(out) if out.status.success() => {
            hub.publish_runtime_update_status(RuntimeUpdateState::Done, None);
        }
        Ok(out) => {
            let detail = failure_detail(&String::from_utf8_lossy(&out.stderr));
            hub.publish_runtime_update_status(RuntimeUpdateState::Failed, detail);
        }
        Err(err) => {
            hub.publish_runtime_update_status(RuntimeUpdateState::Failed, Some(err.to_string()));
        }
    }
    hub.publish_runtime_info(crate::runtime_info::gather().await);
}

/// The last 500 chars of stderr as the failure detail, or None when it is blank.
fn failure_detail(stderr: &str) -> Option<String> {
    let trimmed = stderr.trim();
    if trimmed.is_empty() {
        return None;
    }
    let tail: String = trimmed.chars().rev().take(500).collect::<Vec<_>>().into_iter().rev().collect();
    Some(tail)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failure_detail_is_none_when_blank_and_tails_long_output() {
        assert_eq!(failure_detail("   \n"), None);
        assert_eq!(failure_detail("boom"), Some("boom".to_string()));
        let long = "x".repeat(600);
        assert_eq!(failure_detail(&long).unwrap().len(), 500);
    }
}
