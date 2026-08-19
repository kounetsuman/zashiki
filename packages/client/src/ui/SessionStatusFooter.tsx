import type { SessionUsage, UsageLimit } from "@zashiki/shared";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  fmtDuration,
  fmtResetCountdown,
  fmtTokens,
  tokenSeverity,
  usageSeverity,
} from "../session/status-footer.js";

export interface SessionStatusFooterProps {
  usage: SessionUsage;
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function Cell({
  value,
  caption,
  severity,
}: {
  value: string;
  caption: string;
  severity?: string;
}) {
  const cls = severity ? `ss-val ss-${severity}` : "ss-val";
  return (
    <span className={cls}>
      {value}
      <span className="ss-cap">{caption}</span>
    </span>
  );
}

/**
 * Status area docked under the terminal for the active session: tokens and elapsed time (this turn /
 * this session) plus, when the statusLine bridge is configured, the account usage limits with a live
 * reset countdown. Elapsed and countdown re-tick each second off the server-provided epoch anchors.
 */
export function SessionStatusFooter({ usage }: SessionStatusFooterProps) {
  const { t } = useTranslation();
  const now = useNow(1_000);
  const limits = usage.limits;

  const limitCell = (limit: UsageLimit, label: string, title: string) => {
    const value =
      limit.resetsAt !== undefined
        ? t("footer.status.percentReset", {
            percent: limit.usedPercent,
            time: fmtResetCountdown(limit.resetsAt - now),
          })
        : `${limit.usedPercent}%`;
    return (
      <span className="ss-group" title={title}>
        <Cell
          value={value}
          caption={label}
          severity={usageSeverity(limit.usedPercent)}
        />
      </span>
    );
  };

  return (
    <footer className="session-status">
      <span className="ss-group" title={t("footer.status.tokensTitle")}>
        <span className="material-symbols-outlined ss-icon" aria-hidden="true">
          generating_tokens
        </span>
        <Cell
          value={fmtTokens(usage.turnTokens)}
          caption={t("footer.status.turn")}
        />
        <Cell
          value={fmtTokens(usage.sessionTokens)}
          caption={t("footer.status.session")}
          severity={tokenSeverity(usage.sessionTokens)}
        />
      </span>

      <span className="ss-group" title={t("footer.status.elapsedTitle")}>
        <span className="material-symbols-outlined ss-icon" aria-hidden="true">
          schedule
        </span>
        <Cell
          value={fmtDuration(now - usage.turnStartedAt)}
          caption={t("footer.status.turn")}
        />
        <Cell
          value={fmtDuration(now - usage.sessionStartedAt)}
          caption={t("footer.status.session")}
        />
      </span>

      {limits !== undefined && (limits.fiveHour || limits.week) && (
        <span className="ss-group ss-group-limits">
          <span
            className="material-symbols-outlined ss-icon"
            aria-hidden="true"
          >
            speed
          </span>
          {limits.fiveHour &&
            limitCell(
              limits.fiveHour,
              t("footer.status.fiveHour"),
              t("footer.status.fiveHourTitle"),
            )}
          {limits.week &&
            limitCell(
              limits.week,
              t("footer.status.week"),
              t("footer.status.weekTitle"),
            )}
        </span>
      )}
    </footer>
  );
}
