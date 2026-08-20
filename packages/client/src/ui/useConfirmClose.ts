import type { CockpitTerminalInfo } from "@zashiki/shared";
import { useEffect, useState } from "react";

export interface ConfirmClose {
  /** cockpitTerminalId awaiting inline close confirmation (null when none). */
  confirmingClose: string | null;
  requestClose(cockpitTerminalId: string): void;
  confirmClose(cockpitTerminalId: string): void;
  cancelClose(): void;
}

/**
 * Inline close confirmation (window.confirm is unresponsive in the Tauri WKWebView). The pending
 * target clears when the session disappears via another client/CLI or a refresh.
 */
export function useConfirmClose(
  cockpitTerminals: CockpitTerminalInfo[],
  onClose: (cockpitTerminalId: string) => void,
): ConfirmClose {
  const [confirmingClose, setConfirmingClose] = useState<string | null>(null);

  useEffect(() => {
    if (confirmingClose === null) return;
    if (!cockpitTerminals.some((s) => s.cockpitTerminalId === confirmingClose))
      setConfirmingClose(null);
  }, [cockpitTerminals, confirmingClose]);

  const confirmClose = (cockpitTerminalId: string): void => {
    setConfirmingClose(null);
    onClose(cockpitTerminalId);
  };

  return {
    confirmingClose,
    requestClose: (cockpitTerminalId: string) =>
      setConfirmingClose(cockpitTerminalId),
    confirmClose,
    cancelClose: () => setConfirmingClose(null),
  };
}
