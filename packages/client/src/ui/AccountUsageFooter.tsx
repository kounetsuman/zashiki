import {
  DEFAULT_FOOTER_THRESHOLDS,
  type FooterThresholds,
  type UsageLimit,
  type UsageLimits,
} from "@zashiki/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  FIVE_HOUR_WINDOW_MS,
  fmtResetClock,
  fmtResetCountdown,
  fmtWeekResetCountdown,
  loadUsageTimeMode,
  nextUsageTimeMode,
  saveUsageTimeMode,
  usageDisplayMs,
  usageSeverity,
  WEEK_WINDOW_MS,
} from "../session/status-footer.js";
import { StatusCell } from "./StatusCell.js";
import { Tooltip } from "./Tooltip.js";
import { useNow } from "./useNow.js";

type StoragePart = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StoragePart | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

export interface AccountUsageFooterProps {
  /**
   * The server-reconciled account-wide usage reading (pre-corrected by clampFiveHourWhenLimited);
   * null until the statusLine bridge reports any.
   */
  limits: UsageLimits | null;
  /** Whether the account-usage bridge is opted in. When off, only the (clickable) icon is shown. */
  enabled: boolean;
  /** Open the opt-in modal (used only while opted out). */
  onRequestEnable(): void;
  /** Configured usage-percent severity thresholds. Defaults to the built-in bands (isolated tests). */
  thresholds?: FooterThresholds["usagePercent"];
  /** Persistence target for the elapsed/remaining time mode (defaults to localStorage; injectable for tests). */
  storage?: StoragePart | null;
}

const DASH = "–";

/**
 * Claude Code account usage — the current 5-hour session and the current week — pinned to the left of
 * the global status-bar, independent of the active tab. While opted out, only the gauge icon shows,
 * clickable to open the opt-in modal. While opted in, clicking the gauge flips every cell between the
 * remaining and elapsed time; each cell's meter tracks that time as a fraction of the
 * window, so the bar fills in elapsed mode and drains in remaining mode.
 */
export function AccountUsageFooter({
  limits,
  enabled,
  onRequestEnable,
  thresholds = DEFAULT_FOOTER_THRESHOLDS.usagePercent,
  storage = defaultStorage(),
}: AccountUsageFooterProps) {
  const { t } = useTranslation();
  const now = useNow(1_000);
  const [mode, setMode] = useState(() => loadUsageTimeMode(storage));

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

  const toggleMode = () =>
    setMode((prev) => {
      const next = nextUsageTimeMode(prev);
      saveUsageTimeMode(storage, next);
      return next;
    });

  const percentTimeKey =
    mode === "elapsed"
      ? "footer.status.percentElapsed"
      : "footer.status.percentRemaining";

  const cell = (
    limit: UsageLimit | undefined,
    label: string,
    title: string,
    windowMs: number,
    fmtCountdown: (ms: number) => string = fmtResetCountdown,
  ) => {
    const severity = limit
      ? usageSeverity(limit.usedPercent, thresholds)
      : undefined;
    const displayMs =
      limit?.resetsAt !== undefined
        ? usageDisplayMs(mode, limit.resetsAt, now, windowMs)
        : undefined;
    const value =
      limit === undefined
        ? DASH
        : displayMs !== undefined
          ? t(percentTimeKey, {
              percent: limit.usedPercent,
              time: fmtCountdown(displayMs),
            })
          : `${limit.usedPercent}%`;
    const meterPercent =
      displayMs !== undefined
        ? (displayMs / windowMs) * 100
        : (limit?.usedPercent ?? 0);
    const widest = t(percentTimeKey, {
      percent: 100,
      time: fmtCountdown(windowMs),
    });
    const tooltip =
      limit?.resetsAt !== undefined
        ? `${title} · ${t("footer.account.resetsAt", {
            time: fmtResetClock(limit.resetsAt, { now }),
          })}`
        : title;
    return (
      <Tooltip className="ss-group" label={tooltip}>
        <span className="account-usage-cell">
          <StatusCell
            value={
              <span className="account-usage-value">
                <span className="account-usage-value-sizer" aria-hidden="true">
                  {widest}
                </span>
                <span className="account-usage-value-live">{value}</span>
              </span>
            }
            caption={label}
            severity={severity}
          />
          {limit && (
            <span className="account-usage-meter" aria-hidden="true">
              <span
                className={
                  severity
                    ? `account-usage-meter-fill ss-${severity}`
                    : "account-usage-meter-fill"
                }
                style={{
                  width: `${Math.max(0, Math.min(100, meterPercent))}%`,
                }}
              />
            </span>
          )}
        </span>
      </Tooltip>
    );
  };

  const modeLabel = t(
    mode === "elapsed"
      ? "footer.account.modeElapsed"
      : "footer.account.modeRemaining",
  );

  return (
    <span className="account-usage">
      <button
        type="button"
        className="account-usage-mode"
        title={t("footer.account.modeToggleTitle", { mode: modeLabel })}
        aria-label={t("footer.account.modeToggleTitle", { mode: modeLabel })}
        aria-pressed={mode === "elapsed"}
        onClick={toggleMode}
      >
        <span className="material-symbols-outlined ss-icon" aria-hidden="true">
          speed
        </span>
      </button>
      {cell(
        limits?.fiveHour,
        t("footer.account.session"),
        t("footer.account.sessionTitle"),
        FIVE_HOUR_WINDOW_MS,
      )}
      {cell(
        limits?.week,
        t("footer.account.week"),
        t("footer.account.weekTitle"),
        WEEK_WINDOW_MS,
        fmtWeekResetCountdown,
      )}
    </span>
  );
}
