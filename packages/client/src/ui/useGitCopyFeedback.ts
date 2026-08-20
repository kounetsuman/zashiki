import { useEffect, useRef, useState } from "react";

const COPIED_POPUP_DURATION_MS = 1200;

export interface GitCopyFeedback {
  /** Row key showing the "copied!" popup (null hides it). */
  copiedKey: string | null;
  copy(text: string, rowKey: string): void;
}

/**
 * Copies text and briefly flags the target row as copied. On rapid clicks only the latest row keeps
 * the popup. Defaults to navigator.clipboard; copyText is injectable for tests.
 */
export function useGitCopyFeedback(
  setError: (error: string) => void,
  copyText?: (text: string) => Promise<void>,
): GitCopyFeedback {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copy = (text: string, rowKey: string): void => {
    const fn = copyText ?? ((t: string) => navigator.clipboard.writeText(t));
    void fn(text).then(
      () => {
        setCopiedKey(rowKey);
        if (copyTimer.current !== null) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(
          () => setCopiedKey(null),
          COPIED_POPUP_DURATION_MS,
        );
      },
      (err: unknown) => setError(String(err)),
    );
  };

  useEffect(
    () => () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    },
    [],
  );

  return { copiedKey, copy };
}
