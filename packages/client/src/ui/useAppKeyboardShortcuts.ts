import type { CockpitTerminalInfo } from "@zashiki/shared";
import { useEffect } from "react";
import { VIEW_DEFS, type ViewId } from "./views.js";

export interface AppKeyboardShortcuts {
  cockpitTerminals: readonly CockpitTerminalInfo[];
  orgs: readonly string[];
  activeSess: string | null;
  activeKey: string | null;
  handleSelectView(id: ViewId): void;
  toggleHelp(): void;
  toggleSettings(): void;
  newSession(org: string): void;
  duplicateSession(cockpitTerminalId: string): void;
  closeTabByKey(key: string): void;
}

/**
 * Wires the global keyboard shortcuts. The view switches use Ctrl+Alt+<key> and the actions use
 * meta keys (Cmd+B/R/N/W), so they do not collide with each other or with the view-local Ctrl-N/X.
 * Meta keys pass through to the browser even while the terminal is focused, so the actions work there;
 * the Ctrl+Alt switches pass through only while a text input/terminal is not being typed in.
 */
export function useAppKeyboardShortcuts({
  cockpitTerminals,
  orgs,
  activeSess,
  activeKey,
  handleSelectView,
  toggleHelp,
  toggleSettings,
  newSession,
  duplicateSession,
  closeTabByKey,
}: AppKeyboardShortcuts): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || !e.altKey || e.metaKey) return;
      if (document.activeElement instanceof HTMLInputElement) return;
      if (e.key.toLowerCase() === "h") {
        e.preventDefault();
        toggleHelp();
        return;
      }
      if (e.key.toLowerCase() === "s") {
        e.preventDefault();
        toggleSettings();
        return;
      }
      const def = VIEW_DEFS.find((d) => d.shortcutKey === e.key.toLowerCase());
      if (def === undefined) return;
      e.preventDefault();
      handleSelectView(def.id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleSelectView, toggleHelp, toggleSettings]);

  useEffect(() => {
    const onContextMenu = (e: MouseEvent): void => e.preventDefault();
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== "b" || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) {
        return;
      }
      e.preventDefault();
      handleSelectView("explorer");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleSelectView]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== "r" || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) {
        return;
      }
      e.preventDefault();
      if (activeSess !== null) duplicateSession(activeSess);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeSess, duplicateSession]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== "n" || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) {
        return;
      }
      const org =
        cockpitTerminals.find((s) => s.cockpitTerminalId === activeSess)?.org ??
        orgs[0];
      if (org === undefined) return;
      e.preventDefault();
      newSession(org);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cockpitTerminals, orgs, activeSess, newSession]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== "w" || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) {
        return;
      }
      if (activeKey === null) return;
      e.preventDefault();
      closeTabByKey(activeKey);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeKey, closeTabByKey]);
}
