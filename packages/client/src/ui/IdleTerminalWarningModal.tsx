import type { CockpitTerminalInfo } from "@zashiki/shared";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { CockpitTerminalsApi } from "../api/cockpit-terminals.js";
import { idleDays } from "../lib/idle-terminal-warning.js";
import { Modal } from "./Modal.js";
import { useConfirmClose } from "./useConfirmClose.js";
import "./IdleTerminalWarningModal.css";

export interface IdleTerminalRow {
  terminal: CockpitTerminalInfo;
  /** The label the Cockpit Terminal list shows for it. */
  title: string;
  lastActivityAt: number;
}

export interface IdleTerminalWarningModalProps {
  rows: IdleTerminalRow[];
  nowMs: number;
  api: Pick<CockpitTerminalsApi, "tail">;
  onCloseTerminal(cockpitTerminalId: string): void;
  onClose(): void;
}

/**
 * Lists the Cockpit Terminals left without input or output for a day or more. Each row expands to
 * the last lines of its screen and can be closed from here after an inline confirmation.
 */
export function IdleTerminalWarningModal({
  rows,
  nowMs,
  api,
  onCloseTerminal,
  onClose,
}: IdleTerminalWarningModalProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const { confirmingClose, requestClose, confirmClose, cancelClose } =
    useConfirmClose(
      rows.map((r) => r.terminal),
      onCloseTerminal,
    );

  const toggle = (id: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <Modal
      title={t("idleWarning.title")}
      closeLabel={t("common.close")}
      onClose={onClose}
      className="idle-warning-modal"
    >
      <div className="idle-warning-body scrollbar-persistent">
        <p className="idle-warning-lead">{t("idleWarning.lead")}</p>
        <ul className="idle-warning-list">
          {rows.map(({ terminal, title, lastActivityAt }) => {
            const id = terminal.cockpitTerminalId;
            const open = expanded.has(id);
            return (
              <li key={id} className="idle-warning-item">
                <div className="idle-warning-row">
                  <button
                    type="button"
                    className="idle-warning-toggle"
                    aria-expanded={open}
                    onClick={() => toggle(id)}
                  >
                    <span
                      className="material-symbols-outlined idle-warning-arrow"
                      aria-hidden="true"
                    >
                      {open ? "expand_more" : "chevron_right"}
                    </span>
                    <span className="idle-warning-name">{title}</span>
                    <span className="idle-warning-meta">
                      {terminal.org} / {terminal.repo}
                    </span>
                    <span className="idle-warning-age">
                      {t("idleWarning.idleDays", {
                        count: idleDays(lastActivityAt, nowMs),
                      })}
                    </span>
                  </button>
                  {confirmingClose === id ? (
                    <span className="session-row-confirm">
                      <button
                        type="button"
                        className="session-confirm-ok"
                        aria-label={t("idleWarning.closeConfirm", {
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
                      className="idle-warning-delete"
                      aria-label={t("idleWarning.close", { name: title })}
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
                {open && <TerminalTail api={api} cockpitTerminalId={id} />}
              </li>
            );
          })}
        </ul>
      </div>
    </Modal>
  );
}

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
    return <p className="idle-warning-note">{t("common.loading")}</p>;
  if (tail.kind === "error")
    return <p className="idle-warning-note">{t("idleWarning.tailFailed")}</p>;
  if (tail.lines.length === 0)
    return <p className="idle-warning-note">{t("idleWarning.tailEmpty")}</p>;
  return <pre className="idle-warning-tail">{tail.lines.join("\n")}</pre>;
}
