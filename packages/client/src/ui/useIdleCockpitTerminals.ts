import type { CockpitTerminalInfo } from "@zashiki/shared";
import { useCallback, useEffect, useRef, useState } from "react";

import type { CockpitTerminalsApi } from "../api/cockpit-terminals.js";
import {
  type IdleCockpitTerminals,
  idleCockpitTerminals,
} from "../lib/idle-cockpit-terminals.js";
import { useWakeEvent } from "./useWakeEvent.js";

/** How often a cockpit left open is re-checked, so a terminal can cross the threshold without a relaunch or wake. */
export const IDLE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

const NONE: IdleCockpitTerminals = new Map();

/**
 * The listed Cockpit Terminals idle past the threshold, checked at launch (once the terminal list has
 * arrived), on wake from sleep, and hourly.
 */
export function useIdleCockpitTerminals(
  api: CockpitTerminalsApi | undefined,
  cockpitTerminals: CockpitTerminalInfo[],
  now: () => Date = () => new Date(),
): IdleCockpitTerminals {
  const [idle, setIdle] = useState<IdleCockpitTerminals>(NONE);
  const terminalsRef = useRef(cockpitTerminals);
  terminalsRef.current = cockpitTerminals;
  const nowRef = useRef(now);
  nowRef.current = now;
  const pendingCheck = useRef<AbortController | null>(null);
  const launchHandled = useRef(false);

  const check = useCallback((): void => {
    if (api === undefined) return;
    pendingCheck.current?.abort();
    const pending = new AbortController();
    pendingCheck.current = pending;
    void api.lastActivity(pending.signal).then(
      (response) => {
        if (pending.signal.aborted) return;
        const listed = new Set(
          terminalsRef.current.map((t) => t.cockpitTerminalId),
        );
        setIdle(
          new Map(
            [
              ...idleCockpitTerminals(response, nowRef.current().getTime()),
            ].filter(([id]) => listed.has(id)),
          ),
        );
      },
      () => undefined,
    );
  }, [api]);

  const hasTerminals = cockpitTerminals.length > 0;
  useEffect(() => {
    if (!hasTerminals || launchHandled.current) return;
    launchHandled.current = true;
    check();
  }, [hasTerminals, check]);

  useWakeEvent(check);

  useEffect(() => {
    const timer = window.setInterval(check, IDLE_CHECK_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      pendingCheck.current?.abort();
    };
  }, [check]);

  return idle;
}
