import { useCallback, useEffect, useRef, useState } from "react";

const COPY_TOAST_DURATION_MS = 1800;

export interface CopyToast {
  /** Message shown right after a copy; null hides the toast. */
  copyToast: string | null;
  flashCopyToast(message: string): void;
}

/** A transient toast shown briefly after copying to the clipboard. */
export function useCopyToast(): CopyToast {
  const [copyToast, setCopyToast] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const flashCopyToast = useCallback((message: string): void => {
    setCopyToast(message);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(
      () => setCopyToast(null),
      COPY_TOAST_DURATION_MS,
    );
  }, []);

  return { copyToast, flashCopyToast };
}
