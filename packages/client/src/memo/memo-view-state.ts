/**
 * Where the Memo editor was left: the scroll offset of its scroller and the caret/selection. The
 * editor is mounted only while the Memo tab is active, so every tab switch destroys it; the owner
 * keeps this across remounts so reopening the tab lands where the reader left off.
 */

export interface MemoViewState {
  readonly scrollTop: number;
  readonly anchor: number;
  readonly head: number;
}

function withinDoc(offset: number, docLength: number): number {
  return Math.min(Math.max(Math.trunc(offset), 0), docLength);
}

/**
 * Fits a remembered position to the document being mounted. The text can have shrunk while the tab
 * was away (a sync from another client or an on-disk edit), and CodeMirror rejects a selection past
 * the end of the doc.
 */
export function clampMemoViewState(
  state: MemoViewState,
  docLength: number,
): MemoViewState {
  return {
    scrollTop: Math.max(state.scrollTop, 0),
    anchor: withinDoc(state.anchor, docLength),
    head: withinDoc(state.head, docLength),
  };
}
