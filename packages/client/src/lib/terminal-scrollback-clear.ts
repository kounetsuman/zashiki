const ERASE_SCROLLBACK = "\x1b[3J";

/**
 * Whether this output throws away the terminal's scrollback (`CSI 3 J`).
 *
 * The server sends it whenever it rebuilds a terminal's history — a switch, a re-attach — and a
 * program that clears its own scrollback means the same thing: the history a viewport was held
 * against is gone, and whatever arrives next is a new one.
 */
export function clearsScrollback(chunk: string): boolean {
  return chunk.includes(ERASE_SCROLLBACK);
}
