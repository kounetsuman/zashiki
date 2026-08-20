import type { SessionInfo } from "@zashiki/shared";
import { useEffect, useState } from "react";

export interface ConfirmClose {
  /** windowId awaiting inline close confirmation (null when none). */
  confirmingClose: string | null;
  requestClose(windowId: string): void;
  confirmClose(windowId: string): void;
  cancelClose(): void;
}

/**
 * Inline close confirmation (window.confirm is unresponsive in the Tauri WKWebView). The pending
 * target clears when the session disappears via another client/CLI or a refresh.
 */
export function useConfirmClose(
  sessions: SessionInfo[],
  onClose: (windowId: string) => void,
): ConfirmClose {
  const [confirmingClose, setConfirmingClose] = useState<string | null>(null);

  useEffect(() => {
    if (confirmingClose === null) return;
    if (!sessions.some((s) => s.windowId === confirmingClose))
      setConfirmingClose(null);
  }, [sessions, confirmingClose]);

  const confirmClose = (windowId: string): void => {
    setConfirmingClose(null);
    onClose(windowId);
  };

  return {
    confirmingClose,
    requestClose: (windowId: string) => setConfirmingClose(windowId),
    confirmClose,
    cancelClose: () => setConfirmingClose(null),
  };
}
