use tauri::menu::{Menu, MenuEvent, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Runtime};

const UNDO_ITEM_ID: &str = "edit-undo";
const REDO_ITEM_ID: &str = "edit-redo";
const UNDO_EVENT: &str = "zashiki:edit-undo";
const REDO_EVENT: &str = "zashiki:edit-redo";

/// Tauri's default menu, with the Edit submenu's Undo and Redo swapped for items of our own.
///
/// macOS gives the menu the keystroke first: the predefined items carry ⌘Z / ⇧⌘Z whatever
/// accelerator they are given, so the WebView never sees the key, and the native action they run
/// instead has no view of an in-page editor's history — which left the Memo and the clipboard editor
/// unable to undo (#420). Items of our own take the same shortcuts and forward them to the page,
/// where `useEditMenuHistory` applies them to whichever editor holds the caret.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &MenuItem::with_id(app, UNDO_ITEM_ID, "Undo", true, Some("CmdOrCtrl+Z"))?,
            &MenuItem::with_id(app, REDO_ITEM_ID, "Redo", true, Some("Shift+CmdOrCtrl+Z"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    match edit_submenu_position(&menu)? {
        Some(position) => {
            menu.remove_at(position)?;
            menu.insert(&edit, position)?;
        }
        None => menu.append(&edit)?,
    }
    Ok(menu)
}

/// Where the default Edit submenu sits, so the replacement keeps its place in the menu bar.
fn edit_submenu_position<R: Runtime>(menu: &Menu<R>) -> tauri::Result<Option<usize>> {
    for (position, item) in menu.items()?.iter().enumerate() {
        if let MenuItemKind::Submenu(submenu) = item {
            if submenu.text()? == "Edit" {
                return Ok(Some(position));
            }
        }
    }
    Ok(None)
}

/// Hands the two forwarded commands to the page. Every other item is the platform's own to run.
pub fn on_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let Some(forwarded) = forwarded_event(event.id().as_ref()) else {
        return;
    };
    if let Err(e) = app.emit(forwarded, ()) {
        eprintln!("zashiki: {forwarded} の送信に失敗しました: {e}");
    }
}

fn forwarded_event(item_id: &str) -> Option<&'static str> {
    match item_id {
        UNDO_ITEM_ID => Some(UNDO_EVENT),
        REDO_ITEM_ID => Some(REDO_EVENT),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_two_replaced_items_are_forwarded() {
        assert_eq!(forwarded_event(UNDO_ITEM_ID), Some(UNDO_EVENT));
        assert_eq!(forwarded_event(REDO_ITEM_ID), Some(REDO_EVENT));
        assert_eq!(forwarded_event("quit"), None);
    }

    /// The forwarded commands only arrive if both sides spell the event the same way, and nothing at
    /// build time pins them together: a rename here reads in the app as a menu entry that quietly
    /// does nothing.
    #[test]
    fn the_page_listens_for_the_events_this_menu_sends() {
        let hook = include_str!("../../../../packages/client/src/ui/useEditMenuHistory.ts");

        for event in [UNDO_EVENT, REDO_EVENT] {
            assert!(hook.contains(event), "useEditMenuHistory must listen for {event}");
        }
    }
}
