import {
  DEFAULT_FOOTER_THRESHOLDS,
  type FooterThresholds,
  type SessionLink,
  type SessionUsage,
  type UsageBeforeCompaction,
} from "@zashiki/shared";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { distinctLinkCount } from "../session/session-links.js";
import {
  durationSeverity,
  fmtDuration,
  fmtModel,
  fmtTokens,
  tokenSeverity,
} from "../session/status-footer.js";
import { SessionLinksPopover } from "./SessionLinksPopover.js";
import { BG_AGENT_GLYPH } from "./SessionStateIcons.js";
import { StatusCell } from "./StatusCell.js";
import { Tooltip } from "./Tooltip.js";
import { useNow } from "./useNow.js";

export interface SessionStatusFooterProps {
  /** Transcript-derived tokens/elapsed. null before the session has a readable transcript (shows dashes). */
  usage: SessionUsage | null;
  /** Model id answering in this terminal. Independent of `usage`, so it shows before the first reply. */
  model?: string;
  /** org accent applied to the top border, matching the active session tab. */
  accentColor?: string;
  /** Configured severity thresholds driving each cell's color. Defaults to the built-in bands (isolated tests). */
  thresholds?: FooterThresholds;
  /** Whether the totals from before the last compaction are expanded (they are only offered once compacted). */
  beforeCompactionOpen?: boolean;
  onToggleBeforeCompaction?: () => void;
  /** The links the active Claude Session has seen, newest first. */
  links?: readonly SessionLink[];
  onCopyLink?: (url: string) => void;
  /** The image URL for a link's `faviconOrigin`; without it every other-site link shows the generic icon. */
  faviconUrl?: (origin: string) => string;
  /** Called once the links popover closes, to hand focus back to the terminal. */
  onLinksClosed?: () => void;
  /** Whether the links popover is showing, including closed when the footer itself goes away. */
  onLinksOpenChange?: (open: boolean) => void;
}

const DASH = "–";

/**
 * Status area docked under the terminal for the active session: tokens (this turn / this session /
 * its subagents), elapsed time (this turn / this session), and the button that opens its links.
 * Elapsed re-ticks each second off the server-provided epoch anchors.
 */
export function SessionStatusFooter({
  usage,
  model,
  accentColor,
  thresholds = DEFAULT_FOOTER_THRESHOLDS,
  beforeCompactionOpen = false,
  onToggleBeforeCompaction,
  links = [],
  onCopyLink = () => undefined,
  faviconUrl,
  onLinksClosed = () => undefined,
  onLinksOpenChange,
}: SessionStatusFooterProps) {
  const { t } = useTranslation();
  const now = useNow(1_000);
  const [linksOpen, setLinksOpen] = useState(false);
  useEffect(() => {
    if (!linksOpen || onLinksOpenChange === undefined) return;
    onLinksOpenChange(true);
    return () => onLinksOpenChange(false);
  }, [linksOpen, onLinksOpenChange]);
  const closeLinks = () => {
    setLinksOpen(false);
    onLinksClosed();
  };

  return (
    <div className="session-status-dock">
      {linksOpen && (
        <SessionLinksPopover
          links={links}
          faviconUrl={faviconUrl}
          onCopy={onCopyLink}
          onClose={closeLinks}
        />
      )}
      <footer
        className="session-status"
        style={accentColor ? { borderTopColor: accentColor } : undefined}
      >
        <Tooltip className="ss-group" label={t("footer.status.modelTitle")}>
          <span
            className="material-symbols-outlined ss-icon"
            aria-hidden="true"
          >
            neurology
          </span>
          <StatusCell
            value={model ? fmtModel(model) : DASH}
            caption={t("footer.status.model")}
          />
        </Tooltip>

        <Tooltip className="ss-group" label={t("footer.status.tokensTitle")}>
          <span
            className="material-symbols-outlined ss-icon"
            aria-hidden="true"
          >
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

        <Tooltip
          className="ss-group"
          label={t("footer.status.agentTokensTitle")}
        >
          <span
            className="material-symbols-outlined ss-icon"
            aria-hidden="true"
          >
            {BG_AGENT_GLYPH}
          </span>
          <StatusCell
            value={usage ? fmtTokens(usage.subagentTokens) : DASH}
            caption={t("footer.status.agents")}
          />
        </Tooltip>

        <Tooltip className="ss-group" label={t("footer.status.elapsedTitle")}>
          <span
            className="material-symbols-outlined ss-icon"
            aria-hidden="true"
          >
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

        {usage?.beforeCompaction && (
          <BeforeCompaction
            totals={usage.beforeCompaction}
            open={beforeCompactionOpen}
            onToggle={onToggleBeforeCompaction}
          />
        )}

        <Tooltip className="ss-group ss-links" label={t("footer.links.title")}>
          <button
            type="button"
            className="ss-links-button"
            aria-expanded={linksOpen}
            aria-label={t("footer.links.title")}
            onClick={() => (linksOpen ? closeLinks() : setLinksOpen(true))}
          >
            <span
              className="material-symbols-outlined ss-icon"
              aria-hidden="true"
            >
              link
            </span>
            <span className="ss-val">{distinctLinkCount(links)}</span>
          </button>
        </Tooltip>
      </footer>
    </div>
  );
}

function BeforeCompaction({
  totals,
  open,
  onToggle,
}: {
  totals: UsageBeforeCompaction;
  open: boolean;
  onToggle?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <span className="ss-before-compaction">
      <button
        type="button"
        className="ss-toggle"
        aria-expanded={open}
        aria-label={t(
          open
            ? "footer.status.hideBeforeCompaction"
            : "footer.status.showBeforeCompaction",
        )}
        onClick={onToggle}
      >
        <span className="material-symbols-outlined ss-icon" aria-hidden="true">
          history
        </span>
      </button>
      {open && (
        <Tooltip
          className="ss-group"
          label={t("footer.status.beforeCompactionTitle")}
        >
          <span className="ss-cap">{t("footer.status.beforeCompaction")}</span>
          <StatusCell
            value={fmtTokens(totals.sessionTokens)}
            caption={t("footer.status.session")}
          />
          <StatusCell
            value={fmtTokens(totals.subagentTokens)}
            caption={t("footer.status.agents")}
          />
          <span
            className="material-symbols-outlined ss-icon"
            aria-hidden="true"
          >
            schedule
          </span>
          <StatusCell
            value={fmtDuration(totals.elapsedMs)}
            caption={t("footer.status.session")}
          />
        </Tooltip>
      )}
    </span>
  );
}
