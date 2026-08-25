import {
  DEFAULT_FOOTER_THRESHOLDS,
  type FooterThresholds,
  type SessionUsage,
} from "@zashiki/shared";
import { useTranslation } from "react-i18next";

import {
  durationSeverity,
  fmtDuration,
  fmtTokens,
  tokenSeverity,
} from "../session/status-footer.js";
import { StatusCell } from "./StatusCell.js";
import { Tooltip } from "./Tooltip.js";
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
 * this session). Elapsed re-ticks each second off the server-provided epoch anchors.
 */
export function SessionStatusFooter({
  usage,
  accentColor,
  thresholds = DEFAULT_FOOTER_THRESHOLDS,
}: SessionStatusFooterProps) {
  const { t } = useTranslation();
  const now = useNow(1_000);

  return (
    <footer
      className="session-status"
      style={accentColor ? { borderTopColor: accentColor } : undefined}
    >
      <Tooltip className="ss-group" label={t("footer.status.tokensTitle")}>
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
      </Tooltip>

      <Tooltip className="ss-group" label={t("footer.status.elapsedTitle")}>
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
      </Tooltip>
    </footer>
  );
}
