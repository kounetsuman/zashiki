import { type MemoBuffer, memoDirty } from "./memo-model.js";

export interface MemoSaver {
  /** Persist `text`, queued after any in-flight save so an older POST never overwrites a newer one. */
  save(text: string): Promise<void>;
  /** Drain until the buffer reads clean, re-checking after every save so edits typed while a POST was in flight are saved too. */
  flush(): Promise<void>;
}

/**
 * The single ordered path for persisting the Memo (Cmd-S, the Save button, and the pre-update
 * flush all go through it). Each confirmed save reports back via `onSaved` so the dirty flag can
 * clear without waiting for the memo.sync round-trip.
 */
export function createMemoSaver(
  getMemo: () => MemoBuffer,
  post: (text: string) => Promise<void>,
  onSaved: (text: string) => void,
): MemoSaver {
  let queue: Promise<void> = Promise.resolve();

  function save(text: string): Promise<void> {
    const run = queue.then(async () => {
      await post(text);
      onSaved(text);
    });
    queue = run.catch(() => {});
    return run;
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
