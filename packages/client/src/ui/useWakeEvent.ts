import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";

/**
 * Calls `onWake` each time the machine wakes from sleep, as reported by the Tauri shell's
 * NSWorkspace observer. No-op outside Tauri, where no such signal exists.
 *
 * `onWake` is read through a ref so the subscription is set up once and always calls the live
 * handler rather than a stale render-time closure.
 */
export function useWakeEvent(onWake: () => void): void {
  const onWakeRef = useRef(onWake);
  onWakeRef.current = onWake;

  useEffect(() => {
    if (!isTauri()) return;
    const subscription = listen("zashiki:did-wake", () =>
      onWakeRef.current(),
    ).catch(() => undefined);
    return () => {
      void subscription.then((off) => off?.());
    };
  }, []);
}
