type StoragePart = Pick<Storage, "getItem" | "setItem">;

/** Persistence key for seen notification ids (input to the unread badge count). */
export const NOTIFICATIONS_SEEN_KEY = "zk.notifications.seen";

/** Reads the seen notification ids, tolerating absent/corrupt storage by returning an empty list. */
export function loadSeenIds(storage: StoragePart | null): string[] {
  if (storage === null) return [];
  try {
    const raw = storage.getItem(NOTIFICATIONS_SEEN_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

export function saveSeenIds(
  storage: StoragePart | null,
  ids: readonly string[],
): void {
  storage?.setItem(NOTIFICATIONS_SEEN_KEY, JSON.stringify(ids));
}
