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
  const keepLocal = memoDirty(buf) || serverForm(buf.text) === serverText;
  const text = keepLocal ? buf.text : serverText;
  if (text === buf.text && serverText === buf.savedText) return buf;
  return { text, savedText: serverText };
}

/**
 * Applies a locally confirmed save of `text` (its POST succeeded) by re-basing only the saved
 * baseline to the server's stored form, without waiting for the memo.sync round-trip. The editor
 * text is never touched: a stale confirmation leaves the buffer dirty so the newer text re-saves.
 */
export function confirmMemoSaved(buf: MemoBuffer, text: string): MemoBuffer {
  const savedText = serverForm(text);
  if (savedText === buf.savedText) return buf;
  return { ...buf, savedText };
}
