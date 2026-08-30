import type { CockpitTerminalInfo } from "@zashiki/shared";

/** Target of the right-click menu (an org area or a session row). */
export type ContextMenu =
  | { kind: "org"; org: string; x: number; y: number }
  | {
      kind: "row";
      cockpitTerminalId: string;
      name: string;
      x: number;
      y: number;
    };

/** Target of ↑↓ focus = an org header row or a session row (treated as one flat sequence). */
export type FocusTarget =
  | { kind: "org"; org: string }
  | { kind: "row"; cockpitTerminalId: string };

/** Unique key for equality checks, the visible-set key, and effect deps (the prefix separates the kind). */
export function focusKey(t: FocusTarget): string {
  return t.kind === "org" ? `o:${t.org}` : `r:${t.cockpitTerminalId}`;
}

/** Preserve the order of orgs while appending detected orgs not in orgs at the end. */
export function displayOrgs(
  orgs: string[],
  cockpitTerminals: CockpitTerminalInfo[],
): string[] {
  const result = [...orgs];
  const seen = new Set(orgs);
  for (const s of cockpitTerminals) {
    if (seen.has(s.org)) continue;
    seen.add(s.org);
    result.push(s.org);
  }
  return result;
}

/**
 * Returns `orgList` with `dragged` removed and re-inserted just before `target` (a drag-and-drop move —
 * dropping an org onto another places it immediately before that one). If either org is absent or they
 * are the same, the list is returned unchanged.
 */
export function reorderOrgs(
  orgList: string[],
  dragged: string,
  target: string,
): string[] {
  if (dragged === target) return orgList;
  const from = orgList.indexOf(dragged);
  const to = orgList.indexOf(target);
  if (from === -1 || to === -1) return orgList;
  const next = [...orgList];
  next.splice(from, 1);
  next.splice(next.indexOf(target), 0, dragged);
  return next;
}

/**
 * Chooses the org order to display: the optimistic order from the last drag while it still covers exactly
 * the same set of orgs as the server, otherwise the server order. Keying on the set (not the order) means
 * a frequent state.sync that only changes session state does not discard the drag, while adding or removing
 * an org falls back to the server — which is also the only order the server can persist for conf-backed orgs.
 */
export function reconcileOrgOrder(
  optimistic: string[] | null,
  server: string[],
): string[] {
  if (optimistic === null || optimistic.length !== server.length) return server;
  const serverSet = new Set(server);
  return optimistic.every((org) => serverSet.has(org)) ? optimistic : server;
}

/**
 * Returns the full flat cockpit-terminal id order after dropping `draggedId` just before `targetId`,
 * but only when both rows belong to the SAME org (a Cockpit Terminal's org is its cwd, so cross-org
 * moves are meaningless). Otherwise, or when the ids are equal/absent, the current id order is returned.
 * The full order is sent to the server; within-org relative order is what the poller then groups.
 */
export function reorderRowsWithinOrg(
  cockpitTerminals: CockpitTerminalInfo[],
  draggedId: string,
  targetId: string,
): string[] {
  const ids = cockpitTerminals.map((s) => s.cockpitTerminalId);
  const drag = cockpitTerminals.find((s) => s.cockpitTerminalId === draggedId);
  const target = cockpitTerminals.find((s) => s.cockpitTerminalId === targetId);
  if (
    drag === undefined ||
    target === undefined ||
    drag.org !== target.org ||
    draggedId === targetId
  ) {
    return ids;
  }
  const next = ids.filter((id) => id !== draggedId);
  next.splice(next.indexOf(targetId), 0, draggedId);
  return next;
}

/**
 * Sorts the terminals by `order` while it covers exactly the same id set, else returns them untouched
 * (a session added or removed falls back to the server order).
 */
export function applyRowOrder(
  cockpitTerminals: CockpitTerminalInfo[],
  order: string[] | null,
): CockpitTerminalInfo[] {
  if (order === null || order.length !== cockpitTerminals.length) {
    return cockpitTerminals;
  }
  const rank = new Map(order.map((id, i) => [id, i]));
  if (!cockpitTerminals.every((s) => rank.has(s.cockpitTerminalId))) {
    return cockpitTerminals;
  }
  return [...cockpitTerminals].sort(
    (a, b) =>
      (rank.get(a.cockpitTerminalId) ?? 0) -
      (rank.get(b.cockpitTerminalId) ?? 0),
  );
}

/** Idle with neither an automatic nor a manual title = a new/unused session. */
export function isFresh(
  s: CockpitTerminalInfo,
  custom: string | undefined,
): boolean {
  return s.state === "idle" && s.title === null && custom === undefined;
}

/**
 * The ↑↓ move targets = org header rows + their visible session rows in display order. A collapsed
 * org excludes only its child rows; the header row is always a target.
 */
export function buildVisibleItems(
  orgList: string[],
  cockpitTerminals: CockpitTerminalInfo[],
  collapsed: ReadonlySet<string>,
): FocusTarget[] {
  const items: FocusTarget[] = [];
  for (const org of orgList) {
    items.push({ kind: "org", org });
    if (collapsed.has(org)) continue;
    for (const s of cockpitTerminals)
      if (s.org === org)
        items.push({ kind: "row", cockpitTerminalId: s.cockpitTerminalId });
  }
  return items;
}

/**
 * The target a single ↑↓ step lands on. The anchor is the current ring, else the visible selected
 * row, else (when that row is collapsed away) its org header; from no anchor a step goes to the first
 * (down) or last (up) item. Assumes visibleItems is non-empty.
 */
export function nextFocusTarget(
  visibleItems: FocusTarget[],
  focused: FocusTarget | null,
  selectedCockpitTerminalId: string | null,
  cockpitTerminals: CockpitTerminalInfo[],
  delta: number,
): FocusTarget | null {
  const visibleKeys = visibleItems.map(focusKey);
  let anchorKey: string | null = null;
  if (focused !== null) anchorKey = focusKey(focused);
  else if (selectedCockpitTerminalId !== null) {
    const rowKey = focusKey({
      kind: "row",
      cockpitTerminalId: selectedCockpitTerminalId,
    });
    if (visibleKeys.includes(rowKey)) anchorKey = rowKey;
    else {
      const sel = cockpitTerminals.find(
        (s) => s.cockpitTerminalId === selectedCockpitTerminalId,
      );
      if (sel !== undefined)
        anchorKey = focusKey({ kind: "org", org: sel.org });
    }
  }
  const cur = anchorKey === null ? -1 : visibleKeys.indexOf(anchorKey);
  const next =
    cur === -1
      ? delta > 0
        ? 0
        : visibleItems.length - 1
      : Math.min(visibleItems.length - 1, Math.max(0, cur + delta));
  return visibleItems[next] ?? null;
}
