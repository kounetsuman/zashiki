import type { CockpitTerminalInfo } from "@zashiki/shared";
import { useEffect } from "react";
import { PANEL_DEFS, type PanelId } from "./panels.js";

export interface AppKeyboardShortcuts {
  sessions: readonly CockpitTerminalInfo[];
  orgs: readonly string[];
  activeSess: string | null;
  activeKey: string | null;
  handleSelectPanel(id: PanelId): void;
  toggleDebug(): void;
  newSession(org: string): void;
  copyResume(s: CockpitTerminalInfo | null | undefined): void;
  closeTabByKey(key: string): void;
}

/**
 * Wires the global keyboard shortcuts. The panel switches use Ctrl+Alt+<key> and the actions use
 * meta keys (Cmd+R/N/W), so they do not collide with each other or with the panel-local Ctrl-N/X.
 * Meta keys pass through to the browser even while the terminal is focused, so the actions work there;
 * the Ctrl+Alt switches pass through only while a text input/terminal is not being typed in.
 */
export function useAppKeyboardShortcuts({
  sessions,
  orgs,
  activeSess,
  activeKey,
  handleSelectPanel,
  toggleDebug,
  newSession,
  copyResume,
  closeTabByKey,
}: AppKeyboardShortcuts): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || !e.altKey || e.metaKey) return;
      if (document.activeElement instanceof HTMLInputElement) return;
      const def = PANEL_DEFS.find((d) => d.shortcutKey === e.key.toLowerCase());
      if (def === undefined) return;
      e.preventDefault();
      handleSelectPanel(def.id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleSelectPanel]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const active = document.activeElement;
      if (active instanceof HTMLTextAreaElement) return;
      if (
        e.ctrlKey &&
        e.altKey &&
        !e.metaKey &&
        (e.key === "d" || e.key === "D")
      ) {
        e.preventDefault();
        toggleDebug();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleDebug]);

  useEffect(() => {
    const onContextMenu = (e: MouseEvent): void => e.preventDefault();
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== "r" || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) {
        return;
      }
      e.preventDefault();
      const target =
        sessions.find((s) => s.cockpitTerminalId === activeSess) ?? null;
      copyResume(target);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sessions, activeSess, copyResume]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== "n" || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) {
        return;
      }
      const org =
        sessions.find((s) => s.cockpitTerminalId === activeSess)?.org ??
        orgs[0];
      if (org === undefined) return;
      e.preventDefault();
      newSession(org);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sessions, orgs, activeSess, newSession]);

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
