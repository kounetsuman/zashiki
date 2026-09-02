import { type MemoBuffer, memoDirty } from "./memo-model.js";

/**
 * Cap on a single save's round-trip. Past it the POST is aborted so a stalled request can't wedge the
 * queue (see `createMemoSaver`); the save then rejects and the next Save/Cmd-S starts a fresh request.
 */
export const MEMO_SAVE_TIMEOUT_MS = 15_000;

export interface MemoSaver {
  /** Persist `text`, queued after any in-flight save so an older POST never overwrites a newer one. */
  save(text: string): Promise<void>;
  /** Drain until the buffer reads clean, re-checking after every save so edits typed while a POST was in flight are saved too. */
  flush(): Promise<void>;
}

/**
 * The single ordered path for persisting the Memo (Cmd-S, the Save button, and the pre-update flush
 * all go through it). Each confirmed save reports back via `onSaved` so the dirty flag clears without
 * waiting for the memo.sync round-trip. Each save is bounded by `timeoutMs`: on timeout the request
 * is aborted so a stalled save rejects and the queue advances to the next save.
 */
export function createMemoSaver(
  getMemo: () => MemoBuffer,
  post: (text: string, signal: AbortSignal) => Promise<void>,
  onSaved: (text: string) => void,
  timeoutMs: number = MEMO_SAVE_TIMEOUT_MS,
): MemoSaver {
  let queue: Promise<void> = Promise.resolve();

  function save(text: string): Promise<void> {
    const run = queue.then(() => postWithTimeout(text));
    queue = run.catch(() => {});
    return run;
  }

  async function postWithTimeout(text: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await post(text, controller.signal);
      onSaved(text);
    } finally {
      clearTimeout(timer);
    }
  }

  async function flush(): Promise<void> {
    for (;;) {
      const memo = getMemo();
      if (!memoDirty(memo)) return;
      await save(memo.text);
    }
  }

  return { save, flush };
}
