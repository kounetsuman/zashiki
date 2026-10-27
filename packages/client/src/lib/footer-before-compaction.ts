type StoragePart = Pick<Storage, "getItem" | "setItem">;

/** localStorage key for whether the footer shows the totals from before the last compaction ("1"/"0"; default closed). */
export const FOOTER_BEFORE_COMPACTION_OPEN_KEY =
  "zk.footer.beforeCompaction.open";

export function loadFooterBeforeCompactionOpen(
  storage: StoragePart | null,
): boolean {
  return storage?.getItem(FOOTER_BEFORE_COMPACTION_OPEN_KEY) === "1";
}

export function saveFooterBeforeCompactionOpen(
  storage: StoragePart | null,
  open: boolean,
): void {
  try {
    storage?.setItem(FOOTER_BEFORE_COMPACTION_OPEN_KEY, open ? "1" : "0");
  } catch {
    // ignore (private mode / quota); the in-memory choice still holds this session.
  }
}
