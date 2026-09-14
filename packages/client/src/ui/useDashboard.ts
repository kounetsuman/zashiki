import type { DashboardSettings } from "@zashiki/shared";
import { useCallback, useEffect, useRef, useState } from "react";

import { type DashboardApi, DashboardReadError } from "../api/dashboard.js";
import {
  type DashboardFrame,
  type DashboardTrigger,
  dashboardDayKey,
  dashboardFailureSpendsDay,
  dashboardTarget,
  loadDashboardLastShown,
  saveDashboardLastShown,
  shouldShowDashboard,
} from "../lib/dashboard.js";
import { useWakeEvent } from "./useWakeEvent.js";

type StoragePart = Pick<Storage, "getItem" | "setItem">;

export interface DashboardState {
  /** What the overlay should draw, or null while nothing is due. */
  frame: DashboardFrame | null;
  /** Advances on every showing, so a trigger reloads a page that is already up. */
  showNonce: number;
  dismiss(): void;
}

/**
 * Puts the configured dashboard page in front of the cockpit at launch and on wake from sleep.
 * `settings` is null until the server's config.sync arrives; the launch moment is the first time it
 * does, so a later edit in SETTINGS does not count as a fresh launch. While `blocked`, nothing is
 * shown and no day is spent, and the launch showing waits rather than being lost.
 */
export function useDashboard(
  settings: DashboardSettings | null,
  api: DashboardApi | undefined,
  storage: StoragePart | null,
  blocked = false,
  now: () => Date = () => new Date(),
): DashboardState {
  const [shown, setShown] = useState<{
    frame: DashboardFrame | null;
    nonce: number;
  }>({ frame: null, nonce: 0 });
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const nowRef = useRef(now);
  nowRef.current = now;
  const launchHandled = useRef(false);
  const pendingRead = useRef<AbortController | null>(null);

  const blockedRef = useRef(blocked);
  blockedRef.current = blocked;

  const show = useCallback(
    (trigger: DashboardTrigger): void => {
      const current = settingsRef.current;
      if (current === null || blockedRef.current) return;
      const today = dashboardDayKey(nowRef.current());
      const lastShown = loadDashboardLastShown(storage);
      if (!shouldShowDashboard(current, trigger, lastShown, today)) return;
      const url = current.url.trim();
      // A read that was dismissed, or overtaken by this trigger, must not reach the screen.
      pendingRead.current?.abort();
      const alreadyToday = lastShown?.day === today && lastShown.url === url;
      const reveal = (next: DashboardFrame, spendsDay: boolean): void => {
        if (spendsDay) saveDashboardLastShown(storage, { url, day: today });
        setShown((prev) => ({ frame: next, nonce: prev.nonce + 1 }));
      };
      // A refusal the server will repeat is worth saying once a day, whatever the frequency: at
      // every_time it would otherwise re-pop on every wake for as long as the setting stays wrong.
      const revealFailure = (detail: string, status: number | null): void => {
        if (!dashboardFailureSpendsDay(status)) {
          reveal({ kind: "error", detail }, false);
          return;
        }
        if (!alreadyToday) reveal({ kind: "error", detail }, true);
      };
      const target = dashboardTarget(current.url);
      if (target.kind === "remote") {
        reveal({ kind: "remote", url: target.url }, true);
        return;
      }
      if (api === undefined) return;
      const read = new AbortController();
      pendingRead.current = read;
      void api.read(read.signal).then(
        (html) => {
          if (!read.signal.aborted) reveal({ kind: "local", html }, true);
        },
        (e: unknown) => {
          if (read.signal.aborted) return;
          revealFailure(
            e instanceof Error ? e.message : String(e),
            e instanceof DashboardReadError ? e.status : null,
          );
        },
      );
    },
    [api, storage],
  );

  useEffect(() => {
    if (settings === null || blocked || launchHandled.current) return;
    launchHandled.current = true;
    show("launch");
  }, [settings, blocked, show]);

  useWakeEvent(useCallback(() => show("wake"), [show]));

  const dismiss = useCallback(() => {
    pendingRead.current?.abort();
    setShown((prev) => ({ frame: null, nonce: prev.nonce }));
  }, []);
  return { frame: shown.frame, showNonce: shown.nonce, dismiss };
}
