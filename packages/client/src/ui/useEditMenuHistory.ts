import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useEffect } from "react";

import { runEditorHistory } from "./editor-history.js";

/**
 * Bridges the shell's Edit > Undo / Redo. On macOS the menu takes ⌘Z / ⇧⌘Z before the WebView sees
 * the keystroke, so the shell forwards both commands as events
 * (apps/desktop/src-tauri/src/menu.rs) to the window in front, and they are applied here to the
 * editor holding the caret. No-op in a browser, where the keys reach CodeMirror's own bindings directly.
 */
export function useEditMenuHistory(): void {
  useEffect(() => {
    if (!isTauri()) return;
    // Without a target a listener hears the event sent to any window.
    const thisWindow = {
      target: { kind: "WebviewWindow", label: getCurrentWebviewWindow().label },
    } as const;
    const subscriptions = Promise.all([
      listen(
        "zashiki:edit-undo",
        () => {
          runEditorHistory(document.activeElement, "undo");
        },
        thisWindow,
      ),
      listen(
        "zashiki:edit-redo",
        () => {
          runEditorHistory(document.activeElement, "redo");
        },
        thisWindow,
      ),
    ]);
    return () => {
      void subscriptions.then((unlisten) => {
        for (const off of unlisten) off();
      });
    };
  }, []);
}
