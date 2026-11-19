import { isTauri } from "@tauri-apps/api/core";
import { useEffect } from "react";

import { browserLinkOf, openInBrowser } from "../lib/browser-links.js";

/**
 * In the desktop app, sends web links that open a new window to the default browser. macOS WebKit
 * checks such a link with the window's navigation guard before it asks for the new window, and the
 * guard refuses every page outside the app, so the link would otherwise do nothing.
 */
export function useBrowserLinks(): void {
  useEffect(() => {
    if (!isTauri()) return;
    const onClick = (event: MouseEvent): void => {
      const url = browserLinkOf(event);
      if (url === null) return;
      event.preventDefault();
      void openInBrowser(url);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);
}
