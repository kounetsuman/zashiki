type StoragePart = Pick<Storage, "getItem" | "setItem">;

/** localStorage key for the terminal font size (follows the "zk.*" convention; client-only setting). */
export const TERMINAL_FONT_SIZE_KEY = "zk.terminal.fontSize";

/** Smallest selectable terminal font size (px). Below this the terminal becomes unreadable. */
export const MIN_TERMINAL_FONT_SIZE = 8;

/** Largest selectable terminal font size (px). Above this a single line no longer fits sensibly. */
export const MAX_TERMINAL_FONT_SIZE = 32;

/** Default terminal font size (px). Matches the historical hard-coded xterm.js value. */
export const DEFAULT_TERMINAL_FONT_SIZE = 13;

/** One increment/decrement step (px) for the A- / A+ controls. */
export const TERMINAL_FONT_SIZE_STEP = 1;

/**
 * Snaps an arbitrary number into the supported integer range. Non-finite input (NaN/Infinity)
 * falls back to the default rather than the range edge, so a corrupted value doesn't silently
 * pin the terminal to the smallest/largest size.
 */
export function clampTerminalFontSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_TERMINAL_FONT_SIZE;
  const rounded = Math.round(size);
  return Math.min(
    MAX_TERMINAL_FONT_SIZE,
    Math.max(MIN_TERMINAL_FONT_SIZE, rounded),
  );
}

/** Applies `steps` increments (negative to shrink) and clamps back into range. */
export function stepTerminalFontSize(current: number, steps: number): number {
  return clampTerminalFontSize(
    clampTerminalFontSize(current) + steps * TERMINAL_FONT_SIZE_STEP,
  );
}

/** Whether A+ can still enlarge (false once at the maximum). Drives the button's disabled state. */
export function canIncreaseTerminalFontSize(size: number): boolean {
  return clampTerminalFontSize(size) < MAX_TERMINAL_FONT_SIZE;
}

/** Whether A- can still shrink (false once at the minimum). Drives the button's disabled state. */
export function canDecreaseTerminalFontSize(size: number): boolean {
  return clampTerminalFontSize(size) > MIN_TERMINAL_FONT_SIZE;
}

/**
 * Reads the persisted font size, falling back to the default on missing/invalid input and clamping
 * an out-of-range stored value back into range (pure function, storage injectable).
 */
export function loadTerminalFontSize(storage: StoragePart | null): number {
  if (storage === null) return DEFAULT_TERMINAL_FONT_SIZE;
  const raw = storage.getItem(TERMINAL_FONT_SIZE_KEY);
  if (raw === null) return DEFAULT_TERMINAL_FONT_SIZE;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed)
    ? DEFAULT_TERMINAL_FONT_SIZE
    : clampTerminalFontSize(parsed);
}

/**
 * Persists the font size (clamped, integer string; storage injectable). Swallows write failures
 * (private mode / quota exceeded) — the size is auxiliary and must not break interaction, matching
 * the localStorage handling elsewhere (see conversation-title.ts).
 */
export function saveTerminalFontSize(
  storage: StoragePart | null,
  size: number,
): void {
  try {
    storage?.setItem(
      TERMINAL_FONT_SIZE_KEY,
      String(clampTerminalFontSize(size)),
    );
  } catch {
    // ignore (private mode / quota); the in-memory value still drives the UI this session.
  }
}
