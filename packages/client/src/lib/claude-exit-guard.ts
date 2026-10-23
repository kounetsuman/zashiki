/** The control bytes Claude Code exits on when the same one arrives twice in quick succession. */
export type ExitKey = "\x03" | "\x04";

/** Claude Code exits on a repeat within 800 ms; the margin also catches a repeat right at its edge. */
export const CLAUDE_EXIT_DOUBLE_PRESS_MS = 1000;

/**
 * Gap between the two presses replayed on a confirmed exit. The press that opened the confirmation
 * has usually outlived Claude Code's window by then, so one press alone would only re-arm it.
 */
export const CLAUDE_EXIT_REPLAY_GAP_MS = 100;

/** Bare Ctrl+C / Ctrl+D as the control byte xterm would send for it, otherwise null. */
export function exitKeyOf(
  e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
): ExitKey | null {
  if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return null;
  if (e.key === "c" || e.key === "C") return "\x03";
  if (e.key === "d" || e.key === "D") return "\x04";
  return null;
}

export interface ClaudeExitGuard {
  /**
   * Records a press in the Cockpit Terminal whose Claude Session it would reach (null when none runs)
   * and returns true when it is the repeat that would exit Claude Code there.
   */
  hold(key: ExitKey, claudeTerminalId: string | null): boolean;
}

export function createClaudeExitGuard(now: () => number): ClaudeExitGuard {
  let last: { key: ExitKey; at: number; claudeTerminalId: string } | null =
    null;
  return {
    hold(key, claudeTerminalId) {
      if (claudeTerminalId === null) {
        last = null;
        return false;
      }
      const at = now();
      const isRepeat =
        last !== null &&
        last.key === key &&
        last.claudeTerminalId === claudeTerminalId &&
        at - last.at <= CLAUDE_EXIT_DOUBLE_PRESS_MS;
      last = { key, at, claudeTerminalId };
      return isRepeat;
    },
  };
}
