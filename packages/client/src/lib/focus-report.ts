/**
 * Removes from pty input the focus reports (focus-in=`ESC [ I` / focus-out=`ESC [ O`) that
 * xterm.js emits via onData when focus tracking (DECSET 1004) is enabled.
 *
 * In an embedded terminal these crawl in on every focus enter/leave of the webview, so at a
 * bare shell prompt they are echoed as `^[[I` and show up as stray characters. Drop them at
 * the xterm->pty boundary. Other CSI such as arrow keys are preserved (only the `I`/`O` two
 * sequences are targeted).
 */
export function stripFocusReports(data: string): string {
  if (!data.includes("\x1b[")) return data;
  return data.replaceAll("\x1b[I", "").replaceAll("\x1b[O", "");
}
