/**
 * Removes terminal query replies that xterm.js emits via onData in answer to capability
 * queries (Device Attributes, XTVERSION, OSC color, device status, window size).
 *
 * xterm.js delivers these auto-generated replies through the same onData path as keystrokes.
 * When the terminal is re-queried on a re-attach or window switch, xterm answers via onData.
 * While Claude Code is running it absorbs them, but at
 * a bare shell prompt they are echoed as literal garbage. The canonical set is terminal-reply.test.ts.
 *
 * These are terminal->host reports; a human never types them (keystroke CSI such as arrow keys
 * end in a letter that none of these patterns match), so dropping them at the xterm->pty boundary
 * is safe. The DCS pattern is deliberately restricted to the XTVERSION `>|` form so it cannot
 * swallow other DCS that may ride the input path (sixel, DCS inside pasted text).
 *
 * Patterns are built via `new RegExp` from a named ESC constant so the control byte never appears
 * as a literal inside a regex (which biome's noControlCharactersInRegex forbids).
 */
const ESC = "\\x1b";

// DA1 (CSI ? … c) and DA2 (CSI > … c) device-attributes replies.
const DEVICE_ATTRIBUTES = new RegExp(`${ESC}\\[[?>][0-9;]*c`, "g");
// OSC 10/11/12 color reports; xterm terminates with ST, real terminals may use BEL.
const OSC_COLOR_REPORT = new RegExp(
  `${ESC}\\][0-9]+;rgb:[0-9a-fA-F/]*(?:\\x07|${ESC}\\\\)`,
  "g",
);
// XTVERSION reply only: DCS > | name(version) ST. Not a generic DCS match (see JSDoc).
const XTVERSION_REPLY = new RegExp(`${ESC}P>\\|[\\s\\S]*?${ESC}\\\\`, "g");
// DSR replies: cursor position (CSI [?] row ; col R) and device/mode status (CSI [?] … n).
const DEVICE_STATUS = new RegExp(`${ESC}\\[\\??[0-9;]*[Rn]`, "g");
// Window-size report (CSI Ps ; Ps ; Ps t), e.g. the reply to a size query.
const WINDOW_REPORT = new RegExp(`${ESC}\\[[0-9;]+t`, "g");

export function stripTerminalReplies(data: string): string {
  if (!data.includes("\x1b")) return data;
  return data
    .replace(XTVERSION_REPLY, "")
    .replace(OSC_COLOR_REPORT, "")
    .replace(DEVICE_ATTRIBUTES, "")
    .replace(DEVICE_STATUS, "")
    .replace(WINDOW_REPORT, "");
}
