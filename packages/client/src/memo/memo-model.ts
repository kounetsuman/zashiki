/**
 * State for the single app-wide Memo buffer (pure functions). `text` is what the editor shows;
 * `savedText` is what the server last confirmed (via memo.sync or a successful save). The two
 * differing means there are unsaved edits (the tab's dirty dot). Incoming server syncs never clobber
 * in-progress local edits — they only re-base what "saved" means.
 */

export interface MemoBuffer {
  readonly text: string;
  readonly savedText: string;
}

export const EMPTY_MEMO: MemoBuffer = { text: "", savedText: "" };

/** The form the server persists: whitespace-only text is stored as empty (the server deletes it). */
function serverForm(text: string): string {
  return text.trim() === "" ? "" : text;
}

/** Unsaved edits are pending (the editor text, as the server would store it, differs from the baseline). */
export function memoDirty(buf: MemoBuffer): boolean {
  return serverForm(buf.text) !== buf.savedText;
}

/** A local edit in the editor. Only `text` moves; `savedText` stays, so dirtiness is tracked. */
export function editMemo(buf: MemoBuffer, text: string): MemoBuffer {
  return buf.text === text ? buf : { ...buf, text };
}

/**
 * Applies a server memo.sync. When there are no local edits, the remote text is adopted wholesale;
 * when edits are pending, the local text is kept (not clobbered) and only the saved baseline moves,
 * so the buffer stays dirty against the latest server state.
 */
export function syncMemo(buf: MemoBuffer, serverText: string): MemoBuffer {
  const text = memoDirty(buf) ? buf.text : serverText;
  if (text === buf.text && serverText === buf.savedText) return buf;
  return { text, savedText: serverText };
}
