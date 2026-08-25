/**
 * Identifier for the view chosen via the footer's view-switch icons. Add future views to this union.
 * The session list is always pinned (not switchable), so it is not included here.
 */
export type ViewId = "explorer" | "search" | "sourceControl" | "notification";

/**
 * Registration info for the view-switch icons in the footer. Future views (search/explorer, etc.)
 * become switchable simply by adding an entry of this type to VIEW_DEFS (no extra branching in App).
 */
export interface ViewDef {
  id: ViewId;
  /** i18n key for the accessible label (aria-label / title). */
  labelKey: string;
  /** Switch icon name (Material Symbols Outlined ligature). */
  icon: string;
  /**
   * Keyboard shortcut for switching. Fires on Ctrl+Alt+<key> (uses different modifiers
   * from the existing view-local Ctrl-N/X, so it doesn't collide).
   */
  shortcutKey: string;
}

/**
 * The order of the footer switch icons = the order of this array. A future view becomes switchable
 * simply by adding one line here. shortcutKey fires on Ctrl+Alt+<key>. It uses different modifiers
 * from Cmd+N (new session) and the view-local Ctrl-N/X, so it doesn't collide.
 */
export const VIEW_DEFS: readonly ViewDef[] = [
  {
    id: "explorer",
    labelKey: "view.explorer",
    icon: "file_copy",
    shortcutKey: "e",
  },
  { id: "search", labelKey: "view.search", icon: "search", shortcutKey: "f" },
  {
    id: "sourceControl",
    labelKey: "view.sourceControl",
    icon: "call_split",
    shortcutKey: "g",
  },
  {
    id: "notification",
    labelKey: "view.notification",
    icon: "notifications",
    shortcutKey: "n",
  },
];

/** The view selected by default (first = explorer). */
export const DEFAULT_PANEL: ViewId = VIEW_DEFS[0]?.id ?? "explorer";

/**
 * Builds the view root's className. When inactive, adds view-inactive for the faint overlay.
 * Shared across all view components.
 */
export function viewClass(base: string, inactive?: boolean): string {
  return inactive === true ? `${base} view-inactive` : base;
}

/**
 * Clamps the context menu's position within the viewport (prevents overflow at the right/bottom edges).
 * Estimates height from the item count (roughly 28px per item + padding). Shared by the SESSION LIST
 * row/org menu and TabBar's tab menu (aligns clamp behavior across all three paths).
 */
export function clampMenuPos(
  x: number,
  y: number,
  itemCount = 1,
): { x: number; y: number } {
  const MENU_W = 200;
  const MENU_H = 12 + itemCount * 28;
  return {
    x: Math.max(0, Math.min(x, window.innerWidth - MENU_W)),
    y: Math.max(0, Math.min(y, window.innerHeight - MENU_H)),
  };
}

/** localStorage key (follows notify.ts's "zk.*" convention; moved to single selection). */
export const VIEWS_SELECTED_KEY = "zk.views.selected";

/** Persisted value for the all-views-closed state (does not collide with any ViewId). */
export const PANEL_CLOSED_VALUE = "none";

type StoragePart = Pick<Storage, "getItem" | "setItem">;

/** Type guard determining whether the given value is a ViewId registered in VIEW_DEFS. */
export function isViewId(value: unknown): value is ViewId {
  return typeof value === "string" && VIEW_DEFS.some((d) => d.id === value);
}

/**
 * Reads the persisted selected view, falling back to the default (explorer) on invalid/missing
 * (pure function, storage injectable). Does not read the old `zk.views.visibility` (JSON of multiple
 * visible views). The value is a single view id string (not JSON). The closed state (`none`) returns null.
 */
export function loadSelectedView(storage: StoragePart | null): ViewId | null {
  if (storage === null) return DEFAULT_PANEL;
  const raw = storage.getItem(VIEWS_SELECTED_KEY);
  if (raw === PANEL_CLOSED_VALUE) return null;
  return isViewId(raw) ? raw : DEFAULT_PANEL;
}

/** Persists the selected view (raw id string; closed state is `none`; storage injectable). */
export function saveSelectedView(
  storage: StoragePart | null,
  id: ViewId | null,
): void {
  storage?.setItem(VIEWS_SELECTED_KEY, id ?? PANEL_CLOSED_VALUE);
}
