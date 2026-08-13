import type { SessionInfo } from "@zashiki/shared";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TerminalSessionStatus } from "../session/terminal-session.js";
import type { ControlStatus } from "../ws/control.js";
import {
  type ControlDebugSnapshot,
  describeServerEvent,
  type ProtocolLogEntry,
  pushRing,
  summarizeSessions,
  type TermDebugSnapshot,
  tmuxSessionName,
} from "./debug-model.js";

const MAX_PROTOCOL_TAIL = 40;
const MAX_EVENT_LOG = 40;

/**
 * The minimal interface DebugPanel reads from the control side.
 * Carved out separately from App's AppControl so DebugPanel can be unit-tested.
 */
export interface DebugControl {
  debugSnapshot(): ControlDebugSnapshot;
  onStatus(fn: (s: ControlStatus) => void): () => void;
  onProtocol(fn: (dir: "send" | "recv", t: string) => void): () => void;
  onMessage(
    fn: (m: import("@zashiki/shared").ServerMessage) => void,
  ): () => void;
}

export interface DebugSession {
  debugSnapshot(): TermDebugSnapshot;
  onStatus(fn: (s: TerminalSessionStatus) => void): () => void;
}

export interface DebugPanelProps {
  control: DebugControl;
  session: DebugSession;
  /** The latest state.sync snapshot (tmux window layout / state poller result). */
  sessions: readonly SessionInfo[];
  /** Clock source for tests (defaults to Date.now). */
  now?: () => number;
  onClose(): void;
}

/**
 * The debug-mode overlay panel. Exhaustively shows the current state when things get stuck.
 * Display formatting is pushed into debug-model.ts pure functions; this only subscribes and renders.
 */
export function DebugPanel({
  control,
  session,
  sessions,
  now = Date.now,
  onClose,
}: DebugPanelProps) {
  const { t } = useTranslation();
  const [controlSnap, setControlSnap] = useState<ControlDebugSnapshot>(() =>
    control.debugSnapshot(),
  );
  const [termSnap, setTermSnap] = useState<TermDebugSnapshot>(() =>
    session.debugSnapshot(),
  );
  const [protocolTail, setProtocolTail] = useState<ProtocolLogEntry[]>([]);
  const [eventLog, setEventLog] = useState<string[]>([]);
  const nowRef = useRef(now);
  nowRef.current = now;

  useEffect(() => {
    const off = control.onStatus(() => setControlSnap(control.debugSnapshot()));
    return off;
  }, [control]);

  useEffect(() => {
    const off = session.onStatus(() => setTermSnap(session.debugSnapshot()));
    return off;
  }, [session]);

  useEffect(() => {
    const off = control.onProtocol((dir, t) => {
      setProtocolTail((tail) =>
        pushRing(tail, { dir, t, at: nowRef.current() }, MAX_PROTOCOL_TAIL),
      );
      // Send/receive can also affect control state, so update the snapshot too
      setControlSnap(control.debugSnapshot());
    });
    return off;
  }, [control]);

  useEffect(() => {
    const off = control.onMessage((m) => {
      const line = describeServerEvent(m);
      if (line !== null) {
        setEventLog((log) => pushRing(log, line, MAX_EVENT_LOG));
      }
    });
    return off;
  }, [control]);

  const rows = summarizeSessions(sessions);

  return (
    <section className="debug-panel" aria-label={t("debug.panelLabel")}>
      <div className="debug-panel-head">
        <strong>debug</strong>
        <button type="button" onClick={onClose} aria-label={t("debug.close")}>
          ×
        </button>
      </div>

      <section className="debug-section">
        <h4>control WS</h4>
        <dl>
          <dt>status</dt>
          <dd>{controlSnap.status}</dd>
          <dt>{t("debug.reconnectAttempt")}</dt>
          <dd>{controlSnap.attempt}</dd>
          <dt>{t("debug.lastCloseCode")}</dt>
          <dd>{controlSnap.lastCloseCode ?? "-"}</dd>
        </dl>
      </section>

      <section className="debug-section">
        <h4>term WS</h4>
        <dl>
          <dt>status</dt>
          <dd>{termSnap.status}</dd>
          <dt>attempt</dt>
          <dd>{termSnap.attempt}</dd>
          <dt>pendingAck</dt>
          <dd>{termSnap.pendingAck}</dd>
          <dt>windowId</dt>
          <dd>{termSnap.windowId ?? "-"}</dd>
          <dt>termId</dt>
          <dd>{termSnap.termId ?? "-"}</dd>
          <dt>tmux</dt>
          <dd>{tmuxSessionName(termSnap.termId) ?? "-"}</dd>
          <dt>suspended</dt>
          <dd>{String(termSnap.suspended)}</dd>
        </dl>
      </section>

      <section className="debug-section">
        <h4>{t("debug.stateSync")}</h4>
        {rows.length === 0 ? (
          <p className="debug-empty">{t("debug.noSessions")}</p>
        ) : (
          <ul className="debug-list">
            {rows.map((r) => (
              <li key={r.windowId}>
                {r.active ? "▶" : "·"} {r.windowId} [{r.state}] {r.label}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="debug-section">
        <h4>{t("debug.eventLog")}</h4>
        <p className="debug-note">{t("debug.eventLogNote")}</p>
        {eventLog.length === 0 ? (
          <p className="debug-empty">{t("debug.noEventsYet")}</p>
        ) : (
          <ul className="debug-list debug-log">
            {eventLog.map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: row key for an append-only log
              <li key={i}>{line}</li>
            ))}
          </ul>
        )}
      </section>

      <section className="debug-section">
        <h4>{t("debug.protocolTail")}</h4>
        {protocolTail.length === 0 ? (
          <p className="debug-empty">{t("debug.noProtocolYet")}</p>
        ) : (
          <ul className="debug-list debug-log">
            {protocolTail.map((e, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: row key for an append-only log
              <li key={i}>
                {e.dir === "send" ? "→" : "←"} {e.t}
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
