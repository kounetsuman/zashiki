import { useCallback, useEffect, useState } from "react";
import type { CrashApi } from "../api/crash.js";

export interface CrashReport {
  /** The previous run's crash log to surface on launch (null when there is none). */
  crashLog: string | null;
  /** False until the launch check has answered, so another launch surface can order after it. */
  crashChecked: boolean;
  dismissCrash(): void;
}

/** Surfaces the previous run's crash log on launch and acknowledges it on dismiss. */
export function useCrashReport(crashApi: CrashApi | undefined): CrashReport {
  const [crashLog, setCrashLog] = useState<string | null>(null);
  const [crashChecked, setCrashChecked] = useState(false);

  useEffect(() => {
    if (crashApi === undefined) {
      setCrashChecked(true);
      return;
    }
    let cancelled = false;
    crashApi.last().then(
      (log) => {
        if (cancelled) return;
        if (log !== null) setCrashLog(log);
        setCrashChecked(true);
      },
      () => {
        if (!cancelled) setCrashChecked(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [crashApi]);

  const dismissCrash = useCallback((): void => {
    setCrashLog(null);
    void crashApi?.ack();
  }, [crashApi]);

  return { crashLog, crashChecked, dismissCrash };
}
