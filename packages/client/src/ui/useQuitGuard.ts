import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef } from "react";

/**
 * Bridges the Tauri shell's quit-time Memo guard. The native quit path calls `app.exit` directly, so
 * the WebView's own `beforeunload` never fires there; instead the shell asks over events. On
 * `zashiki:memo-check` this reports whether the Memo has unsaved edits (so the shell shows the
 * Save/Don't Save/Cancel dialog only when needed); on `zashiki:memo-save` it flushes the Memo to disk
 * and reports whether the save landed (`ok`) so the shell exits on success but stays open on failure
 * rather than dropping the edits. No-op outside Tauri.
 *
 * `isDirty` / `flush` are read through refs so the event subscription is set up once and always sees
 * the live Memo state rather than a stale render-time closure.
 */
export function useQuitGuard(
  isDirty: () => boolean,
  flush: () => Promise<void>,
): void {
  const isDirtyRef = useRef(isDirty);
  const flushRef = useRef(flush);
  isDirtyRef.current = isDirty;
  flushRef.current = flush;

  useEffect(() => {
    if (!isTauri()) return;
    const subscriptions = Promise.all([
      listen("zashiki:memo-check", () => {
        void invoke("report_memo_status", {
          dirty: isDirtyRef.current(),
        }).catch(() => {});
      }),
      listen("zashiki:memo-save", async () => {
        let ok = true;
        try {
          await flushRef.current();
        } catch {
          ok = false;
        }
        void invoke("report_memo_saved", { ok }).catch(() => {});
      }),
    ]);
    return () => {
      void subscriptions.then((unlisten) => {
        for (const off of unlisten) off();
      });
    };
  }, []);
}
