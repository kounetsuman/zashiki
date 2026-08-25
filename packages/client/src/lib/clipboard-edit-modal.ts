type StoragePart = Pick<Storage, "getItem" | "setItem">;

/** localStorage key for whether the clipboard-edit modal appears on Cmd+C ("1"/"0"; default on). */
export const CLIPBOARD_EDIT_MODAL_KEY = "zk.clipboardEdit.enabled";

export function loadClipboardEditEnabled(storage: StoragePart | null): boolean {
  return storage?.getItem(CLIPBOARD_EDIT_MODAL_KEY) !== "0";
}

export function saveClipboardEditEnabled(
  storage: StoragePart | null,
  enabled: boolean,
): void {
  storage?.setItem(CLIPBOARD_EDIT_MODAL_KEY, enabled ? "1" : "0");
}

/**
 * A Cmd+C copy opens the modal only when enabled and the selection spans multiple lines. xterm's
 * getSelection() already joins soft-wrapped rows, so a newline here is a hard break worth editing
 * out (e.g. a one-liner that the source hard-wrapped at the terminal width).
 */
export function shouldOpenClipboardEditModal(
  enabled: boolean,
  selection: string,
): boolean {
  return enabled && selection.includes("\n");
}

/**
 * Removes each row's trailing spaces/tabs while preserving newlines and leading indentation: a
 * terminal-wrapped selection pads every row out to the terminal width, which is noise once rejoined.
 */
export function trimLineEndWhitespace(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n");
}
