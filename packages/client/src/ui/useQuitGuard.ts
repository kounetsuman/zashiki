import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";

/** Every shell request carries a number its answer has to echo back. */
interface MemoRequest {
  readonly request: number;
}

/**
 * Bridges the Tauri shell's quit-time Memo guard. The native quit path calls `app.exit` directly, so
 * the WebView's own `beforeunload` never fires there; instead the shell asks over events. On
 * `zashiki:memo-check` this reports whether the Memo has unsaved edits (so the shell shows the
 * Save/Don't Save/Cancel dialog only when needed); on `zashiki:memo-save` it flushes the Memo to disk
 * and reports whether the save landed (`ok`) so the shell exits on success but stays open on failure
 * rather than dropping the edits. No-op outside Tauri.
 *
 * Returns whether the shell is waiting on a save, which `QuitSaveOverlay` uses to block the window
 * for that long. The shell's Retry asks again while an earlier save may still be running, so this
 * counts them, and `zashiki:memo-save-abandoned` releases the block when the shell stops waiting —
 * otherwise a quit the user then cancels would leave the app covered by an overlay it can't dismiss.
 *
 * Both replies go through commands the capability has to grant; one it doesn't grant is rejected here
 * and reads on the shell side as a window that never answered, so
 * `every_ipc_command_is_granted_to_the_webview` (apps/desktop/src-tauri/src/main.rs) pins the lists
 * together. The rejection is deliberately left unhandled rather than swallowed, so a call that is
 * refused says so in the inspector instead of looking like silence.
 *
 * `isDirty` / `flush` are read through refs so the event subscription is set up once and always sees
 * the live Memo state rather than a stale render-time closure.
 */
export function useQuitGuard(
  isDirty: () => boolean,
  flush: () => Promise<void>,
): boolean {
  const [saving, setSaving] = useState(false);
  const savesAwaited = useRef(0);
  const isDirtyRef = useRef(isDirty);
  const flushRef = useRef(flush);
  // A ref, not an effect-local: under StrictMode both effect instances are briefly subscribed (the
  // unlisten is async), and a per-instance value would let them start the write this exists to share.
  const runningFlush = useRef<Promise<void> | null>(null);
  isDirtyRef.current = isDirty;
  flushRef.current = flush;

  useEffect(() => {
    if (!isTauri()) return;
    let mounted = true;

    // Retry arrives while the previous save may still be writing. Joining that write instead of
    // starting another keeps saves off each other's queue, where every extra one pushes the answer
    // further past the wait that produced the retry in the first place.
    function flushOnce(): Promise<void> {
      const running = runningFlush.current;
      if (running !== null) return running;
      const started = flushRef.current();
      runningFlush.current = started;
      void started
        .catch(() => {})
        .then(() => {
          if (runningFlush.current === started) runningFlush.current = null;
        });
      return started;
    }

    function stopBlocking(): void {
      savesAwaited.current = 0;
      if (mounted) setSaving(false);
    }

    const subscriptions = Promise.all([
      listen<MemoRequest>("zashiki:memo-check", (event) => {
        void invoke("report_memo_status", {
          request: event.payload.request,
          dirty: isDirtyRef.current(),
        });
      }),
      listen<MemoRequest>("zashiki:memo-save", async (event) => {
        savesAwaited.current += 1;
        if (mounted) setSaving(true);
        let ok = true;
        try {
          await flushOnce();
        } catch {
          ok = false;
        }
        // Clamped because the shell may already have stopped waiting and released the block; the
        // write itself is left to finish either way.
        savesAwaited.current = Math.max(0, savesAwaited.current - 1);
        if (savesAwaited.current === 0) stopBlocking();
        void invoke("report_memo_saved", {
          request: event.payload.request,
          ok,
        });
      }),
      listen("zashiki:memo-save-abandoned", stopBlocking),
    ]);
    return () => {
      mounted = false;
      void subscriptions.then((unlisten) => {
        for (const off of unlisten) off();
      });
    };
  }, []);

  return saving;
}
