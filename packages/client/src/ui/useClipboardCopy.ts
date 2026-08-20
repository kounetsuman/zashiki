import {
  claudeSessionId,
  resumeCommand,
  type SessionInfo,
} from "@zashiki/shared";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";

export interface ClipboardCopy {
  copyResume(s: SessionInfo | null | undefined): void;
  copyResumeByWindowId(windowId: string): void;
  copySessionIdByWindowId(windowId: string): void;
}

/**
 * Clipboard copy actions for a session's resume command and Claude Code session id. Both no-op for a
 * session without a sid (claude not started / undetectable), so callers disable the corresponding menu.
 */
export function useClipboardCopy(
  sessions: readonly SessionInfo[],
  flashCopyToast: (message: string) => void,
): ClipboardCopy {
  const { t } = useTranslation();

  const copyResume = useCallback(
    (s: SessionInfo | null | undefined): void => {
      const cmd = s == null ? null : resumeCommand(s);
      if (cmd === null) return;
      void navigator.clipboard?.writeText(cmd).then(
        () => flashCopyToast(t("toast.resumeCopied")),
        () => undefined,
      );
    },
    [flashCopyToast, t],
  );

  const copyResumeByWindowId = useCallback(
    (windowId: string): void => {
      copyResume(sessions.find((s) => s.windowId === windowId));
    },
    [copyResume, sessions],
  );

  const copySessionIdByWindowId = useCallback(
    (windowId: string): void => {
      const s = sessions.find((x) => x.windowId === windowId);
      const sid = s == null ? null : claudeSessionId(s);
      if (sid === null) return;
      void navigator.clipboard?.writeText(sid).then(
        () => flashCopyToast(t("toast.sessionIdCopied")),
        () => undefined,
      );
    },
    [flashCopyToast, sessions, t],
  );

  return { copyResume, copyResumeByWindowId, copySessionIdByWindowId };
}
