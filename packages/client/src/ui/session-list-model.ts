import type { SessionInfo } from "@zashiki/shared";

/** Target of the right-click menu (an org area or a session row). */
export type ContextMenu =
  | { kind: "org"; org: string; x: number; y: number }
  | { kind: "row"; windowId: string; name: string; x: number; y: number };

/** Target of ↑↓ focus = an org header row or a session row (treated as one flat sequence). */
export type FocusTarget =
  | { kind: "org"; org: string }
  | { kind: "row"; windowId: string };

/** Unique key for equality checks, the visible-set key, and effect deps (the prefix separates the kind). */
export function focusKey(t: FocusTarget): string {
  return t.kind === "org" ? `o:${t.org}` : `r:${t.windowId}`;
}

/** Preserve the order of orgs while appending detected orgs not in orgs at the end. */
export function displayOrgs(orgs: string[], sessions: SessionInfo[]): string[] {
  const result = [...orgs];
  const seen = new Set(orgs);
  for (const s of sessions) {
    if (seen.has(s.org)) continue;
    seen.add(s.org);
    result.push(s.org);
  }
  return result;
}

/** Idle with neither an automatic nor a manual title = a new/unused session. */
export function isFresh(s: SessionInfo, custom: string | undefined): boolean {
  return s.state === "idle" && s.title === null && custom === undefined;
}

/**
 * The ↑↓ move targets = org header rows + their visible session rows in display order. A collapsed
 * org excludes only its child rows; the header row is always a target.
 */
export function buildVisibleItems(
  orgList: string[],
  sessions: SessionInfo[],
  collapsed: ReadonlySet<string>,
): FocusTarget[] {
  const items: FocusTarget[] = [];
  for (const org of orgList) {
    items.push({ kind: "org", org });
    if (collapsed.has(org)) continue;
    for (const s of sessions)
      if (s.org === org) items.push({ kind: "row", windowId: s.windowId });
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
  selectedWindowId: string | null,
  sessions: SessionInfo[],
  delta: number,
): FocusTarget | null {
  const visibleKeys = visibleItems.map(focusKey);
  let anchorKey: string | null = null;
  if (focused !== null) anchorKey = focusKey(focused);
  else if (selectedWindowId !== null) {
    const rowKey = focusKey({ kind: "row", windowId: selectedWindowId });
    if (visibleKeys.includes(rowKey)) anchorKey = rowKey;
    else {
      const sel = sessions.find((s) => s.windowId === selectedWindowId);
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
