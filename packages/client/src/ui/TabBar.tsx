import { type CockpitTerminalInfo, resolveOrgColor } from "@zashiki/shared";
import { useTranslation } from "react-i18next";
import type { TitleMap } from "../lib/conversation-title.js";
import { type Tab, tabKey } from "../tabs/tab-model.js";
import { TabContextMenu } from "./TabContextMenu.js";
import { TabItem } from "./TabItem.js";
import { tabLabel } from "./tab-bar-model.js";
import { useTabContextMenu } from "./useTabContextMenu.js";
import { useTabDrag } from "./useTabDrag.js";
import { useTabRename } from "./useTabRename.js";
import { viewClass } from "./views.js";

export interface TabBarProps {
  tabs: readonly Tab[];
  /** Composite key of the active tab (`kind:id`). null if none. */
  activeKey: string | null;
  /** Session list used to resolve titles (for session tabs). */
  sessions: CockpitTerminalInfo[];
  /** Used to resolve manually edited titles. Resolves for all tabs. */
  conversationTitles: TitleMap;
  /** org -> display color (explicit color from repos.conf). Unspecified orgs fall back to auto coloring. */
  orgColors?: Record<string, string>;
  onActivate(key: string): void;
  onClose(key: string): void;
  /** Commits a double-click rename on a session tab. Commits with cockpitTerminalId + name. Rename is disabled when unspecified. */
  onRename?(cockpitTerminalId: string, name: string, title: string): void;
  /** Reordering via drag & drop. Moves fromKey to the position of toKey. Reordering is disabled when unspecified. */
  onReorder?(fromKey: string, toKey: string): void;
  /** Apply a faint overlay when inactive. */
  inactive?: boolean;
  /**
   * Right-clicking a session tab copies the resume command (`claude --resume <sid>`)
   * (for branched sessions). No context menu is shown when unspecified.
   */
  onCopyResume?(cockpitTerminalId: string): void;
  /**
   * Right-clicking a session tab copies the Claude Code session id (`sid`) verbatim.
   * The context menu appears when either this or onCopyResume is provided.
   */
  onCopySessionId?(cockpitTerminalId: string): void;
}

/**
 * Unified tab strip at the top of the main area. Shows open sessions/viewers
 * as side-by-side tabs; click to switch and the close button to close (does not kill the session).
 * org membership is shown by the leading color dot (no text). Session tabs
 * support inline rename on double-click (same commitTitle path as the conversation header).
 * The tab kind is distinguished by its icon. Renders nothing when empty (the caller shows the empty state).
 */
export function TabBar({
  tabs,
  activeKey,
  sessions,
  conversationTitles,
  orgColors = {},
  onActivate,
  onClose,
  onRename,
  onReorder,
  inactive,
  onCopyResume,
  onCopySessionId,
}: TabBarProps) {
  const { t } = useTranslation();
  const rename = useTabRename(tabs, sessions, onRename);
  const drag = useTabDrag(onReorder);
  const hasContextMenu =
    onCopyResume !== undefined || onCopySessionId !== undefined;
  const contextMenu = useTabContextMenu(
    (onCopyResume !== undefined ? 1 : 0) +
      (onCopySessionId !== undefined ? 1 : 0),
  );

  if (tabs.length === 0) return null;

  return (
    <div
      className={viewClass("tab-bar", inactive)}
      role="tablist"
      aria-label={t("tabBar.ariaLabel")}
    >
      {tabs.map((tab) => {
        const key = tabKey(tab);
        const { label, title } = tabLabel(tab, sessions, conversationTitles);
        const session =
          tab.kind === "session"
            ? sessions.find((x) => x.cockpitTerminalId === tab.id)
            : undefined;
        const orgColor =
          session !== undefined
            ? resolveOrgColor(session.org, orgColors)
            : undefined;
        return (
          <TabItem
            key={key}
            tab={tab}
            active={key === activeKey}
            label={label}
            title={title}
            session={session}
            orgColor={orgColor}
            reorderable={onReorder !== undefined}
            rename={rename}
            drag={drag}
            onActivate={onActivate}
            onClose={onClose}
            onContextMenu={
              session !== undefined && hasContextMenu
                ? (e) => contextMenu.openMenu(session, e)
                : undefined
            }
          />
        );
      })}
      {contextMenu.menu !== null && hasContextMenu && (
        <TabContextMenu
          menu={contextMenu.menu}
          sessions={sessions}
          closeMenu={contextMenu.closeMenu}
          onCopyResume={onCopyResume}
          onCopySessionId={onCopySessionId}
        />
      )}
    </div>
  );
}
