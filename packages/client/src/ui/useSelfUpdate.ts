import type { ClientMessage, ServerMessage } from "@zashiki/shared";
import { useCallback, useEffect, useState } from "react";

interface ControlLike {
  send(msg: ClientMessage): boolean;
  onMessage(fn: (m: ServerMessage) => void): () => void;
}

export interface SelfUpdate {
  /** True while brew runs or the app is about to relaunch (button shows a spinner and is disabled). */
  updating: boolean;
  /** Send update.perform (optimistically enters the updating state until the server reports back). */
  perform(): void;
}

/**
 * Drives the header Update button's self-update. Sends `update.perform` and tracks `update.status`:
 * running/relaunching keep the spinner; opened/failed stop it and flash a toast (releases page opened
 * / failure detail).
 */
export function useSelfUpdate(
  control: ControlLike,
  flashToast: (message: string) => void,
  t: (key: string, opts?: Record<string, unknown>) => string,
): SelfUpdate {
  const [updating, setUpdating] = useState(false);

  useEffect(
    () =>
      control.onMessage((m) => {
        if (m.t !== "update.status") return;
        if (m.state === "running" || m.state === "relaunching") {
          setUpdating(true);
          return;
        }
        setUpdating(false);
        if (m.state === "opened") flashToast(t("update.opened"));
        else if (m.state === "failed") flashToast(t("update.failed"));
      }),
    [control, flashToast, t],
  );

  const perform = useCallback(() => {
    if (control.send({ t: "update.perform" })) setUpdating(true);
  }, [control]);

  return { updating, perform };
}
