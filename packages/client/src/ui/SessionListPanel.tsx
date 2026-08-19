import type { SessionInfo, SessionState } from "@zashiki/shared";
import {
  claudeSessionId,
  isUuidSid,
  resolveOrgColor,
  resumeCommand,
} from "@zashiki/shared";
import { useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";

import {
  effectiveCustomTitle,
  resolveTitle,
  type TitleMap,
} from "../lib/conversation-title.js";
import { PanelHeader } from "./PanelHeader.js";
import { clampMenuPos, panelClass } from "./panels.js";
import { RefreshButton, type RefreshState } from "./RefreshButton.js";

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

// While a subagent is running (running_bg_agent), overlay this bottom-right badge on the main icon.
const BG_AGENT_BADGE = "robot_2";

// Bottom-right badge for a persistent background shell. Shares the corner with robot_2, which
// running_bg_agent wins, so the two never overlap.
const SHELL_BADGE = "terminal";

// Reaching the usage limit adds this top-right badge overlaid on the main state. Orthogonal to the main state (shown for any state).
const LIMIT_BADGE = "error";

/**
 * Zero conversation history (idle with no title) = a new/unused session.
 * A row given a manual title is no longer "unused", so it drops the fresh treatment.
 */
function isFresh(s: SessionInfo, custom: string | undefined): boolean {
  return s.state === "idle" && s.title === null && custom === undefined;
}

/**
 * Session state icon. The bottom-right corner shows robot_2 for a subagent or the shell prompt badge
 * for a background shell (subagent wins). An otherwise idle/fresh row with a shell takes the hourglass
 * so the badge sits on a running-style glyph.
 */
function StateIcon({
  session,
  fresh,
}: {
  session: SessionInfo;
  fresh: boolean;
}) {
  const { t } = useTranslation();
  const showAgent = session.state === "running_bg_agent";
  const showShell = !showAgent && (session.shellsRunning ?? 0) > 0;
  const showLimited = session.limited === true;
  const shellHourglass = showShell && (fresh || session.state === "idle");
  const stateClass = shellHourglass
    ? "running"
    : fresh
      ? "fresh"
      : session.state;
  const glyph = shellHourglass
    ? STATE_ICONS.running
    : fresh
      ? FRESH_ICON
      : STATE_ICONS[session.state];
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
      {showAgent && (
        <span className="material-symbols-outlined state-stack-glyph state-bg-agent-badge">
          {BG_AGENT_BADGE}
        </span>
      )}
      {showShell && (
        <span className="material-symbols-outlined state-stack-glyph state-shell-badge">
          {SHELL_BADGE}
        </span>
      )}
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

export interface SessionListPanelProps {
  sessions: SessionInfo[];
  /** All orgs from repos.conf + detected orgs (in display order; not removed even at (0)). */
  orgs: string[];
  /** org name -> display color (as noted in repos.conf). Unspecified orgs use the default color (white). */
  orgColors?: Record<string, string>;
  selectedWindowId: string | null;
  onSelect(windowId: string): void;
  onNew(org: string): void;
  onClose(windowId: string): void;
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
   * Manually edited titles from the conversation header (windowId -> title). Reflected in the
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
  /** Render at full height (height:100%) when the bottom panel is closed. */
  full?: boolean;
  /**
   * Copy the target session's resume command (`claude --resume <sid>`) to the clipboard
   * (for branched sessions). If omitted, the item is not shown in the row menu.
   */
  onCopyResume?(windowId: string): void;
  /**
   * Copy the target session's Claude Code session id (`sid`) to the clipboard verbatim.
   * If omitted, the item is not shown in the row menu.
   */
  onCopySessionId?(windowId: string): void;
  /**
   * Inline-rename a row's title via the right-click "Rename" and commit it. Passes windowId + name +
   * value through the same commitTitle path as tab renaming. If omitted, Rename is not shown in the
   * row menu. Non-UUID windows (unbound/plain-shell) cannot be renamed since commitTitle is a no-op.
   */
  onRename?(windowId: string, name: string, title: string): void;
}

/** Preserve the order of orgs while appending detected orgs not in orgs at the end. */
function displayOrgs(orgs: string[], sessions: SessionInfo[]): string[] {
  const result = [...orgs];
  const seen = new Set(orgs);
  for (const s of sessions) {
    if (seen.has(s.org)) continue;
    seen.add(s.org);
    result.push(s.org);
  }
  return result;
}

/** First-launch guidance when repos.conf is missing/empty (0 orgs). */
function ReposConfGuide() {
  const { t } = useTranslation();
  return (
    <div className="session-empty-guide">
      <p>{t("sessionList.reposConf.notConfigured")}</p>
      <p>
        <Trans
          i18nKey="sessionList.reposConf.create"
          components={{ code: <code /> }}
        />
      </p>
      <pre>
        {[
          t("sessionList.reposConf.exampleComment"),
          "/Users/you/workspace/org1/repo-a   #7aa2f7",
          "/Users/you/workspace/org2/repo-b",
        ].join("\n")}
      </pre>
      <p>{t("sessionList.reposConf.afterCreate")}</p>
      <p>{t("sessionList.reposConf.seeHelp")}</p>
    </div>
  );
}

/** Target of the right-click menu (an org area or a session row). */
type ContextMenu =
  | { kind: "org"; org: string; x: number; y: number }
  | { kind: "row"; windowId: string; name: string; x: number; y: number };

/** Target of ↑↓ focus = an org header row or a session row (treated as one flat sequence). */
type FocusTarget =
  | { kind: "org"; org: string }
  | { kind: "row"; windowId: string };

/** Unique key used for equality checks, the visible-set key, and effect deps (the prefix separates the kind). */
function focusKey(t: FocusTarget): string {
  return t.kind === "org" ? `o:${t.org}` : `r:${t.windowId}`;
}

/**
 * Session list panel. Collapsible org groups + state-icon rows.
 * ↑↓ moves flatly across org header rows and their child rows (a collapsed org skips only its
 * child rows), and Enter toggles collapse on an org header or switches the terminal on a session
 * row. Double-click also switches. New/close are handled via the right-click menu (org area -> new,
 * row -> Delete closes immediately) plus keybindings (Ctrl-N/X). Ctrl-X goes through an inline
 * confirmation that does not depend on the native dialog.
 */
export function SessionListPanel({
  sessions,
  orgs,
  orgColors = {},
  selectedWindowId,
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
}: SessionListPanelProps) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [refreshState, setRefreshState] = useState<RefreshState>("idle");
  const [refreshError, setRefreshError] = useState<string | null>(null);
  // Target of the inline confirmation (because window.confirm is unresponsive in the Tauri WKWebView).
  const [confirmingClose, setConfirmingClose] = useState<string | null>(null);
  const [menu, setMenu] = useState<ContextMenu | null>(null);
  // The row currently being inline-renamed (remembers the windowId/name from when it started, so that
  // on commit it is not mis-committed to a different window, and matches to abort editing on prune; same convention as tab renaming).
  const [renaming, setRenaming] = useState<{
    windowId: string;
    name: string;
  } | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  // Guard that prevents double firing of commit/cancel (stops the unmount blur after an Escape cancel from mis-committing the stale draft).
  const renameDoneRef = useRef(false);
  // The ↑↓ focus ring (separate from selection = terminal switching; committed with Enter). Org header
  // rows are also included as targets and moved through flatly.
  const [focused, setFocused] = useState<FocusTarget | null>(null);
  const focusedRef = useRef<HTMLButtonElement | null>(null);
  const orgList = displayOrgs(orgs, sessions);

  // Flatten the ↑↓ move targets = org header rows + their visible session rows (a collapsed org
  // excludes only its child rows; the header row is always a target) into display order.
  const visibleItems: FocusTarget[] = [];
  for (const org of orgList) {
    visibleItems.push({ kind: "org", org });
    if (collapsed.has(org)) continue;
    for (const s of sessions)
      if (s.org === org)
        visibleItems.push({ kind: "row", windowId: s.windowId });
  }
  const visibleKeys = visibleItems.map(focusKey);
  // The array is regenerated every render and can't be used as an effect dep, so hold a stable (string) representation.
  // Use a control character that never appears in org names/windowIds as the separator to avoid key-boundary collisions.
  const visibleKey = visibleKeys.join("\x1f");

  const openOrgMenu =
    (org: string) =>
    (e: React.MouseEvent): void => {
      e.preventDefault();
      const { x, y } = clampMenuPos(e.clientX, e.clientY);
      setMenu({ kind: "org", org, x, y });
    };

  const openRowMenu =
    (s: SessionInfo) =>
    (e: React.MouseEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      // The row menu has at most 4 items: Delete + (when provided) Rename + Copy session (resume) + Copy session id.
      const itemCount =
        1 +
        (onRename !== undefined ? 1 : 0) +
        (onCopyResume !== undefined ? 1 : 0) +
        (onCopySessionId !== undefined ? 1 : 0);
      const { x, y } = clampMenuPos(e.clientX, e.clientY, itemCount);
      setMenu({ kind: "row", windowId: s.windowId, name: s.name, x, y });
    };

  const closeMenu = (): void => setMenu(null);

  useEffect(() => {
    if (menu === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);

  useEffect(() => {
    if (renaming !== null) renameInputRef.current?.focus();
  }, [renaming]);

  // Clear the confirmation state when the target session disappears (removal via another client/CLI, or refresh).
  useEffect(() => {
    if (confirmingClose === null) return;
    if (!sessions.some((s) => s.windowId === confirmingClose))
      setConfirmingClose(null);
  }, [sessions, confirmingClose]);

  // Clear the ring when the focus target is no longer visible (row removal/collapse, detected orgs
  // vanishing, etc. Org headers listed in repos.conf are always present, but a detected org drops out
  // of orgList once its last row disappears). This prevents accidentally selecting an invisible row via
  // Enter (visibility is also double-checked on the Enter side).
  // biome-ignore lint/correctness/useExhaustiveDependencies: visibleKey is the stable representation of the visible set (visibleKeys is regenerated every render)
  useEffect(() => {
    if (focused !== null && !visibleKeys.includes(focusKey(focused)))
      setFocused(null);
  }, [visibleKey, focused]);

  // Scroll the ring into view on focus movement (so it isn't cut off in a long list).
  useEffect(() => {
    if (focused !== null)
      focusedRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [focused]);

  // Generation number so that rapid clicks don't let a stale resolution roll back a newer fetch's display.
  const refreshGen = useRef(0);
  const refresh = (): void => {
    const result = onRefresh();
    // A synchronous (void) onRefresh shows no status (fire-and-forget compatibility).
    if (result === undefined) return;
    refreshGen.current += 1;
    const gen = refreshGen.current;
    setRefreshState("loading");
    result.then(
      () => {
        if (gen !== refreshGen.current) return;
        setRefreshState("idle");
        setRefreshError(null);
      },
      (err: unknown) => {
        if (gen !== refreshGen.current) return;
        setRefreshState("error");
        setRefreshError(String(err));
      },
    );
  };

  const toggleOrg = (org: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(org)) next.delete(org);
      else next.add(org);
      return next;
    });
  };

  const selected =
    sessions.find((s) => s.windowId === selectedWindowId) ?? null;

  const confirmClose = (windowId: string): void => {
    setConfirmingClose(null);
    onClose(windowId);
  };

  // Terminal switch (double-click/Enter). Once committed, collapse the focus ring (delegated to the selection highlight).
  // Re-selecting the currently shown row is idempotent, but onSelect is not called to avoid side effects
  // (re-attach, etc.); focus is still returned to the terminal (ending the wrong behavior where the list stays active).
  const select = (windowId: string): void => {
    setFocused(null);
    if (windowId !== selectedWindowId) onSelect(windowId);
    onFocusTerminal?.();
  };

  // Abort editing if the row being edited disappears via prune (the mis-commit of the stale draft via
  // unmount blur is sealed off by renameDoneRef. Adjusting state during render is the React-recommended
  // pattern. Same convention as tab renaming).
  if (renaming !== null) {
    const s = sessions.find((x) => x.windowId === renaming.windowId);
    if (s === undefined) {
      renameDoneRef.current = true;
      setRenaming(null);
    }
  }

  // Don't accept renames for non-UUID windows (unbound/plain-shell) (commitTitle would be a no-op and the
  // input would just vanish, so don't let editing start at all. Same convention as tab renaming).
  const isRenamable = (s: SessionInfo): boolean =>
    onRename !== undefined && isUuidSid(s.windowId);

  const startRename = (s: SessionInfo): void => {
    if (!isRenamable(s)) return;
    renameDoneRef.current = false;
    setRenameDraft(
      resolveTitle(effectiveCustomTitle(conversationTitles, s), s),
    );
    setRenaming({ windowId: s.windowId, name: s.name });
  };

  const commitRename = (): void => {
    if (renameDoneRef.current || renaming === null) return;
    renameDoneRef.current = true;
    onRename?.(renaming.windowId, renaming.name, renameDraft);
    setRenaming(null);
  };

  const cancelRename = (): void => {
    renameDoneRef.current = true;
    setRenaming(null);
  };

  // A single click on a row just applies the focus ring (expansion is via double-click/Enter).
  // Re-clicking the already selected (shown) row is meaningless, so it's a no-op (focus doesn't move either).
  const focusRow = (windowId: string): void => {
    if (windowId === selectedWindowId) return;
    setFocused({ kind: "row", windowId });
  };

  const moveFocus = (delta: number): void => {
    if (visibleItems.length === 0) return;
    // anchor: currently focused -> the visible selected row -> if the selected row is collapsed, its org header.
    let anchorKey: string | null = null;
    if (focused !== null) anchorKey = focusKey(focused);
    else if (selectedWindowId !== null) {
      const rowKey = focusKey({ kind: "row", windowId: selectedWindowId });
      if (visibleKeys.includes(rowKey)) anchorKey = rowKey;
      else {
        const sel = sessions.find((s) => s.windowId === selectedWindowId);
        if (sel !== undefined)
          anchorKey = focusKey({ kind: "org", org: sel.org });
      }
    }
    const cur = anchorKey === null ? -1 : visibleKeys.indexOf(anchorKey);
    const next =
      cur === -1
        ? delta > 0
          ? 0
          : visibleItems.length - 1
        : Math.min(visibleItems.length - 1, Math.max(0, cur + delta));
    setFocused(visibleItems[next] ?? null);
  };

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    // While inline-renaming, stop the list keybindings (↑↓, Enter, Ctrl-N/X)
    // (don't hijack the input's key handling; commit/cancel are handled on the input side).
    if (renaming !== null) return;
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
      // Don't use the Enter that confirms IME conversion for selection (same convention as the git panel's ⌘Enter).
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
          select(focused.windowId);
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
      if (selected) setConfirmingClose(selected.windowId);
    }
  };

  return (
    <aside
      className={`${panelClass("session-list", inactive)}${
        full ? " session-list-full" : ""
      }`}
      data-panel="sessions"
      aria-label={t("sessionList.ariaLabel")}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: receiver for the keybindings (Ctrl-N/X) when the panel is focused
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <PanelHeader title="SESSION LIST">
        <div className="panel-header-actions">
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
            state={refreshState}
            label={t("sessionList.refreshLabel")}
            error={refreshError}
            onClick={refresh}
          />
        </div>
      </PanelHeader>
      {/* Like other panels, keep the header fixed and let the inner container handle scrolling. */}
      <div className="session-list-scroll">
        {connected && orgList.length === 0 && <ReposConfGuide />}
        {orgList.map((org) => {
          const orgSessions = sessions.filter((s) => s.org === org);
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
                    className="panel-arrow material-symbols-outlined"
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
                orgSessions.map((s) => {
                  // Prefer the manual title (header rename); fall back to the automatic title if none.
                  const custom = effectiveCustomTitle(conversationTitles, s);
                  const summaryTitle = custom ?? s.title;
                  // Visible label. Falls back to the window name (= org name for owned sessions)
                  // via resolveTitle, the same fallback the tab uses, so an unresolved title
                  // (e.g. right after resume, before the summary is computed) shows the org name
                  // rather than a blank row.
                  const displayTitle = resolveTitle(custom, s);
                  const fresh = isFresh(s, custom);
                  const isRenaming = renaming?.windowId === s.windowId;
                  return (
                    // biome-ignore lint/a11y/noStaticElementInteractions: right-click menu for the row (keyboard is covered by Ctrl-X)
                    <div
                      key={s.windowId}
                      className="session-row"
                      onContextMenu={openRowMenu(s)}
                    >
                      {isRenaming ? (
                        <div className="panel-row session-row-main session-row-editing">
                          <StateIcon session={s} fresh={fresh} />
                          <input
                            ref={renameInputRef}
                            className="session-title-input"
                            aria-label={t("sessionList.editTitleLabel")}
                            maxLength={200}
                            value={renameDraft}
                            onChange={(e) => setRenameDraft(e.target.value)}
                            onBlur={commitRename}
                            onKeyDown={(e) => {
                              if (
                                e.key === "Enter" &&
                                !e.nativeEvent.isComposing
                              ) {
                                e.preventDefault();
                                e.stopPropagation();
                                commitRename();
                              } else if (e.key === "Escape") {
                                e.preventDefault();
                                e.stopPropagation();
                                cancelRename();
                              }
                            }}
                          />
                        </div>
                      ) : (
                        <>
                          <button
                            type="button"
                            ref={
                              focused?.kind === "row" &&
                              focused.windowId === s.windowId
                                ? focusedRef
                                : undefined
                            }
                            className={`panel-row panel-row-hover session-row-main${
                              s.active ? " session-row-active" : ""
                            }${
                              focused?.kind === "row" &&
                              focused.windowId === s.windowId
                                ? " session-row-focused"
                                : ""
                            }`}
                            aria-current={
                              s.windowId === selectedWindowId
                                ? "true"
                                : undefined
                            }
                            // Keep the window name in aria-label for row identification and a11y.
                            // Pair it with the summary only when one exists; the visible label may
                            // fall back to the name, but the aria-label must not repeat it.
                            aria-label={
                              summaryTitle !== null
                                ? `${s.name} ${summaryTitle}`
                                : s.name
                            }
                            // Expand via double-click/Enter. A single click is the focus ring only (to prevent accidental triggering).
                            title={t("sessionList.openHint")}
                            onClick={() => focusRow(s.windowId)}
                            onDoubleClick={() => select(s.windowId)}
                          >
                            <StateIcon session={s} fresh={fresh} />
                            {s.state === "running_bg_agent" &&
                              (s.runningSubagents ?? 0) > 0 && (
                                <span
                                  className="session-bg-count"
                                  title={t("sessionList.subagentCountTitle")}
                                >
                                  (+{s.runningSubagents ?? 0})
                                </span>
                              )}
                            {s.state !== "running_bg_agent" &&
                              (s.shellsRunning ?? 0) > 1 && (
                                <span
                                  className="session-shell-count"
                                  title={t("sessionList.shellCountTitle")}
                                >
                                  (+{s.shellsRunning ?? 0})
                                </span>
                              )}
                            <span className="session-title">
                              {" "}
                              {displayTitle}
                            </span>
                          </button>
                          <button
                            type="button"
                            className="session-row-close"
                            aria-label={t("sessionList.closeRow", {
                              name: s.name,
                            })}
                            title={t("common.close")}
                            onClick={(e) => {
                              e.stopPropagation();
                              onClose(s.windowId);
                            }}
                          >
                            <span
                              className="material-symbols-outlined"
                              aria-hidden="true"
                            >
                              delete
                            </span>
                          </button>
                          {confirmingClose === s.windowId && (
                            <span className="session-row-confirm">
                              <button
                                type="button"
                                className="session-confirm-ok"
                                aria-label={t("sessionList.closeRowConfirm", {
                                  name: s.name,
                                })}
                                title={t("common.close")}
                                onClick={() => confirmClose(s.windowId)}
                              >
                                {t("common.close")}
                              </button>
                              <button
                                type="button"
                                className="session-confirm-cancel"
                                aria-label={t("sessionList.cancelClose")}
                                title={t("common.cancel")}
                                onClick={() => setConfirmingClose(null)}
                              >
                                {t("common.cancel")}
                              </button>
                            </span>
                          )}
                        </>
                      )}
                    </div>
                  );
                })}
            </section>
          );
        })}
      </div>
      {menu !== null && (
        // biome-ignore lint/a11y/useKeyWithClickEvents: overlay purely for capturing clicks (Escape is handled by window keydown)
        // biome-ignore lint/a11y/noStaticElementInteractions: same as above (not an interactive widget, but a receiver for outside clicks)
        <div
          className="session-context-backdrop"
          onClick={closeMenu}
          onContextMenu={(e) => {
            e.preventDefault();
            closeMenu();
          }}
        >
          <div
            className="session-context-menu"
            role="menu"
            style={{ top: menu.y, left: menu.x }}
          >
            {menu.kind === "org" ? (
              <button
                type="button"
                role="menuitem"
                className="session-context-item"
                onClick={() => {
                  onNew(menu.org);
                  closeMenu();
                }}
              >
                {t("sessionList.newSession")}
              </button>
            ) : (
              <>
                {onRename !== undefined &&
                  (() => {
                    const target = sessions.find(
                      (s) => s.windowId === menu.windowId,
                    );
                    const canRename =
                      target !== undefined && isRenamable(target);
                    return (
                      <button
                        type="button"
                        role="menuitem"
                        className="session-context-item"
                        disabled={!canRename}
                        title={
                          canRename ? undefined : t("sessionList.cannotRename")
                        }
                        onClick={() => {
                          if (target !== undefined) startRename(target);
                          closeMenu();
                        }}
                      >
                        {t("sessionList.rename")}
                      </button>
                    );
                  })()}
                {onCopyResume !== undefined &&
                  (() => {
                    const target = sessions.find(
                      (s) => s.windowId === menu.windowId,
                    );
                    const canResume =
                      target !== undefined && resumeCommand(target) !== null;
                    return (
                      <button
                        type="button"
                        role="menuitem"
                        className="session-context-item"
                        disabled={!canResume}
                        title={canResume ? undefined : t("common.cannotResume")}
                        onClick={() => {
                          onCopyResume(menu.windowId);
                          closeMenu();
                        }}
                      >
                        {t("common.copyResume")}
                      </button>
                    );
                  })()}
                {onCopySessionId !== undefined &&
                  (() => {
                    const target = sessions.find(
                      (s) => s.windowId === menu.windowId,
                    );
                    const canCopySessionId =
                      target !== undefined && claudeSessionId(target) !== null;
                    return (
                      <button
                        type="button"
                        role="menuitem"
                        className="session-context-item"
                        disabled={!canCopySessionId}
                        title={
                          canCopySessionId
                            ? undefined
                            : t("common.cannotCopySessionId")
                        }
                        onClick={() => {
                          onCopySessionId(menu.windowId);
                          closeMenu();
                        }}
                      >
                        {t("common.copySessionId")}
                      </button>
                    );
                  })()}
                <button
                  type="button"
                  role="menuitem"
                  className="session-context-item"
                  onClick={() => {
                    onClose(menu.windowId);
                    closeMenu();
                  }}
                >
                  {t("sessionList.delete")}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
