type StoragePart = Pick<Storage, "getItem" | "setItem">;

/** localStorage key for whether the Viewer wraps long lines ("1"/"0"; default unwrapped). */
export const VIEWER_LINE_WRAP_KEY = "zk.viewer.lineWrap";

export function loadViewerLineWrap(storage: StoragePart | null): boolean {
  try {
    return storage?.getItem(VIEWER_LINE_WRAP_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveViewerLineWrap(
  storage: StoragePart | null,
  wrap: boolean,
): void {
  try {
    storage?.setItem(VIEWER_LINE_WRAP_KEY, wrap ? "1" : "0");
  } catch {
    // ignore (private mode / quota); the in-memory choice still holds this session.
  }
}
