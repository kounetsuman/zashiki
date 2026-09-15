import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";

import { runEditorHistory } from "./editor-history.js";

/**
 * Bridges the shell's Edit > Undo / Redo. On macOS the menu takes ⌘Z / ⇧⌘Z before the WebView sees
 * the keystroke, so the shell forwards both commands as events
 * (apps/desktop/src-tauri/src/menu.rs) and they are applied here to the editor holding the caret.
 * No-op in a browser, where the keys reach CodeMirror's own bindings directly.
 */
export function useEditMenuHistory(): void {
  useEffect(() => {
    if (!isTauri()) return;
    const subscriptions = Promise.all([
      listen("zashiki:edit-undo", () => {
        runEditorHistory(document.activeElement, "undo");
      }),
      listen("zashiki:edit-redo", () => {
        runEditorHistory(document.activeElement, "redo");
      }),
    ]);
    return () => {
      void subscriptions.then((unlisten) => {
        for (const off of unlisten) off();
      });
    };
  }, []);
}
