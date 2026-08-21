type StoragePart = Pick<Storage, "getItem" | "setItem">;

/** Which renderer xterm.js paints with. */
export type XtermRenderer = "webgl" | "dom";

/** localStorage key for the renderer choice (follows the "zk.*" convention; client-only setting). */
export const XTERM_RENDERER_KEY = "zk.terminal.renderer";

/** Default renderer (WebGL avoids the WKWebView first-paint race). */
export const DEFAULT_XTERM_RENDERER: XtermRenderer = "webgl";

/** Narrows an arbitrary stored string to a supported renderer. */
export function isXtermRenderer(value: string | null): value is XtermRenderer {
  return value === "webgl" || value === "dom";
}

/** Reads the persisted renderer, falling back to the default on missing/unknown input (storage injectable). */
export function loadXtermRenderer(storage: StoragePart | null): XtermRenderer {
  if (storage === null) return DEFAULT_XTERM_RENDERER;
  const raw = storage.getItem(XTERM_RENDERER_KEY);
  return isXtermRenderer(raw) ? raw : DEFAULT_XTERM_RENDERER;
}

/** Persists the renderer (storage injectable). Swallows write failures (private mode / quota). */
export function saveXtermRenderer(
  storage: StoragePart | null,
  renderer: XtermRenderer,
): void {
  try {
    storage?.setItem(XTERM_RENDERER_KEY, renderer);
  } catch {
    // ignore (private mode / quota); the in-memory value still drives the UI this session.
  }
}
