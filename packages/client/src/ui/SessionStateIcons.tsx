import type { CockpitTerminalInfo, SessionState } from "@zashiki/shared";
import { useTranslation } from "react-i18next";

// Material Symbols Outlined ligature names (the font is loaded in main.tsx; shared with the footer).
const STATE_ICONS: Record<SessionState, string> = {
  waiting_input: "add_alert",
  running: "hourglass",
  running_bg_agent: "hourglass",
  idle: "check",
  no_claude: "terminal_2",
  starting: "pending",
  unknown: "help",
};

const FRESH_ICON = "start";

// Activity-chip glyphs. These sit beside the state glyph as chips, not overlaid on it.
const BG_AGENT_GLYPH = "robot_2";
const SHELL_GLYPH = "terminal";

// Reaching the usage limit overlays this top-right badge on the state glyph. Orthogonal to the state.
const LIMIT_BADGE = "error";

/** Lifecycle-state glyph; background activity lives in ActivityChips, only the limit badge stays overlaid. */
export function StateIcon({
  session,
  fresh,
}: {
  session: CockpitTerminalInfo;
  fresh: boolean;
}) {
  const { t } = useTranslation();
  const stateClass = fresh ? "fresh" : session.state;
  const glyph = fresh ? FRESH_ICON : STATE_ICONS[session.state];
  const showLimited = session.limited === true;
  return (
    <span
      className={`state state-stack state-${stateClass}`}
      aria-hidden="true"
    >
      <span
        className={`material-symbols-outlined state-stack-glyph state-${stateClass}`}
      >
        {glyph}
      </span>
      {showLimited && (
        <span
          className="material-symbols-outlined state-stack-glyph state-limited-badge"
          title={t("sessionList.limitReached")}
        >
          {LIMIT_BADGE}
        </span>
      )}
    </span>
  );
}

/** Concurrent background activity as chips: agent follows running_bg_agent, shell follows shellsRunning; both are independent so both can show. */
export function ActivityChips({ session }: { session: CockpitTerminalInfo }) {
  const { t } = useTranslation();
  const showAgent = session.state === "running_bg_agent";
  const agentCount = session.runningSubagents ?? 0;
  const shellCount = session.shellsRunning ?? 0;
  return (
    <>
      {showAgent && (
        <span
          className="session-activity session-activity-agent"
          title={t("sessionList.subagentCountTitle")}
        >
          <span className="material-symbols-outlined session-activity-glyph">
            {BG_AGENT_GLYPH}
          </span>
          {agentCount > 0 && agentCount}
        </span>
      )}
      {shellCount > 0 && (
        <span
          className="session-activity session-activity-shell"
          title={t("sessionList.shellCountTitle")}
        >
          <span className="material-symbols-outlined session-activity-glyph">
            {SHELL_GLYPH}
          </span>
          {shellCount}
        </span>
      )}
    </>
  );
}
