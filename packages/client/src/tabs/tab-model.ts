/**
 * State and transitions for the main area's unified tab list (pure functions).
 * The tab list is the single source of truth for what is open, and session/viewer
 * tabs live in the same list. Identity uses a composite `kind:id` key
 * (session=cockpitTerminalId, viewer=fileKey) to avoid id collisions across kinds. When the
 * active tab drops out due to being closed or removed, the nearest surviving tab in
 * the original order is chosen deterministically (even when several vanish at once).
 */

export type TabKind = "session" | "viewer" | "diff" | "memo";

export interface Tab {
  readonly kind: TabKind;
  /** Identifier unique within a kind (session=cockpitTerminalId, viewer=fileKey, diff=diffKey, memo=fixed). */
  readonly id: string;
}

/** The single app-wide Memo tab (there is only ever one), pinned to the front when enabled. */
export const MEMO_TAB: Tab = { kind: "memo", id: "memo" };
export const MEMO_TAB_KEY = keyFor(MEMO_TAB.kind, MEMO_TAB.id);

export interface TabsState {
  readonly tabs: readonly Tab[];
  /** Composite key (`kind:id`) of the active tab. null when there are no tabs. */
  readonly activeKey: string | null;
}

export const EMPTY_TABS: TabsState = { tabs: [], activeKey: null };

/** Composite key that prevents id collisions across kinds. */
export function keyFor(kind: TabKind, id: string): string {
  return `${kind}:${id}`;
}

export function tabKey(tab: Tab): string {
  return keyFor(tab.kind, tab.id);
}

function indexOfKey(tabs: readonly Tab[], key: string | null): number {
  if (key === null) return -1;
  return tabs.findIndex((t) => tabKey(t) === key);
}

/** The active tab (null if none). */
export function activeTab(state: TabsState): Tab | null {
  const i = indexOfKey(state.tabs, state.activeKey);
  return i === -1 ? null : (state.tabs[i] ?? null);
}

/** The active session tab's cockpitTerminalId, or null otherwise (viewer/empty). */
export function activeSessionId(state: TabsState): string | null {
  const t = activeTab(state);
  return t !== null && t.kind === "session" ? t.id : null;
}

export function hasTab(state: TabsState, kind: TabKind, id: string): boolean {
  return indexOfKey(state.tabs, keyFor(kind, id)) !== -1;
}

/**
 * Returns the key of the nearest surviving tab in the original order, starting from
 * fromIndex (preferring the right, then the left). isAlive tests survival by index
 * into the original tabs. Returns null if none survive.
 */
function neighborKey(
  tabs: readonly Tab[],
  fromIndex: number,
  isAlive: (index: number) => boolean,
): string | null {
  for (let i = fromIndex + 1; i < tabs.length; i++) {
    const t = tabs[i];
    if (t !== undefined && isAlive(i)) return tabKey(t);
  }
  for (let i = fromIndex - 1; i >= 0; i--) {
    const t = tabs[i];
    if (t !== undefined && isAlive(i)) return tabKey(t);
  }
  return null;
}

/** Opens a tab. If it exists, keep its order; otherwise append it. Always make it active. */
export function openTab(state: TabsState, tab: Tab): TabsState {
  const key = tabKey(tab);
  if (indexOfKey(state.tabs, key) !== -1) {
    return state.activeKey === key ? state : { ...state, activeKey: key };
  }
  return { tabs: [...state.tabs, tab], activeKey: key };
}

/** Makes the given tab active. A nonexistent key is a no-op (state unchanged). */
export function activateTab(state: TabsState, key: string): TabsState {
  if (indexOfKey(state.tabs, key) === -1) return state;
  return state.activeKey === key ? state : { ...state, activeKey: key };
}

/**
 * Closes a tab (removal only; does not kill the session). A nonexistent key is a
 * no-op. The pinned Memo tab is non-closeable (toggled via setMemoVisible instead), so
 * closing it is a no-op. If the closed tab was active, the nearest surviving tab in the
 * original order becomes the new active; if it was not active, the active tab is left as is.
 */
export function closeTab(state: TabsState, key: string): TabsState {
  if (key === MEMO_TAB_KEY) return state;
  const idx = indexOfKey(state.tabs, key);
  if (idx === -1) return state;
  const tabs = state.tabs.filter((_, i) => i !== idx);
  const activeKey =
    state.activeKey === key
      ? neighborKey(state.tabs, idx, (i) => i !== idx)
      : state.activeKey;
  return { tabs, activeKey };
}

/**
 * Removes the fromKey tab and inserts it at toKey's position (just before the drop
 * target). activeKey is identity-based, so it stays put across reordering. An
 * identical key or a nonexistent key leaves state unchanged (returns the same reference).
 */
export function moveTab(
  state: TabsState,
  fromKey: string,
  toKey: string,
): TabsState {
  // The Memo tab stays pinned at the front: it can't be dragged, nor can another tab drop before it.
  if (fromKey === MEMO_TAB_KEY || toKey === MEMO_TAB_KEY) return state;
  const from = indexOfKey(state.tabs, fromKey);
  const to = indexOfKey(state.tabs, toKey);
  if (from === -1 || to === -1 || from === to) return state;
  const tabs = [...state.tabs];
  const [moved] = tabs.splice(from, 1);
  const insertAt = tabs.findIndex((t) => tabKey(t) === toKey);
  tabs.splice(insertAt, 0, moved as Tab);
  return { ...state, tabs };
}

/**
 * Prunes session tabs against the set of live cockpitTerminalIds (viewer tabs always stay).
 * If the active tab disappears, move to the nearest surviving tab in the original
 * order. Deterministic even when several vanish at once.
 */
export function pruneSessions(
  state: TabsState,
  liveCockpitTerminalIds: readonly string[],
): TabsState {
  const live = new Set(liveCockpitTerminalIds);
  const survives = (t: Tab): boolean => t.kind !== "session" || live.has(t.id);
  const tabs = state.tabs.filter(survives);
  if (tabs.length === state.tabs.length) return state;
  const activeIdx = indexOfKey(state.tabs, state.activeKey);
  const activeSurvives =
    activeIdx !== -1 && survives(state.tabs[activeIdx] as Tab);
  const activeKey = activeSurvives
    ? state.activeKey
    : neighborKey(state.tabs, activeIdx, (i) => survives(state.tabs[i] as Tab));
  return { tabs, activeKey };
}

/**
 * Reflects the Memo setting into the tab list. When enabled, the Memo tab is pinned at the front
 * (added if absent, without stealing focus from the active tab — but it becomes active if nothing
 * else is open). When disabled, it is removed; if it was active, focus moves to the nearest
 * surviving tab. No change returns the same reference.
 */
export function setMemoVisible(state: TabsState, visible: boolean): TabsState {
  const idx = indexOfKey(state.tabs, MEMO_TAB_KEY);
  if (visible) {
    if (idx !== -1) return state;
    return {
      tabs: [MEMO_TAB, ...state.tabs],
      activeKey: state.activeKey ?? MEMO_TAB_KEY,
    };
  }
  if (idx === -1) return state;
  const tabs = state.tabs.filter((_, i) => i !== idx);
  const activeKey =
    state.activeKey === MEMO_TAB_KEY
      ? neighborKey(state.tabs, idx, (i) => i !== idx)
      : state.activeKey;
  return { tabs, activeKey };
}
