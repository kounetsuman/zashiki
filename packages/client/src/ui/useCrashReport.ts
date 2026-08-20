import { useCallback, useEffect, useState } from "react";
import type { CrashApi } from "../api/crash.js";

export interface CrashReport {
  /** The previous run's crash log to surface on launch (null when there is none). */
  crashLog: string | null;
  dismissCrash(): void;
}

/** Surfaces the previous run's crash log on launch and acknowledges it on dismiss. */
export function useCrashReport(crashApi: CrashApi | undefined): CrashReport {
  const [crashLog, setCrashLog] = useState<string | null>(null);

  useEffect(() => {
    if (crashApi === undefined) return;
    let cancelled = false;
    crashApi.last().then(
      (log) => {
        if (!cancelled && log !== null) setCrashLog(log);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [crashApi]);

  const dismissCrash = useCallback((): void => {
    setCrashLog(null);
    void crashApi?.ack();
  }, [crashApi]);

  return { crashLog, dismissCrash };
}
