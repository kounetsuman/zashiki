/**
 * State and transitions for the main area's unified tab list (pure functions).
 * The tab list is the single source of truth for what is open, and session/viewer
 * tabs live in the same list. Identity uses a composite `kind:id` key
 * (session=cockpitTerminalId, viewer=fileKey) to avoid id collisions across kinds. When the
 * active tab drops out due to being closed or removed, the nearest surviving tab in
 * the original order is chosen deterministically (even when several vanish at once).
 *
 * Pinned tabs are kept in front of unpinned tabs so a fixed strip can render them
 * without scrolling. The Memo tab is implicitly pinned (front-most, non-toggleable).
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
  /**
   * Keys of user-pinned tabs. The Memo tab is pinned implicitly (see {@link isPinned}) and is
   * never listed here. tabs is kept partitioned so every pinned tab precedes every unpinned one.
   */
  readonly pinned: ReadonlySet<string>;
}

export const EMPTY_TABS: TabsState = {
  tabs: [],
  activeKey: null,
  pinned: new Set(),
};

/** Composite key that prevents id collisions across kinds. */
export function keyFor(kind: TabKind, id: string): string {
  return `${kind}:${id}`;
}

export function tabKey(tab: Tab): string {
  return keyFor(tab.kind, tab.id);
}

/** Whether the tab is pinned: the Memo tab always is, others when the user pinned them. */
export function isPinned(state: TabsState, key: string): boolean {
  return key === MEMO_TAB_KEY || state.pinned.has(key);
}

function indexOfKey(tabs: readonly Tab[], key: string | null): number {
  if (key === null) return -1;
  return tabs.findIndex((t) => tabKey(t) === key);
}

/**
 * Stable partition placing pinned tabs before unpinned ones, keeping each group's relative order.
 * A just-pinned tab therefore lands at the pinned group's end; a just-unpinned tab at the unpinned
 * group's front.
 */
function partitionByPin(
  tabs: readonly Tab[],
  pinned: ReadonlySet<string>,
): Tab[] {
  const pin: Tab[] = [];
  const rest: Tab[] = [];
  for (const t of tabs) {
    (isPinnedKey(tabKey(t), pinned) ? pin : rest).push(t);
  }
  return [...pin, ...rest];
}

function isPinnedKey(key: string, pinned: ReadonlySet<string>): boolean {
  return key === MEMO_TAB_KEY || pinned.has(key);
}

/** Filters the pinned set by a keep predicate; returns the same set when nothing is dropped. */
function retainPinned(
  pinned: ReadonlySet<string>,
  keep: (key: string) => boolean,
): ReadonlySet<string> {
  let changed = false;
  const next = new Set<string>();
  for (const k of pinned) {
    if (keep(k)) next.add(k);
    else changed = true;
  }
  return changed ? next : pinned;
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

/**
 * Opens a tab. If it exists, keep its order; otherwise append it after the unpinned tabs
 * (a new tab is never pinned). Always make it active.
 */
export function openTab(state: TabsState, tab: Tab): TabsState {
  const key = tabKey(tab);
  if (indexOfKey(state.tabs, key) !== -1) {
    return state.activeKey === key ? state : { ...state, activeKey: key };
  }
  return { ...state, tabs: [...state.tabs, tab], activeKey: key };
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
  return {
    tabs,
    activeKey,
    pinned: retainPinned(state.pinned, (k) => k !== key),
  };
}

/**
 * Removes the fromKey tab and inserts it at toKey's position (just before the drop
 * target), then re-partitions so pinned tabs stay in front. activeKey is identity-based, so
 * it stays put across reordering. An identical key or a nonexistent key leaves state unchanged
 * (returns the same reference).
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
  return { ...state, tabs: partitionByPin(tabs, state.pinned) };
}

/**
 * Pins a tab: it joins the end of the pinned group (in front of unpinned tabs) so it survives
 * horizontal scrolling. The Memo tab is pinned implicitly and cannot be re-pinned. A nonexistent
 * or already-pinned key is a no-op (same reference).
 */
export function pinTab(state: TabsState, key: string): TabsState {
  if (key === MEMO_TAB_KEY) return state;
  if (indexOfKey(state.tabs, key) === -1) return state;
  if (state.pinned.has(key)) return state;
  const pinned = new Set(state.pinned).add(key);
  return { ...state, pinned, tabs: partitionByPin(state.tabs, pinned) };
}

/**
 * Unpins a tab: it moves to the front of the unpinned group. The Memo tab has no user pin to
 * remove. An unpinned key is a no-op (same reference).
 */
export function unpinTab(state: TabsState, key: string): TabsState {
  if (!state.pinned.has(key)) return state;
  const pinned = new Set(state.pinned);
  pinned.delete(key);
  return { ...state, pinned, tabs: partitionByPin(state.tabs, pinned) };
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
  const liveKeys = new Set(tabs.map(tabKey));
  return {
    tabs,
    activeKey,
    pinned: retainPinned(state.pinned, (k) => liveKeys.has(k)),
  };
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
      ...state,
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
  return { ...state, tabs, activeKey };
}
