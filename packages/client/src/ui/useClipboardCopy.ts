import {
  type CockpitTerminalInfo,
  claudeSessionId,
  resumeCommand,
} from "@zashiki/shared";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";

export interface ClipboardCopy {
  copyResume(s: CockpitTerminalInfo | null | undefined): void;
  copyResumeByCockpitTerminalId(cockpitTerminalId: string): void;
  copySessionIdByCockpitTerminalId(cockpitTerminalId: string): void;
}

/**
 * Clipboard copy actions for a session's resume command and Claude Code session id. Both no-op for a
 * session without a sid (claude not started / undetectable), so callers disable the corresponding menu.
 */
export function useClipboardCopy(
  cockpitTerminals: readonly CockpitTerminalInfo[],
  flashCopyToast: (message: string) => void,
): ClipboardCopy {
  const { t } = useTranslation();

  const copyResume = useCallback(
    (s: CockpitTerminalInfo | null | undefined): void => {
      const cmd = s == null ? null : resumeCommand(s);
      if (cmd === null) return;
      void navigator.clipboard?.writeText(cmd).then(
        () => flashCopyToast(t("toast.resumeCopied")),
        () => undefined,
      );
    },
    [flashCopyToast, t],
  );

  const copyResumeByCockpitTerminalId = useCallback(
    (cockpitTerminalId: string): void => {
      copyResume(
        cockpitTerminals.find((s) => s.cockpitTerminalId === cockpitTerminalId),
      );
    },
    [copyResume, cockpitTerminals],
  );

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
    copyResume,
    copyResumeByCockpitTerminalId,
    copySessionIdByCockpitTerminalId,
  };
}
