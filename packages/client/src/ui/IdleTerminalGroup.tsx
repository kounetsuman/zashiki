import { resolveOrgColor, resolveOrgName } from "@zashiki/shared";
import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { CockpitTerminalsApi } from "../api/cockpit-terminals.js";
import {
  type IdleTerminalRow,
  idleDays,
  idleTone,
} from "../lib/idle-terminals.js";
import { useConfirmClose } from "./useConfirmClose.js";
import { useNow } from "./useNow.js";

export interface IdleTerminalGroupProps {
  rows: readonly IdleTerminalRow[];
  api: Pick<CockpitTerminalsApi, "tail">;
  orgColors?: Record<string, string>;
  orgAliases?: Record<string, string>;
  onOpenCockpitTerminal(cockpitTerminalId: string): void;
  onCloseCockpitTerminal(cockpitTerminalId: string): void;
}

/** Idle days move once a day, so a minute is fine enough. */
const IDLE_CLOCK_MS = 60_000;

/**
 * The idle Cockpit Terminals, as a collapsible group. Each row expands to the last lines of its
 * screen and can be closed from here after an inline confirmation.
 */
export const IdleTerminalGroup = memo(function IdleTerminalGroup({
  rows,
  api,
  orgColors = {},
  orgAliases = {},
  onOpenCockpitTerminal,
  onCloseCockpitTerminal,
}: IdleTerminalGroupProps) {
  const { t } = useTranslation();
  const nowMs = useNow(IDLE_CLOCK_MS);
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const { confirmingClose, requestClose, confirmClose, cancelClose } =
    useConfirmClose(
      rows.map((r) => r.terminal),
      onCloseCockpitTerminal,
    );

  const cancelCloseRef = useRef(cancelClose);
  cancelCloseRef.current = cancelClose;
  const confirming = confirmingClose !== null;
  useEffect(() => {
    if (!confirming) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !e.defaultPrevented) cancelCloseRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirming]);

  if (rows.length === 0) return null;

  const toggle = (id: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <div className="idle-terminal-group">
      <button
        type="button"
        className="idle-terminal-group-header"
        aria-expanded={open}
        title={t("idleTerminals.hint")}
        onClick={() => {
          if (open) cancelClose();
          setOpen(!open);
        }}
      >
        <span className="material-symbols-outlined" aria-hidden="true">
          {open ? "expand_more" : "chevron_right"}
        </span>
        <span>{t("idleTerminals.title")}</span>{" "}
        <span className="idle-terminal-group-count">{rows.length}</span>
      </button>
      {open && (
        <ul className="idle-terminal-list scrollbar-persistent">
          {rows.map(({ terminal, title, lastActivityAt }) => {
            const id = terminal.cockpitTerminalId;
            const tailOpen = expanded.has(id);
            const days = idleDays(lastActivityAt, nowMs);
            const orgName = resolveOrgName(terminal.org, orgAliases);
            return (
              <li
                key={id}
                className="idle-terminal-item"
                data-cockpit-terminal-id={id}
              >
                <div className="idle-terminal-row">
                  <button
                    type="button"
                    className="idle-terminal-chevron"
                    aria-expanded={tailOpen}
                    aria-label={t("idleTerminals.showTail", { name: title })}
                    onClick={() => toggle(id)}
                  >
                    <span
                      className="material-symbols-outlined"
                      aria-hidden="true"
                    >
                      {tailOpen ? "expand_more" : "chevron_right"}
                    </span>
                  </button>
                  <span
                    className="org-dot"
                    role="img"
                    style={{
                      backgroundColor: resolveOrgColor(terminal.org, orgColors),
                    }}
                    title={orgName}
                    aria-label={`org: ${orgName}`}
                  />
                  <button
                    type="button"
                    className="idle-terminal-title"
                    title={title}
                    onClick={() => onOpenCockpitTerminal(id)}
                  >
                    {title}
                  </button>
                  <span className={`idle-terminal-days is-${idleTone(days)}`}>
                    {t("idleTerminals.days", { count: days })}
                  </span>
                  {confirmingClose === id ? (
                    <span className="session-row-confirm">
                      <button
                        type="button"
                        className="session-confirm-ok"
                        aria-label={t("idleTerminals.closeConfirm", {
                          name: title,
                        })}
                        onClick={() => confirmClose(id)}
                      >
                        {t("common.close")}
                      </button>
                      <button
                        type="button"
                        className="session-confirm-cancel"
                        onClick={cancelClose}
                      >
                        {t("common.cancel")}
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="idle-terminal-close"
                      aria-label={t("idleTerminals.close", { name: title })}
                      title={t("common.close")}
                      onClick={() => requestClose(id)}
                    >
                      <span
                        className="material-symbols-outlined"
                        aria-hidden="true"
                      >
                        delete
                      </span>
                    </button>
                  )}
                </div>
                {tailOpen && <TerminalTail api={api} cockpitTerminalId={id} />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
});

type TailState =
  | { kind: "loading" }
  | { kind: "lines"; lines: string[] }
  | { kind: "error" };

function TerminalTail({
  api,
  cockpitTerminalId,
}: {
  api: Pick<CockpitTerminalsApi, "tail">;
  cockpitTerminalId: string;
}) {
  const { t } = useTranslation();
  const [tail, setTail] = useState<TailState>({ kind: "loading" });

  useEffect(() => {
    const read = new AbortController();
    api.tail(cockpitTerminalId, read.signal).then(
      (lines) => {
        if (!read.signal.aborted) setTail({ kind: "lines", lines });
      },
      () => {
        if (!read.signal.aborted) setTail({ kind: "error" });
      },
    );
    return () => read.abort();
  }, [api, cockpitTerminalId]);

  if (tail.kind === "loading")
    return <p className="idle-terminal-note">{t("common.loading")}</p>;
  if (tail.kind === "error")
    return (
      <p className="idle-terminal-note">{t("idleTerminals.tailFailed")}</p>
    );
  if (tail.lines.length === 0)
    return <p className="idle-terminal-note">{t("idleTerminals.tailEmpty")}</p>;
  return <pre className="idle-terminal-tail">{tail.lines.join("\n")}</pre>;
}
