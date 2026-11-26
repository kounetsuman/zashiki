import { isPinned, keyFor, type TabsState, tabKey } from "./tab-model.js";

type StoragePart = Pick<Storage, "getItem" | "setItem">;

/** localStorage key for the cockpitTerminalIds of pinned Cockpit Terminal tabs (JSON array, pin order). */
export const PINNED_SESSIONS_KEY = "zk.tabs.pinnedSessions";

const SESSION_KEY_PREFIX = keyFor("session", "");

/** The cockpitTerminalId of a session tab key, or null for any other kind. */
export function sessionIdOfKey(key: string): string | null {
  return key.startsWith(SESSION_KEY_PREFIX)
    ? key.slice(SESSION_KEY_PREFIX.length)
    : null;
}

export function loadPinnedSessions(
  storage: StoragePart | null,
): readonly string[] {
  try {
    const raw = storage?.getItem(PINNED_SESSIONS_KEY);
    if (raw === null || raw === undefined) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [
      ...new Set(
        parsed.filter((v): v is string => typeof v === "string" && v !== ""),
      ),
    ];
  } catch {
    return [];
  }
}

export function savePinnedSessions(
  storage: StoragePart | null,
  ids: readonly string[],
): void {
  try {
    storage?.setItem(PINNED_SESSIONS_KEY, JSON.stringify(ids));
  } catch {
    // ignore (private mode / quota); the pins still hold for this run.
  }
}

export function rememberPinnedSession(
  ids: readonly string[],
  id: string,
): readonly string[] {
  return ids.includes(id) ? ids : [...ids, id];
}

export function forgetPinnedSession(
  ids: readonly string[],
  id: string,
): readonly string[] {
  return ids.includes(id) ? ids.filter((v) => v !== id) : ids;
}

/** Keeps only the ids of live terminals; returns the same array when all are live. */
export function forgetEndedSessions(
  ids: readonly string[],
  liveIds: ReadonlySet<string>,
): readonly string[] {
  const kept = ids.filter((id) => liveIds.has(id));
  return kept.length === ids.length ? ids : kept;
}

/**
 * Follows the order the user arranged the open pinned terminal tabs in, while a terminal without an
 * open tab keeps its slot so it returns to the same place. Returns the same array when unchanged.
 */
export function orderPinnedSessions(
  ids: readonly string[],
  state: TabsState,
): readonly string[] {
  const remembered = new Set(ids);
  const open = state.tabs
    .filter(
      (t) =>
        t.kind === "session" &&
        remembered.has(t.id) &&
        isPinned(state, tabKey(t)),
    )
    .map((t) => t.id);
  const openSet = new Set(open);
  let nextOpen = 0;
  const next = ids.map((id) =>
    openSet.has(id) ? (open[nextOpen++] as string) : id,
  );
  return next.every((id, i) => id === ids[i]) ? ids : next;
}

/**
 * Reopens, pinned, the remembered terminals that are live: a missing tab is placed in the pinned
 * group in remembered order, and an open but unpinned one is pinned. A reopened tab becomes active
 * only when `activate` is set and nothing is active. Returns the same state when nothing changes.
 */
export function restorePinnedSessions(
  state: TabsState,
  ids: readonly string[],
  liveIds: ReadonlySet<string>,
  activate: boolean,
): TabsState {
  let next = state;
  ids.forEach((id, order) => {
    if (!liveIds.has(id)) return;
    const key = keyFor("session", id);
    if (next.pinned.has(key)) return;
    const pinned = new Set(next.pinned).add(key);
    const others = next.tabs.filter((t) => tabKey(t) !== key);
    const at = insertionIndex(next, others, ids, order);
    next = {
      tabs: [
        ...others.slice(0, at),
        { kind: "session", id },
        ...others.slice(at),
      ],
      activeKey: next.activeKey ?? (activate ? key : null),
      pinned,
    };
  });
  return next;
}

/** Before the first pinned terminal remembered later than this one, else at the pinned group's end. */
function insertionIndex(
  state: TabsState,
  others: TabsState["tabs"],
  ids: readonly string[],
  order: number,
): number {
  const later = new Set(ids.slice(order + 1));
  let end = 0;
  for (const [i, t] of others.entries()) {
    if (!isPinned(state, tabKey(t))) break;
    if (t.kind === "session" && later.has(t.id)) return i;
    end = i + 1;
  }
  return end;
}
