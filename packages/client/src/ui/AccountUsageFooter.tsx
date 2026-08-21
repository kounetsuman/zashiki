import type { UsageLimit, UsageLimits } from "@zashiki/shared";
import { useTranslation } from "react-i18next";

import { fmtResetCountdown, usageSeverity } from "../session/status-footer.js";
import { StatusCell } from "./StatusCell.js";
import { useNow } from "./useNow.js";

export interface AccountUsageFooterProps {
  /** Account-wide usage limits aggregated from the cockpit terminals; null until the statusLine bridge reports any. */
  limits: UsageLimits | null;
  /** Whether the account-usage bridge is opted in. When off, only the (clickable) icon is shown. */
  enabled: boolean;
  /** Open the opt-in modal (used only while opted out). */
  onRequestEnable(): void;
}

const DASH = "–";

/**
 * Claude Code account usage — the current 5-hour session and the current week — pinned to the left of
 * the global status-bar, independent of the active tab. While opted out, only the gauge icon shows,
 * clickable to open the opt-in modal. While opted in, each cell shows a dash until its limit is known
 * (needs the statusLine bridge); the reset countdown re-ticks each second.
 */
export function AccountUsageFooter({
  limits,
  enabled,
  onRequestEnable,
}: AccountUsageFooterProps) {
  const { t } = useTranslation();
  const now = useNow(1_000);

  if (!enabled) {
    return (
      <button
        type="button"
        className="account-usage account-usage-disabled"
        title={t("footer.account.enableTitle")}
        aria-label={t("footer.account.enableTitle")}
        onClick={onRequestEnable}
      >
        <span className="material-symbols-outlined ss-icon" aria-hidden="true">
          speed
        </span>
      </button>
    );
  }

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
