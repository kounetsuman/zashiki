import {
  type CockpitTerminalInfo,
  resolveOrgColor,
  resolveOrgName,
} from "@zashiki/shared";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { TitleMap } from "../lib/conversation-title.js";
import { type Tab, tabKey } from "../tabs/tab-model.js";
import { TabContextMenu } from "./TabContextMenu.js";
import { TabItem } from "./TabItem.js";
import { tabLabel } from "./tab-bar-model.js";
import { useTabContextMenu } from "./useTabContextMenu.js";
import { useTabDrag } from "./useTabDrag.js";
import { useTabRename } from "./useTabRename.js";

export interface TabBarProps {
  tabs: readonly Tab[];
  /** Composite key of the active tab (`kind:id`). null if none. */
  activeKey: string | null;
  /** Session list used to resolve titles (for session tabs). */
  cockpitTerminals: CockpitTerminalInfo[];
  /** Used to resolve manually edited titles. Resolves for all tabs. */
  conversationTitles: TitleMap;
  /** org -> display color (explicit color from repos.conf). Unspecified orgs fall back to auto coloring. */
  orgColors?: Record<string, string>;
  /** org -> display alias (from repos.conf). Unspecified orgs are shown by their identity. */
  orgAliases?: Record<string, string>;
  onActivate(key: string): void;
  onClose(key: string): void;
  /** Closes every open tab. The "close all" menu item is hidden when unspecified. */
  onCloseAll?(): void;
  /** Commits a double-click rename on a session tab. Commits with cockpitTerminalId + name. Rename is disabled when unspecified. */
  onRename?(cockpitTerminalId: string, name: string, title: string): void;
  /** Reordering via drag & drop. Moves fromKey to the position of toKey. Reordering is disabled when unspecified. */
  onReorder?(fromKey: string, toKey: string): void;
  /**
   * Right-clicking a session tab duplicates it into a new independent cockpit terminal (forks the
   * Claude session). The duplicate menu item is hidden when unspecified.
   */
  onDuplicate?(cockpitTerminalId: string): void;
  /**
   * Right-clicking a session tab copies the Claude Code session id (`sid`) verbatim.
   * The copy menu item is hidden when unspecified.
   */
  onCopySessionId?(cockpitTerminalId: string): void;
  /** Reveal a viewer tab's file in the OS file manager. Menu item hidden when unspecified. */
  onRevealFile?(repoPath: string, relPath: string): void;
  /** Copy a viewer tab's absolute path. Menu item hidden when unspecified. */
  onCopyFilePath?(repoPath: string, relPath: string): void;
  /** Copy a viewer tab's repo-relative path. Menu item hidden when unspecified. */
  onCopyFileRelativePath?(repoPath: string, relPath: string): void;
  /** Commits an inline rename of a viewer tab's file. Rename is disabled when unspecified. */
  onRenameFile?(repoPath: string, relPath: string, newName: string): void;
}

/**
 * Unified tab strip at the top of the main area. Shows open cockpit terminals/viewers
 * as side-by-side tabs; click to switch and the close button to close (does not kill the session).
 * org membership is shown by the leading color dot (no text). Session tabs
 * support inline rename on double-click (same commitTitle path as the conversation header).
 * The tab kind is distinguished by its icon. Renders nothing when empty (the caller shows the empty state).
 */
export function TabBar({
  tabs,
  activeKey,
  cockpitTerminals,
  conversationTitles,
  orgColors = {},
  orgAliases = {},
  onActivate,
  onClose,
  onCloseAll,
  onRename,
  onReorder,
  onDuplicate,
  onCopySessionId,
  onRevealFile,
  onCopyFilePath,
  onCopyFileRelativePath,
  onRenameFile,
}: TabBarProps) {
  const { t } = useTranslation();
  const rename = useTabRename(tabs, cockpitTerminals, onRename, onRenameFile);
  const drag = useTabDrag(onReorder);
  const sessionMenuItems =
    (onDuplicate !== undefined ? 1 : 0) +
    (onCopySessionId !== undefined ? 1 : 0);
  const viewerMenuItems =
    (onRevealFile !== undefined ? 1 : 0) +
    (onCopyFilePath !== undefined ? 1 : 0) +
    (onCopyFileRelativePath !== undefined ? 1 : 0) +
    (onRenameFile !== undefined ? 1 : 0);
  const contextMenu = useTabContextMenu(
    1 +
      (onCloseAll !== undefined ? 1 : 0) +
      Math.max(sessionMenuItems, viewerMenuItems),
  );

  // Scroll the tab into view the moment it becomes active (ref fires on attach).
  const scrollActiveIntoView = useCallback((node: HTMLDivElement | null) => {
    node?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, []);

  if (tabs.length === 0) return null;

  // Draw the active tab's org color as a full-width line under the whole tab bar
  // (the boundary with the CockpitTerminal), so its org membership reads across the
  // entire width — not just under that one tab.
  const activeTab = tabs.find((tab) => tabKey(tab) === activeKey);
  const activeSession =
    activeTab?.kind === "session"
      ? cockpitTerminals.find((x) => x.cockpitTerminalId === activeTab.id)
      : undefined;
  const activeOrgColor =
    activeSession !== undefined
      ? resolveOrgColor(activeSession.org, orgColors)
      : undefined;

  return (
    <div
      className="tab-bar"
      role="tablist"
      aria-label={t("tabBar.ariaLabel")}
      style={
        activeOrgColor !== undefined
          ? { borderBottomColor: activeOrgColor }
          : undefined
      }
    >
      {tabs.map((tab) => {
        const key = tabKey(tab);
        const { label, title } = tabLabel(
          tab,
          cockpitTerminals,
          conversationTitles,
        );
        const session =
          tab.kind === "session"
            ? cockpitTerminals.find((x) => x.cockpitTerminalId === tab.id)
            : undefined;
        const orgColor =
          session !== undefined
            ? resolveOrgColor(session.org, orgColors)
            : undefined;
        const orgName =
          session !== undefined
            ? resolveOrgName(session.org, orgAliases)
            : undefined;
        return (
          <TabItem
            key={key}
            rootRef={key === activeKey ? scrollActiveIntoView : undefined}
            tab={tab}
            active={key === activeKey}
            label={label}
            title={title}
            session={session}
            orgColor={orgColor}
            orgName={orgName}
            reorderable={onReorder !== undefined}
            rename={rename}
            drag={drag}
            onActivate={onActivate}
            onClose={onClose}
            onContextMenu={(e) => contextMenu.openMenu(tab, e)}
          />
        );
      })}
      {contextMenu.menu !== null && (
        <TabContextMenu
          menu={contextMenu.menu}
          cockpitTerminals={cockpitTerminals}
          closeMenu={contextMenu.closeMenu}
          onClose={onClose}
          onCloseAll={onCloseAll}
          onDuplicate={onDuplicate}
          onCopySessionId={onCopySessionId}
          onReveal={
            onRevealFile === undefined
              ? undefined
              : (f) => onRevealFile(f.repoPath, f.relPath)
          }
          onCopyPath={
            onCopyFilePath === undefined
              ? undefined
              : (f) => onCopyFilePath(f.repoPath, f.relPath)
          }
          onCopyRelativePath={
            onCopyFileRelativePath === undefined
              ? undefined
              : (f) => onCopyFileRelativePath(f.repoPath, f.relPath)
          }
          onRename={
            onRenameFile === undefined
              ? undefined
              : (key, f) =>
                  rename.startFileEdit(
                    key,
                    f.repoPath,
                    f.relPath,
                    f.relPath.split("/").pop() ?? f.relPath,
                  )
          }
        />
      )}
    </div>
  );
}
