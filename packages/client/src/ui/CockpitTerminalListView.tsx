import { type CockpitTerminalInfo, resolveOrgColor } from "@zashiki/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TitleMap } from "../lib/conversation-title.js";
import { RefreshButton } from "./RefreshButton.js";
import { ReposConfGuide } from "./ReposConfGuide.js";
import { SessionContextMenu } from "./SessionContextMenu.js";
import { SessionRow } from "./SessionRow.js";
import { displayOrgs, focusKey } from "./session-list-model.js";
import { useConfirmClose } from "./useConfirmClose.js";
import { useRowRename } from "./useRowRename.js";
import { useSessionContextMenu } from "./useSessionContextMenu.js";
import { useSessionListFocus } from "./useSessionListFocus.js";
import { useSessionRefresh } from "./useSessionRefresh.js";
import { ViewHeader } from "./ViewHeader.js";
import { viewClass } from "./views.js";

export interface CockpitTerminalListViewProps {
  cockpitTerminals: CockpitTerminalInfo[];
  /** All orgs from repos.conf + detected orgs (in display order; not removed even at (0)). */
  orgs: string[];
  /** org name -> display color (as noted in repos.conf). Unspecified orgs use the default color (white). */
  orgColors?: Record<string, string>;
  selectedCockpitTerminalId: string | null;
  onSelect(cockpitTerminalId: string): void;
  onNew(org: string): void;
  onClose(cockpitTerminalId: string): void;
  /**
   * Manual refresh. Returning a Promise reflects the spinner while fetching and then
   * success/error in the header icon (the App side sends state.refresh and resolves on
   * receiving state.sync; rejects on disconnect/timeout). A void (synchronous) return
   * shows no status.
   */
  onRefresh(): void | Promise<void>;
  /** Open the "add org" modal (the header + button). Omit to hide the button. */
  onAddOrg?(): void;
  /**
   * Move focus to the terminal on a row double-click/Enter. Also called when double-clicking
   * the currently shown row (onSelect is not re-sent, but focus is returned to the terminal).
   */
  onFocusTerminal?(): void;
  /**
   * Manually edited titles from the conversation header (cockpitTerminalId -> title). Reflected in the
   * row display so header renames are mirrored into SESSION LIST immediately. Defaults to empty.
   */
  conversationTitles?: TitleMap;
  /**
   * Whether the control WS is connected (default true). When disconnected, the repos.conf
   * guidance is not shown (it would be misleading if the 0-org state is actually caused by the disconnect).
   */
  connected?: boolean;
  /** Apply a faint overlay when inactive. */
  inactive?: boolean;
  /** Render at full height (height:100%) when the bottom view is closed. */
  full?: boolean;
  /**
   * Copy the target session's resume command (`claude --resume <sid>`) to the clipboard
   * (for branched cockpit terminals). If omitted, the item is not shown in the row menu.
   */
  onCopyResume?(cockpitTerminalId: string): void;
  /**
   * Copy the target session's Claude Code session id (`sid`) to the clipboard verbatim.
   * If omitted, the item is not shown in the row menu.
   */
  onCopySessionId?(cockpitTerminalId: string): void;
  /**
   * Inline-rename a row's title via the right-click "Rename" and commit it. Passes cockpitTerminalId + name +
   * value through the same commitTitle path as tab renaming. If omitted, Rename is not shown in the
   * row menu. Non-UUID windows (unbound/plain-shell) cannot be renamed since commitTitle is a no-op.
   */
  onRename?(cockpitTerminalId: string, name: string, title: string): void;
}

/**
 * Session list view. Collapsible org groups + state-icon rows.
 * ↑↓ moves flatly across org header rows and their child rows (a collapsed org skips only its
 * child rows), and Enter toggles collapse on an org header or switches the terminal on a session
 * row. Double-click also switches. New/close are handled via the right-click menu (org area -> new,
 * row -> Delete closes immediately) plus keybindings (Ctrl-N/X). Ctrl-X goes through an inline
 * confirmation that does not depend on the native dialog.
 */
export function CockpitTerminalListView({
  cockpitTerminals,
  orgs,
  orgColors = {},
  selectedCockpitTerminalId,
  onSelect,
  onNew,
  onClose,
  onRefresh,
  onAddOrg,
  onFocusTerminal,
  conversationTitles = {},
  connected = true,
  inactive,
  full,
  onCopyResume,
  onCopySessionId,
  onRename,
}: CockpitTerminalListViewProps) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const orgList = displayOrgs(orgs, cockpitTerminals);

  const refresh = useSessionRefresh(onRefresh);
  // The row menu has at most 4 items: Delete + (when provided) Rename + Copy resume + Copy session id.
  const rowItemCount =
    1 +
    (onRename !== undefined ? 1 : 0) +
    (onCopyResume !== undefined ? 1 : 0) +
    (onCopySessionId !== undefined ? 1 : 0);
  const { menu, openOrgMenu, openRowMenu, closeMenu } =
    useSessionContextMenu(rowItemCount);
  const rename = useRowRename(cockpitTerminals, conversationTitles, onRename);
  const { confirmingClose, requestClose, confirmClose, cancelClose } =
    useConfirmClose(cockpitTerminals, onClose);
  const { focused, setFocused, focusedRef, visibleKeys, moveFocus } =
    useSessionListFocus(
      orgList,
      cockpitTerminals,
      collapsed,
      selectedCockpitTerminalId,
    );

  const toggleOrg = (org: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(org)) next.delete(org);
      else next.add(org);
      return next;
    });
  };

  const selected =
    cockpitTerminals.find(
      (s) => s.cockpitTerminalId === selectedCockpitTerminalId,
    ) ?? null;

  // Terminal switch (double-click/Enter). Once committed, collapse the focus ring (delegated to the selection highlight).
  // Re-selecting the currently shown row is idempotent, but onSelect is not called to avoid side effects
  // (re-attach, etc.); focus is still returned to the terminal (ending the wrong behavior where the list stays active).
  const select = (cockpitTerminalId: string): void => {
    setFocused(null);
    if (cockpitTerminalId !== selectedCockpitTerminalId)
      onSelect(cockpitTerminalId);
    onFocusTerminal?.();
  };

  // A single click on a row just applies the focus ring (expansion is via double-click/Enter).
  // Re-clicking the already selected (shown) row is meaningless, so it's a no-op (focus doesn't move either).
  const focusRow = (cockpitTerminalId: string): void => {
    if (cockpitTerminalId === selectedCockpitTerminalId) return;
    setFocused({ kind: "row", cockpitTerminalId });
  };

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    // While inline-renaming, stop the list keybindings (↑↓, Enter, Ctrl-N/X)
    // (don't hijack the input's key handling; commit/cancel are handled on the input side).
    if (rename.renaming !== null) return;
    if (e.metaKey || e.altKey) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveFocus(1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      moveFocus(-1);
      return;
    }
    if (e.key === "Enter") {
      // Don't use the Enter that confirms IME conversion for selection (same convention as the git view's ⌘Enter).
      if (e.nativeEvent.isComposing) return;
      if (focused !== null && visibleKeys.includes(focusKey(focused))) {
        // An org header toggles collapse; a session row opens the terminal. On an org header,
        // the native button's Enter also fires onClick. When the real DOM focus is on that button
        // (e.target != aside), delegate to the native click to avoid a double toggle (open then close immediately).
        // Since the toggle is a flip operation, a double call is fatal. Row select is idempotent, so it's handled together as before.
        if (focused.kind === "org") {
          if (e.target === e.currentTarget) {
            e.preventDefault();
            toggleOrg(focused.org);
          }
        } else {
          e.preventDefault();
          select(focused.cockpitTerminalId);
        }
      }
      return;
    }
    if (!e.ctrlKey) return;
    if (e.key === "n") {
      e.preventDefault();
      const org = selected?.org ?? orgList[0];
      if (org !== undefined) onNew(org);
    } else if (e.key === "x") {
      e.preventDefault();
      if (selected) requestClose(selected.cockpitTerminalId);
    }
  };

  return (
    <aside
      className={`${viewClass("session-list", inactive)}${
        full ? " session-list-full" : ""
      }`}
      data-view="sessions"
      aria-label={t("sessionList.ariaLabel")}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: receiver for the keybindings (Ctrl-N/X) when the view is focused
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <ViewHeader title="SESSION LIST">
        <div className="view-header-actions">
          {onAddOrg !== undefined && (
            <button
              type="button"
              className="session-list-add"
              aria-label={t("sessionList.addOrg")}
              title={t("sessionList.addOrg")}
              onClick={onAddOrg}
            >
              <span className="material-symbols-outlined" aria-hidden="true">
                add
              </span>
            </button>
          )}
          <RefreshButton
            state={refresh.state}
            label={t("sessionList.refreshLabel")}
            error={refresh.error}
            onClick={refresh.refresh}
          />
        </div>
      </ViewHeader>
      {/* Like other views, keep the header fixed and let the inner container handle scrolling. */}
      <div className="session-list-scroll">
        {connected && orgList.length === 0 && <ReposConfGuide />}
        {orgList.map((org) => {
          const orgSessions = cockpitTerminals.filter((s) => s.org === org);
          const isCollapsed = collapsed.has(org);
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: right-click menu for the org area (keyboard is covered by Ctrl-N)
            <section
              key={org}
              className="session-org"
              onContextMenu={openOrgMenu(org)}
            >
              <div className="session-org-header">
                <button
                  type="button"
                  ref={
                    focused?.kind === "org" && focused.org === org
                      ? focusedRef
                      : undefined
                  }
                  className={`session-org-toggle${
                    focused?.kind === "org" && focused.org === org
                      ? " session-org-focused"
                      : ""
                  }`}
                  style={{ color: resolveOrgColor(org, orgColors) }}
                  aria-expanded={!isCollapsed}
                  onClick={() => {
                    setFocused({ kind: "org", org });
                    toggleOrg(org);
                  }}
                  title={t("sessionList.orgToggleTitle", { org })}
                >
                  <span
                    className="view-arrow material-symbols-outlined"
                    aria-hidden="true"
                  >
                    {isCollapsed ? "chevron_right" : "expand_more"}
                  </span>{" "}
                  <span className="session-org-label">
                    {org} ({orgSessions.length})
                  </span>
                </button>
                <button
                  type="button"
                  className="session-org-new"
                  aria-label={t("sessionList.newSessionInOrg", { org })}
                  title={t("sessionList.newSessionInOrg", { org })}
                  onClick={(e) => {
                    e.stopPropagation();
                    onNew(org);
                  }}
                >
                  <span
                    className="material-symbols-outlined"
                    aria-hidden="true"
                  >
                    add
                  </span>
                </button>
              </div>
              {!isCollapsed &&
                orgSessions.map((s) => (
                  <SessionRow
                    key={s.cockpitTerminalId}
                    session={s}
                    orgColors={orgColors}
                    conversationTitles={conversationTitles}
                    selectedCockpitTerminalId={selectedCockpitTerminalId}
                    isFocused={
                      focused?.kind === "row" &&
                      focused.cockpitTerminalId === s.cockpitTerminalId
                    }
                    focusedRef={focusedRef}
                    isRenaming={
                      rename.renaming?.cockpitTerminalId === s.cockpitTerminalId
                    }
                    renameDraft={rename.renameDraft}
                    renameInputRef={rename.renameInputRef}
                    confirming={confirmingClose === s.cockpitTerminalId}
                    onContextMenu={openRowMenu(s)}
                    onSetRenameDraft={rename.setRenameDraft}
                    onCommitRename={rename.commitRename}
                    onCancelRename={rename.cancelRename}
                    onFocusRow={focusRow}
                    onSelect={select}
                    onClose={onClose}
                    onConfirmClose={confirmClose}
                    onCancelConfirm={cancelClose}
                  />
                ))}
            </section>
          );
        })}
      </div>
      {menu !== null && (
        <SessionContextMenu
          menu={menu}
          cockpitTerminals={cockpitTerminals}
          onNew={onNew}
          onClose={onClose}
          isRenamable={rename.isRenamable}
          startRename={rename.startRename}
          closeMenu={closeMenu}
          onRename={onRename}
          onCopyResume={onCopyResume}
          onCopySessionId={onCopySessionId}
        />
      )}
    </aside>
  );
}
