import { useCallback, useEffect, useRef, useState } from "react";
import type { PopOutApi, ScreenPoint } from "../lib/pop-out.js";

export interface PoppedOut {
  /** The Cockpit Terminals shown in their own window. */
  ids: ReadonlySet<string>;
  popOut(
    cockpitTerminalId: string,
    title: string,
    at: ScreenPoint | null,
  ): void;
  /** Brings the terminal's window to the front. */
  show(cockpitTerminalId: string): void;
  /** Closes the terminal's window, which brings the terminal back to the main window. */
  returnToMain(cockpitTerminalId: string): void;
}

const NONE: ReadonlySet<string> = new Set();

function warn(action: string): (e: unknown) => void {
  return (e) => console.warn(`could not ${action} the pop-out window`, e);
}

/**
 * Tracks which Cockpit Terminals are popped out. The desktop shell owns the windows: the set is
 * read from it on load (the windows outlive a reload of the main page) and shrinks when it reports
 * one closed, whichever way that window was closed. `onReturned` hears each terminal that came back.
 */
export function usePoppedOut(
  api: PopOutApi | undefined,
  onReturned: (cockpitTerminalId: string) => void,
): PoppedOut {
  const [ids, setIds] = useState<ReadonlySet<string>>(NONE);
  const onReturnedRef = useRef(onReturned);
  onReturnedRef.current = onReturned;

  useEffect(() => {
    if (api === undefined) return;
    let live = true;
    api.list().then((open) => {
      if (live) setIds(new Set(open));
    }, warn("list"));
    const off = api.onClosed((cockpitTerminalId) => {
      setIds((prev) => {
        if (!prev.has(cockpitTerminalId)) return prev;
        const next = new Set(prev);
        next.delete(cockpitTerminalId);
        return next;
      });
      onReturnedRef.current(cockpitTerminalId);
    });
    return () => {
      live = false;
      off();
    };
  }, [api]);

  const popOut = useCallback(
    (cockpitTerminalId: string, title: string, at: ScreenPoint | null) => {
      if (api === undefined) return;
      api
        .open(cockpitTerminalId, title, at)
        .then(
          () => setIds((prev) => new Set(prev).add(cockpitTerminalId)),
          warn("open"),
        );
    },
    [api],
  );

  const show = useCallback(
    (cockpitTerminalId: string) => {
      api?.focus(cockpitTerminalId).catch(warn("focus"));
    },
    [api],
  );

  const returnToMain = useCallback(
    (cockpitTerminalId: string) => {
      api?.close(cockpitTerminalId).catch(warn("close"));
    },
    [api],
  );

  return { ids, popOut, show, returnToMain };
}
