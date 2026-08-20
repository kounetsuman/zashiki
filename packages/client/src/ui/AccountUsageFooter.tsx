import type { UsageLimit, UsageLimits } from "@zashiki/shared";
import { useTranslation } from "react-i18next";

import { fmtResetCountdown, usageSeverity } from "../session/status-footer.js";
import { StatusCell } from "./StatusCell.js";
import { useNow } from "./useNow.js";

export interface AccountUsageFooterProps {
  /** Account-wide usage limits aggregated from the cockpit terminals; null until the statusLine bridge reports any. */
  limits: UsageLimits | null;
}

const DASH = "–";

/**
 * Claude Code account usage — the current 5-hour session and the current week — pinned to the left of
 * the global status-bar, independent of the active tab. Always visible: each cell shows a dash until
 * its limit is known (needs the statusLine bridge). The reset countdown re-ticks each second.
 */
export function AccountUsageFooter({ limits }: AccountUsageFooterProps) {
  const { t } = useTranslation();
  const now = useNow(1_000);

  const cell = (
    limit: UsageLimit | undefined,
    label: string,
    title: string,
  ) => {
    const value =
      limit === undefined
        ? DASH
        : limit.resetsAt !== undefined
          ? t("footer.status.percentReset", {
              percent: limit.usedPercent,
              time: fmtResetCountdown(limit.resetsAt - now),
            })
          : `${limit.usedPercent}%`;
    return (
      <span className="ss-group" title={title}>
        <StatusCell
          value={value}
          caption={label}
          severity={limit ? usageSeverity(limit.usedPercent) : undefined}
        />
      </span>
    );
  };

  return (
    <span className="account-usage">
      <span className="material-symbols-outlined ss-icon" aria-hidden="true">
        speed
      </span>
      {cell(
        limits?.fiveHour,
        t("footer.account.session"),
        t("footer.account.sessionTitle"),
      )}
      {cell(
        limits?.week,
        t("footer.account.week"),
        t("footer.account.weekTitle"),
      )}
    </span>
  );
}
