import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";

import { type PickedFile, takeOpenedFiles } from "../lib/open-file-dialog.js";

/**
 * Calls `onPicked` with the files macOS hands to the app (`open -a`, Finder's "Open With", the
 * default app), read the same way as a Cmd+O pick (up to `maxBytes`). The shell queues them, so files
 * that arrive while the page is still loading are taken once it starts listening. No-op outside Tauri.
 */
export function useOpenedFiles(
  onPicked: (picked: PickedFile[]) => void,
  onFailed: () => void,
  maxBytes: number,
): void {
  const handlers = useRef({ onPicked, onFailed, maxBytes });
  handlers.current = { onPicked, onFailed, maxBytes };

  useEffect(() => {
    if (!isTauri()) return;
    // One take at a time: each reads its files on its own thread, so overlapping takes could
    // finish out of arrival order.
    let takes = Promise.resolve();
    const take = (): void => {
      takes = takes.then(() =>
        takeOpenedFiles(handlers.current.maxBytes)
          .then(
            (picked) => {
              if (picked.length > 0) handlers.current.onPicked(picked);
            },
            () => handlers.current.onFailed(),
          )
          .catch(() => undefined),
      );
    };
    const subscription = listen("zashiki:files-opened", take).catch(() => {
      handlers.current.onFailed();
      return undefined;
    });
    void subscription.then(take);
    return () => {
      void subscription.then((off) => off?.());
    };
  }, []);
}
