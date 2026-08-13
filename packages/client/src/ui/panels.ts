/**
 * Identifier for the panel chosen via the footer's panel-switch icons. Add future panels to this union.
 * The session list is always pinned (not switchable), so it is not included here.
 */
export type PanelId =
  | "explorer"
  | "search"
  | "git"
  | "notification"
  | "help"
  | "settings";

/**
 * Registration info for the panel-switch icons in the footer. Future panels (search/explorer, etc.)
 * become switchable simply by adding an entry of this type to PANEL_DEFS (no extra branching in App).
 */
export interface PanelDef {
  id: PanelId;
  /** i18n key for the accessible label (aria-label / title). */
  labelKey: string;
  /** Switch icon name (Material Symbols Outlined ligature). */
  icon: string;
  /**
   * Keyboard shortcut for switching. Fires on Ctrl+Alt+<key> (uses different modifiers
   * from the existing panel-local Ctrl-N/X, so it doesn't collide).
   */
  shortcutKey: string;
}

/**
 * The order of the footer switch icons = the order of this array. A future panel becomes switchable
 * simply by adding one line here. shortcutKey fires on Ctrl+Alt+<key>. It uses different modifiers
 * from Cmd+N (new session) and the panel-local Ctrl-N/X, so it doesn't collide.
 */
export const PANEL_DEFS: readonly PanelDef[] = [
  {
    id: "explorer",
    labelKey: "panel.explorer",
    icon: "file_copy",
    shortcutKey: "e",
  },
  { id: "search", labelKey: "panel.search", icon: "search", shortcutKey: "f" },
  {
    id: "git",
    labelKey: "panel.git",
    icon: "call_split",
    shortcutKey: "g",
  },
  {
    id: "notification",
    labelKey: "panel.notification",
    icon: "notifications",
    shortcutKey: "n",
  },
  { id: "help", labelKey: "panel.help", icon: "help", shortcutKey: "h" },
  {
    id: "settings",
    labelKey: "panel.settings",
    icon: "settings",
    shortcutKey: "s",
  },
];

/** The panel selected by default (first = explorer). */
export const DEFAULT_PANEL: PanelId = PANEL_DEFS[0]?.id ?? "explorer";

/**
 * Builds the panel root's className. When inactive, adds panel-inactive for the faint overlay.
 * Shared across all panel components.
 */
export function panelClass(base: string, inactive?: boolean): string {
  return inactive === true ? `${base} panel-inactive` : base;
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
export const PANELS_SELECTED_KEY = "zk.panels.selected";

/** Persisted value for the all-panels-closed state (does not collide with any PanelId). */
export const PANEL_CLOSED_VALUE = "none";

type StoragePart = Pick<Storage, "getItem" | "setItem">;

/** Type guard determining whether the given value is a PanelId registered in PANEL_DEFS. */
export function isPanelId(value: unknown): value is PanelId {
  return typeof value === "string" && PANEL_DEFS.some((d) => d.id === value);
}

/**
 * Reads the persisted selected panel, falling back to the default (explorer) on invalid/missing
 * (pure function, storage injectable). Does not read the old `zk.panels.visibility` (JSON of multiple
 * visible panels). The value is a single panel id string (not JSON). The closed state (`none`) returns null.
 */
export function loadSelectedPanel(storage: StoragePart | null): PanelId | null {
  if (storage === null) return DEFAULT_PANEL;
  const raw = storage.getItem(PANELS_SELECTED_KEY);
  if (raw === PANEL_CLOSED_VALUE) return null;
  return isPanelId(raw) ? raw : DEFAULT_PANEL;
}

/** Persists the selected panel (raw id string; closed state is `none`; storage injectable). */
export function saveSelectedPanel(
  storage: StoragePart | null,
  id: PanelId | null,
): void {
  storage?.setItem(PANELS_SELECTED_KEY, id ?? PANEL_CLOSED_VALUE);
}
