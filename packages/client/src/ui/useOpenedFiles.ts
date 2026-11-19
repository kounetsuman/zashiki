import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FILE_MAX_BYTES } from "@zashiki/shared";
import { useEffect, useRef } from "react";

import type { PickedFile } from "../lib/open-file-dialog.js";

/**
 * Calls `onPicked` with the files macOS hands to the app (`open -a`, Finder's "Open With", the
 * default app), read the same way as a Cmd+O pick. The shell queues them, so files that arrive while
 * the page is still loading are taken once it starts listening. Nothing is taken until `ready`:
 * a tab opened before the terminal list arrives would stop startup from opening a terminal.
 * No-op outside Tauri.
 */
export function useOpenedFiles(
  onPicked: (picked: PickedFile[]) => void,
  onFailed: () => void,
  ready: boolean,
): void {
  const handlers = useRef({ onPicked, onFailed });
  handlers.current = { onPicked, onFailed };

  useEffect(() => {
    if (!ready || !isTauri()) return;
    const take = (): void => {
      invoke<PickedFile[]>("take_opened_files", {
        maxBytes: FILE_MAX_BYTES,
      }).then(
        (picked) => {
          if (picked.length > 0) handlers.current.onPicked(picked);
        },
        () => handlers.current.onFailed(),
      );
    };
    const subscription = listen("zashiki:files-opened", take).catch(
      () => undefined,
    );
    void subscription.then(take);
    return () => {
      void subscription.then((off) => off?.());
    };
  }, [ready]);
}
