import { type CockpitTerminalInfo, claudeSessionId } from "@zashiki/shared";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";

export interface ClipboardCopy {
  copySessionIdByCockpitTerminalId(cockpitTerminalId: string): void;
}

/**
 * Clipboard copy action for a session's Claude Code session id. No-ops for a session without a sid
 * (claude not started / undetectable), so callers disable the corresponding menu.
 */
export function useClipboardCopy(
  cockpitTerminals: readonly CockpitTerminalInfo[],
  flashCopyToast: (message: string) => void,
): ClipboardCopy {
  const { t } = useTranslation();

  const copySessionIdByCockpitTerminalId = useCallback(
    (cockpitTerminalId: string): void => {
      const s = cockpitTerminals.find(
        (x) => x.cockpitTerminalId === cockpitTerminalId,
      );
      const sid = s == null ? null : claudeSessionId(s);
      if (sid === null) return;
      void navigator.clipboard?.writeText(sid).then(
        () => flashCopyToast(t("toast.sessionIdCopied")),
        () => undefined,
      );
    },
    [flashCopyToast, cockpitTerminals, t],
  );

  return {
    copySessionIdByCockpitTerminalId,
  };
}
