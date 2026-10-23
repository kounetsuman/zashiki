import type { SearchAddon } from "@xterm/addon-search";
import type { Terminal } from "@xterm/xterm";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CLAUDE_EXIT_REPLAY_GAP_MS,
  type ExitKey,
} from "../lib/claude-exit-guard.js";
import { ClipboardEditModal } from "./ClipboardEditModal.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { TerminalFindBar } from "./TerminalFindBar.js";
import { DEFAULT_TERMINAL_FONT_SIZE } from "./terminal-font-size.js";
import { useTerminalFind } from "./useTerminalFind.js";
import { useXtermTerminal } from "./useXtermTerminal.js";
import {
  DEFAULT_XTERM_RENDERER,
  type XtermRenderer,
} from "./xterm-renderer.js";

export interface TerminalViewSession {
  start(cols: number, rows: number): void;
  input(data: string): void;
  resize(cols: number, rows: number): void;
  notifyWritten(chars: number): void;
  onData(fn: (data: string) => void): () => void;
}

/**
 * xterm.js terminal view.
 *
 * - Scrolling natively traverses the scrollback owned by xterm (the wheel is
 *   unaffected by mouseEventsRequireAlt). Scrolling inside a TUI (alternate screen)
 *   is handled by the TUI itself.
 * - Selection uses ordinary drag without modifiers (mouseEventsRequireAlt; even during
 *   mouse tracking, native selection kicks in when Alt is not held) + auto-copy on selection.
 *   Alt-drag performs TUI mouse operations. Right-click selects a word.
 * - The session's lifetime is managed by the caller (on unmount, only xterm is disposed).
 *
 * The xterm lifecycle lives in useXtermTerminal, the in-session find in useTerminalFind, and the
 * keydown policy in handleTerminalKey (all covered by unit tests).
 */
export function TerminalView({
  session,
  focusNonce = 0,
  resizeNonce = 0,
  fontSize = DEFAULT_TERMINAL_FONT_SIZE,
  renderer = DEFAULT_XTERM_RENDERER,
  clipboardEditEnabled = true,
  onSetClipboardEditEnabled,
  claudeRunning = false,
}: {
  session: TerminalViewSession;
  /**
   * Terminal font size in px. Owned by the app (persisted in localStorage) and applied live:
   * changing it updates the running xterm instance and re-fits so cols/rows track the new cell size.
   */
  fontSize?: number;
  /** xterm renderer, switched live from the Settings Developer mode without rebuilding the terminal. */
  renderer?: XtermRenderer;
  /**
   * Request counter for focusing the terminal. Each time it increments, calls term.focus
   * (not on initial mount or when unchanged). app-store advances it when a new session is created.
   */
  focusNonce?: number;
  /**
   * Request counter for re-asserting on window/tab switches. Each time it increments,
   * force-resends a resize at the current view's actual size (unlike applySize's no-op
   * suppression, it sends even when the size is unchanged).
   * A window switch only does select-window and does not resize the pty, and when the
   * `window-size latest` shared window is taken over by another window/client, the RO does not
   * fire because pixels are unchanged, so we reclaim it here.
   */
  resizeNonce?: number;
  /** Whether a multi-line Cmd+C opens the clipboard-edit modal. */
  clipboardEditEnabled?: boolean;
  onSetClipboardEditEnabled?(enabled: boolean): void;
  /** Whether a Claude Session runs in this terminal; only then does a double Ctrl+C / Ctrl+D ask first. */
  claudeRunning?: boolean;
}) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const [clipEdit, setClipEdit] = useState<{ open: boolean; text: string }>({
    open: false,
    text: "",
  });

  const find = useTerminalFind(termRef, searchRef);

  const openClipboardEdit = useCallback((text: string): void => {
    setClipEdit({ open: true, text });
  }, []);

  const [pendingExitKey, setPendingExitKey] = useState<ExitKey | null>(null);

  const closeExitConfirm = (): void => {
    setPendingExitKey(null);
    termRef.current?.focus();
  };

  const confirmExit = (key: ExitKey): void => {
    closeExitConfirm();
    session.input(key);
    setTimeout(() => session.input(key), CLAUDE_EXIT_REPLAY_GAP_MS);
  };

  useXtermTerminal({
    session,
    containerRef,
    termRef,
    searchRef,
    fontSize,
    renderer,
    focusNonce,
    resizeNonce,
    clipboardEditEnabled,
    claudeRunning,
    toggleFind: find.toggleFind,
    openClipboardEdit,
    confirmClaudeExit: setPendingExitKey,
    resetFind: find.reset,
    setFindResults: find.setResults,
  });

  return (
    <>
      {find.open && (
        <TerminalFindBar
          query={find.query}
          results={find.results}
          onQueryChange={find.onQueryChange}
          onNext={() => find.runSearch(find.query, "next")}
          onPrevious={() => find.runSearch(find.query, "previous")}
          onClose={find.closeFind}
        />
      )}
      <div ref={containerRef} className="terminal-view" />
      {clipEdit.open && (
        <ClipboardEditModal
          text={clipEdit.text}
          enabled={clipboardEditEnabled}
          onSetEnabled={(v) => onSetClipboardEditEnabled?.(v)}
          onClose={() => {
            setClipEdit({ open: false, text: "" });
            termRef.current?.focus();
          }}
        />
      )}
      {pendingExitKey !== null && (
        <ConfirmDialog
          title={t("terminal.exitClaudeConfirm.title")}
          message={t(
            pendingExitKey === "\x03"
              ? "terminal.exitClaudeConfirm.messageCtrlC"
              : "terminal.exitClaudeConfirm.messageCtrlD",
          )}
          confirmLabel={t("terminal.exitClaudeConfirm.confirm")}
          onConfirm={() => confirmExit(pendingExitKey)}
          onCancel={closeExitConfirm}
        />
      )}
    </>
  );
}
