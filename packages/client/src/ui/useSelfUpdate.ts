import type { ClientMessage, ServerMessage } from "@zashiki/shared";
import { useCallback, useEffect, useState } from "react";

interface ControlLike {
  send(msg: ClientMessage): boolean;
  onMessage(fn: (m: ServerMessage) => void): () => void;
}

export interface SelfUpdate {
  /** True while the flush or install runs (button shows a spinner and is disabled). */
  updating: boolean;
  /** Flush unsaved edits, then send update.perform (a failed or timed-out flush aborts). */
  perform(): void;
}

/** Bounds the pre-update flush so a hung save cannot wedge the Update button forever. */
export const FLUSH_TIMEOUT_MS = 10_000;

function withTimeout(work: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    work.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function errorDetail(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Drives the header Update button's self-update. `perform` awaits `flushUnsaved` before sending
 * `update.perform` — the update helper SIGTERMs the app, so unflushed edits would die with it.
 * Every client also flushes when an update starts anywhere (`update.status` running/relaunching
 * is broadcast), covering buffers on connections other than the one whose button was clicked.
 * `updating` is true while the server reports an update in progress or the local attempt is in
 * flight, so aborting the local attempt cannot hide another client's running update.
 */
export function useSelfUpdate(
  control: ControlLike,
  flashToast: (message: string) => void,
  t: (key: string, opts?: Record<string, unknown>) => string,
  flushUnsaved: () => Promise<void>,
): SelfUpdate {
  const [serverUpdating, setServerUpdating] = useState(false);
  const [performing, setPerforming] = useState(false);

  useEffect(
    () =>
      control.onMessage((m) => {
        if (m.t !== "update.status") return;
        if (m.state === "running" || m.state === "relaunching") {
          // Best-effort drain: the SIGTERM tears down every client, not just the initiator.
          void flushUnsaved().catch(() => {});
          setServerUpdating(true);
          return;
        }
        setServerUpdating(false);
        setPerforming(false);
        if (m.state === "opened") flashToast(t("update.opened"));
        else if (m.state === "failed") flashToast(t("update.failed"));
      }),
    [control, flashToast, t, flushUnsaved],
  );

  const perform = useCallback(async (): Promise<void> => {
    setPerforming(true);
    try {
      await withTimeout(flushUnsaved(), FLUSH_TIMEOUT_MS);
    } catch (e) {
      setPerforming(false);
      flashToast(t("update.saveFailed", { error: errorDetail(e) }));
      return;
    }
    // Re-asserted after the send: a stale update.status arriving mid-flush may have cleared it.
    if (control.send({ t: "update.perform" })) setPerforming(true);
    else {
      setPerforming(false);
      flashToast(t("update.failed"));
    }
  }, [control, flushUnsaved, flashToast, t]);

  return { updating: serverUpdating || performing, perform };
}
