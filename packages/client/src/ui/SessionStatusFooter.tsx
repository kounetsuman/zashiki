import {
  DEFAULT_FOOTER_THRESHOLDS,
  type FooterThresholds,
  type SessionUsage,
  type UsageLimit,
} from "@zashiki/shared";
import { useTranslation } from "react-i18next";

import {
  durationSeverity,
  fmtDuration,
  fmtResetCountdown,
  fmtTokens,
  fmtWeekResetCountdown,
  tokenSeverity,
  usageSeverity,
} from "../session/status-footer.js";
import { StatusCell } from "./StatusCell.js";
import { useNow } from "./useNow.js";

export interface SessionStatusFooterProps {
  /** Transcript-derived tokens/elapsed. null before the session has a readable transcript (shows dashes). */
  usage: SessionUsage | null;
  /** org accent applied to the top border, matching the active session tab. */
  accentColor?: string;
  /** Configured severity thresholds driving each cell's color. Defaults to the built-in bands (isolated tests). */
  thresholds?: FooterThresholds;
}

const DASH = "–";

/**
 * Status area docked under the terminal for the active session: tokens and elapsed time (this turn /
 * this session) plus, when the statusLine bridge is configured, the account usage limits with a live
 * reset countdown. Elapsed and countdown re-tick each second off the server-provided epoch anchors.
 */
export function SessionStatusFooter({
  usage,
  accentColor,
  thresholds = DEFAULT_FOOTER_THRESHOLDS,
}: SessionStatusFooterProps) {
  const { t } = useTranslation();
  const now = useNow(1_000);
  const limits = usage?.limits;

  const limitCell = (
    limit: UsageLimit,
    label: string,
    title: string,
    fmtCountdown: (ms: number) => string = fmtResetCountdown,
  ) => {
    const value =
      limit.resetsAt !== undefined
        ? t("footer.status.percentReset", {
            percent: limit.usedPercent,
            time: fmtCountdown(limit.resetsAt - now),
          })
        : `${limit.usedPercent}%`;
    return (
      <span className="ss-group" title={title}>
        <StatusCell
          value={value}
          caption={label}
          severity={usageSeverity(limit.usedPercent, thresholds.usagePercent)}
        />
      </span>
    );
  };

  return (
    <footer
      className="session-status"
      style={accentColor ? { borderTopColor: accentColor } : undefined}
    >
      <span className="ss-group" title={t("footer.status.tokensTitle")}>
        <span className="material-symbols-outlined ss-icon" aria-hidden="true">
          generating_tokens
        </span>
        <StatusCell
          value={usage ? fmtTokens(usage.turnTokens) : DASH}
          caption={t("footer.status.turn")}
        />
        <StatusCell
          value={usage ? fmtTokens(usage.sessionTokens) : DASH}
          caption={t("footer.status.session")}
          severity={
            usage
              ? tokenSeverity(usage.sessionTokens, thresholds.sessionTokens)
              : undefined
          }
        />
      </span>

      <span className="ss-group" title={t("footer.status.elapsedTitle")}>
        <span className="material-symbols-outlined ss-icon" aria-hidden="true">
          schedule
        </span>
        <StatusCell
          value={usage ? fmtDuration(now - usage.turnStartedAt) : DASH}
          caption={t("footer.status.turn")}
          severity={
            usage
              ? durationSeverity(
                  now - usage.turnStartedAt,
                  thresholds.elapsedMs,
                )
              : undefined
          }
        />
        <StatusCell
          value={usage ? fmtDuration(now - usage.sessionStartedAt) : DASH}
          caption={t("footer.status.session")}
          severity={
            usage
              ? durationSeverity(
                  now - usage.sessionStartedAt,
                  thresholds.elapsedMs,
                )
              : undefined
          }
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
              fmtWeekResetCountdown,
            )}
        </span>
      )}
    </footer>
  );
}
