//! Pop-out windows: one Cockpit Terminal shown in a window of its own. The window's label names the
//! terminal, so the shell needs no other record of which windows are open.

use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow};

const LABEL_PREFIX: &str = "popout-";

/// Told to the main window once a pop-out window has gone, however it was closed.
pub const CLOSED_EVENT: &str = "zashiki:popout-closed";

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Closed {
    pub cockpit_terminal_id: String,
}

/// Window labels allow only a few characters, and a cockpit terminal id may carry others (`@2`), so
/// the id is hex-encoded into the label.
pub fn label_for(cockpit_terminal_id: &str) -> String {
    let hex: String = cockpit_terminal_id
        .bytes()
        .map(|b| format!("{b:02x}"))
        .collect();
    format!("{LABEL_PREFIX}{hex}")
}

/// The cockpit terminal a pop-out window shows; None for any other window.
pub fn cockpit_terminal_id_of(label: &str) -> Option<String> {
    let hex = label.strip_prefix(LABEL_PREFIX)?;
    if hex.is_empty() || hex.len() % 2 != 0 {
        return None;
    }
    let bytes = (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(hex.get(i..i + 2)?, 16).ok())
        .collect::<Option<Vec<u8>>>()?;
    String::from_utf8(bytes).ok()
}

pub fn is_popout(label: &str) -> bool {
    cockpit_terminal_id_of(label).is_some()
}

pub fn find<R: Runtime>(app: &AppHandle<R>, cockpit_terminal_id: &str) -> Option<WebviewWindow<R>> {
    app.get_webview_window(&label_for(cockpit_terminal_id))
}

pub fn open_ids<R: Runtime>(app: &AppHandle<R>) -> Vec<String> {
    let mut ids: Vec<String> = app
        .webview_windows()
        .keys()
        .filter_map(|label| cockpit_terminal_id_of(label))
        .collect();
    ids.sort();
    ids
}

/// Brings a window to the front, out of the Dock if minimized. Showing a window that sits on another
/// macOS Space switches to that Space when the system allows it.
pub fn bring_to_front<R: Runtime>(window: &WebviewWindow<R>) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// Tells the main window that the pop-out of `label` has gone and, unless the app is quitting, brings
/// the main window back to the front with the terminal it now shows again.
pub fn on_destroyed<R: Runtime>(app: &AppHandle<R>, label: &str, quitting: bool) {
    let Some(cockpit_terminal_id) = cockpit_terminal_id_of(label) else {
        return;
    };
    if let Err(e) = app.emit_to(
        "main",
        CLOSED_EVENT,
        Closed {
            cockpit_terminal_id,
        },
    ) {
        eprintln!("zashiki: {CLOSED_EVENT} の送信に失敗しました: {e}");
    }
    if quitting {
        return;
    }
    if let Some(main) = app.get_webview_window("main") {
        bring_to_front(&main);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_label_round_trips_any_cockpit_terminal_id() {
        for id in ["@2", "0b6cbc45-83a9-4f2e-9c3d-1a2b3c4d5e6f", "日本語/../x"] {
            let label = label_for(id);
            assert!(
                label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'),
                "{label}"
            );
            assert_eq!(cockpit_terminal_id_of(&label).as_deref(), Some(id));
        }
    }

    #[test]
    fn other_windows_are_not_pop_outs() {
        for label in ["main", "popout-", "popout-4", "popout-zz", "popout-ff"] {
            assert!(!is_popout(label), "{label}");
        }
    }
}
