import type { CockpitTerminalInfo } from "@zashiki/shared";
import { useCallback, useEffect, useRef, useState } from "react";

import type { CockpitTerminalsApi } from "../api/cockpit-terminals.js";
import { dashboardDayKey } from "../lib/dashboard.js";
import {
  type IdleTerminals,
  idleTerminals,
  loadIdleWarningShownDay,
  saveIdleWarningShownDay,
} from "../lib/idle-terminal-warning.js";
import { useWakeEvent } from "./useWakeEvent.js";

type StoragePart = Pick<Storage, "getItem" | "setItem">;

/** How often a cockpit left open is checked, so a day can turn over without a relaunch or wake. */
export const IDLE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export interface IdleTerminalWarning {
  /** The terminals to warn about, or null while the warning is not up. */
  idle: IdleTerminals | null;
  dismiss(): void;
}

/**
 * Warns at most once per local day about Cockpit Terminals left without input or output, checking at
 * launch (once the terminal list has arrived), on wake from sleep, and hourly. The day is spent only
 * when there is something to show. While `blocked`, no check runs and the launch check waits.
 */
export function useIdleTerminalWarning(
  api: CockpitTerminalsApi | undefined,
  storage: StoragePart | null,
  cockpitTerminals: CockpitTerminalInfo[],
  blocked = false,
  now: () => Date = () => new Date(),
): IdleTerminalWarning {
  const [idle, setIdle] = useState<IdleTerminals | null>(null);
  const terminalsRef = useRef(cockpitTerminals);
  terminalsRef.current = cockpitTerminals;
  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;
  const nowRef = useRef(now);
  nowRef.current = now;
  const pendingCheck = useRef<AbortController | null>(null);
  const launchHandled = useRef(false);

  const check = useCallback((): void => {
    if (api === undefined || blockedRef.current) return;
    const today = dashboardDayKey(nowRef.current());
    if (loadIdleWarningShownDay(storage) === today) return;
    pendingCheck.current?.abort();
    const pending = new AbortController();
    pendingCheck.current = pending;
    void api.lastActivity(pending.signal).then(
      (response) => {
        if (pending.signal.aborted || blockedRef.current) return;
        const listed = new Set(
          terminalsRef.current.map((t) => t.cockpitTerminalId),
        );
        const found = [
          ...idleTerminals(response, nowRef.current().getTime()),
        ].filter(([id]) => listed.has(id));
        if (found.length === 0) return;
        saveIdleWarningShownDay(storage, today);
        setIdle(new Map(found));
      },
      () => undefined,
    );
  }, [api, storage]);

  const hasTerminals = cockpitTerminals.length > 0;
  useEffect(() => {
    if (!hasTerminals || blocked || launchHandled.current) return;
    launchHandled.current = true;
    check();
  }, [hasTerminals, blocked, check]);

  useWakeEvent(check);

  useEffect(() => {
    const timer = window.setInterval(check, IDLE_CHECK_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      pendingCheck.current?.abort();
    };
  }, [check]);

  const dismiss = useCallback(() => setIdle(null), []);
  return { idle, dismiss };
}
