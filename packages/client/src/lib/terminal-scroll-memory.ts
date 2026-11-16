export interface TerminalViewport {
  readonly type: "normal" | "alternate";
  readonly viewportY: number;
  readonly baseY: number;
}

/** How long after a switch the replayed history may take to reach the remembered line. */
export const SCROLL_RESTORE_WINDOW_MS = 2000;

/**
 * The history line at the top of a viewport scrolled back from the latest output, to bring a Cockpit
 * Terminal back to on return. Null when it shows the latest output, or a full-screen program.
 */
export function scrolledBackLine(viewport: TerminalViewport): number | null {
  if (viewport.type === "alternate" || viewport.viewportY >= viewport.baseY) {
    return null;
  }
  return viewport.viewportY;
}

export type RestoreStep = "wait" | "scroll" | "give-up";

/**
 * Whether the history replayed on a switch is far enough along to scroll back to the remembered line.
 * The line must sit above the bottom: only a scroll up stops xterm from following new output. A
 * history that never gets there (trimmed meanwhile) is given up on rather than jumped up later.
 */
export function restoreStep(
  line: number,
  baseY: number,
  elapsedMs: number,
): RestoreStep {
  if (elapsedMs >= SCROLL_RESTORE_WINDOW_MS) return "give-up";
  return baseY > line ? "scroll" : "wait";
}
