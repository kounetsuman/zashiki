import type { BackgroundTask } from "@zashiki/shared";
import { useEffect, useRef, useState } from "react";

import type { CockpitTerminalsApi } from "../api/cockpit-terminals.js";

export const BACKGROUND_TASKS_POLL_MS = 5_000;

export interface BackgroundTasksSnapshot {
  tasks: BackgroundTask[];
  /** When the tasks were fetched (epoch ms); ages are measured from here. */
  fetchedAt: number;
}

const EMPTY: BackgroundTasksSnapshot = { tasks: [], fetchedAt: 0 };

/**
 * Every Cockpit Terminal's background tasks, fetched on mount and again a poll interval after each
 * fetch settles. A failed poll keeps the last tasks shown.
 */
export function useBackgroundTasks(
  api: Pick<CockpitTerminalsApi, "backgroundTasks"> | undefined,
  now: () => number = Date.now,
): BackgroundTasksSnapshot {
  const [snapshot, setSnapshot] = useState(EMPTY);
  const nowRef = useRef(now);
  nowRef.current = now;

  useEffect(() => {
    if (api === undefined) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const fresh = await api
        .backgroundTasks(controller.signal)
        .catch(() => null);
      if (controller.signal.aborted) return;
      if (fresh !== null)
        setSnapshot({ tasks: fresh, fetchedAt: nowRef.current() });
      timer = setTimeout(poll, BACKGROUND_TASKS_POLL_MS);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [api]);

  return snapshot;
}
