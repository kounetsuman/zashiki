import type { ServerMessage } from "@zashiki/shared";

/** The part of a terminal session that re-attaches when the server says its term was lost. */
export interface RecoverableTerm {
  getTermId(): string | null;
  reconnect(): void;
  retryLostTerm(): void;
}

/**
 * Re-attaches `session` when `m` says its PTY was replaced (term.reconnect) or its term is unknown to
 * the server (unknown_term, e.g. after a server restart). Messages about another term are ignored:
 * re-attaching a term that is fine would discard its scrollback and replay it for nothing, and a late
 * error about a term already re-attached would re-attach it twice. Returns whether `m` was one of the
 * two messages.
 */
export function recoverTerm(
  m: ServerMessage,
  session: RecoverableTerm,
): boolean {
  if (m.t === "term.reconnect") {
    const termId = session.getTermId();
    if (termId !== null && m.termIds.includes(termId)) session.reconnect();
    return true;
  }
  if (m.t === "error" && m.code === "unknown_term") {
    const termId = session.getTermId();
    if (termId !== null && m.message.includes(termId)) session.retryLostTerm();
    return true;
  }
  return false;
}
