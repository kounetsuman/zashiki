import type { CockpitTerminalInfo } from "@zashiki/shared";
import {
  claudeSessionId,
  isUuidSid,
  resolveOrgColor,
  resumeCommand,
} from "@zashiki/shared";
import { type DragEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  effectiveCustomTitle,
  resolveTitle,
  type TitleMap,
} from "../lib/conversation-title.js";
import { type Tab, type TabKind, tabKey } from "../tabs/tab-model.js";
import { clampMenuPos, panelClass } from "./panels.js";

/** Icon per tab kind (Material Symbols Outlined ligature). */
const TAB_ICON: Record<TabKind, string> = {
  session: "terminal",
  viewer: "description",
};

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
 * The tab's display label and title (tooltip). For session tabs, uses resolveTitle;
 * for viewer tabs, shows the file name (basename) and attaches the repo-relative path as the title.
 */
function tabLabel(
  tab: Tab,
  sessions: CockpitTerminalInfo[],
  titles: TitleMap,
): { label: string; title: string } {
  if (tab.kind === "session") {
    const s = sessions.find((x) => x.cockpitTerminalId === tab.id);
    const label =
      s === undefined
        ? tab.id
        : resolveTitle(effectiveCustomTitle(titles, s), s);
    return { label, title: label };
  }
  // A viewer id is the viewerKey (repoPath and relPath joined by a newline). Display shows the file name.
  const rel = tab.id.split("\n")[1] ?? tab.id;
  return { label: rel.split("/").pop() ?? rel, title: rel };
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
  // For the tab being edited, remember its cockpitTerminalId/name at the start in addition to the key
  // (to verify on commit that we don't mistakenly commit to a window other than the one displayed).
  const [editing, setEditing] = useState<{
    key: string;
    cockpitTerminalId: string;
    name: string;
  } | null>(null);
  const [draft, setDraft] = useState("");
  // The tab being dragged and the drop-target tab currently hovered over it (for visual reordering feedback).
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  // Right-click menu for session tabs (copy resume for branched sessions).
  const [menu, setMenu] = useState<{
    cockpitTerminalId: string;
    x: number;
    y: number;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Guard against double-firing commit/cancel (prevents an unmount blur after Escape cancel from mistakenly committing the stale draft).
  const doneRef = useRef(false);

  // Abort editing if, during an edit, the target tab is pruned away (doneRef guards an unmount blur
  // from mistakenly committing the stale draft. Adjusting state during render is the React-recommended
  // pattern, so we avoid an effect).
  if (editing !== null) {
    const tab = tabs.find((t) => tabKey(t) === editing.key);
    const s =
      tab?.kind === "session"
        ? sessions.find((x) => x.cockpitTerminalId === tab.id)
        : undefined;
    if (s === undefined) {
      doneRef.current = true;
      setEditing(null);
    }
  }

  useEffect(() => {
    if (editing !== null) inputRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    if (menu === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);

  if (tabs.length === 0) return null;

  const cancel = (): void => {
    doneRef.current = true;
    setEditing(null);
  };
  const commit = (): void => {
    if (doneRef.current || editing === null) return;
    doneRef.current = true;
    onRename?.(editing.cockpitTerminalId, editing.name, draft);
    setEditing(null);
  };

  return (
    <div
      className={panelClass("tab-bar", inactive)}
      role="tablist"
      aria-label={t("tabBar.ariaLabel")}
    >
      {tabs.map((tab) => {
        const key = tabKey(tab);
        const active = key === activeKey;
        const { label, title } = tabLabel(tab, sessions, conversationTitles);
        const session =
          tab.kind === "session"
            ? sessions.find((x) => x.cockpitTerminalId === tab.id)
            : undefined;
        const orgColor =
          session !== undefined
            ? resolveOrgColor(session.org, orgColors)
            : undefined;
        const isEditing = editing?.key === key;

        // Rename is not accepted for non-UUID windows (unbound/plain-shell)
        // (commitTitle would become a no-op and just discard the input, so we don't enter edit mode at all).
        const renamable =
          session !== undefined &&
          onRename !== undefined &&
          isUuidSid(session.cockpitTerminalId);
        const startEdit = (): void => {
          if (!renamable) return;
          doneRef.current = false;
          setDraft(label);
          setEditing({
            key,
            cockpitTerminalId: session.cockpitTerminalId,
            name: session.name,
          });
        };

        // Drag & drop reordering is possible only when onReorder is present and not currently editing a rename.
        const draggable = onReorder !== undefined && !isEditing;
        const dragging = dragKey === key;
        const dropTarget =
          dragKey !== null && dragKey !== key && dragOverKey === key;
        const endDrag = (): void => {
          setDragKey(null);
          setDragOverKey(null);
        };
        // WebKit (Tauri WKWebView) won't fire drop unless preventDefault is called on both
        // dragenter and dragover. Making preventDefault depend on the dragKey state would
        // leave gaps in becoming a drop target (dragenter unprocessed, state not yet reflected),
        // so we always suppress the default and only update the visual highlight and dropEffect on other tabs.
        const markDropTarget = (e: DragEvent): void => {
          e.preventDefault();
          if (dragKey === null || dragKey === key) return;
          if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
          setDragOverKey(key);
        };

        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: DnD drop target for tab reordering (interaction is on the role="tab" button; keyboard reordering is handled separately)
          <div
            key={key}
            className={`tab${active ? " tab-active" : ""}${
              dragging ? " tab-dragging" : ""
            }${dropTarget ? " tab-drag-over" : ""}`}
            style={
              active && orgColor !== undefined
                ? { borderTopColor: orgColor }
                : undefined
            }
            draggable={draggable}
            onDragStart={
              draggable
                ? (e) => {
                    setDragKey(key);
                    if (e.dataTransfer) {
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", key);
                    }
                  }
                : undefined
            }
            onDragEnter={draggable ? markDropTarget : undefined}
            onDragOver={draggable ? markDropTarget : undefined}
            onDragLeave={
              draggable
                ? () => {
                    if (dragOverKey === key) setDragOverKey(null);
                  }
                : undefined
            }
            onDrop={
              draggable
                ? (e) => {
                    e.preventDefault();
                    if (dragKey !== null && dragKey !== key)
                      onReorder?.(dragKey, key);
                    endDrag();
                  }
                : undefined
            }
            onDragEnd={draggable ? endDrag : undefined}
            onContextMenu={
              session !== undefined &&
              (onCopyResume !== undefined || onCopySessionId !== undefined)
                ? (e) => {
                    e.preventDefault();
                    const itemCount =
                      (onCopyResume !== undefined ? 1 : 0) +
                      (onCopySessionId !== undefined ? 1 : 0);
                    const { x, y } = clampMenuPos(
                      e.clientX,
                      e.clientY,
                      itemCount,
                    );
                    setMenu({
                      cockpitTerminalId: session.cockpitTerminalId,
                      x,
                      y,
                    });
                  }
                : undefined
            }
          >
            {session !== undefined && (
              <span
                className="tab-org-dot"
                role="img"
                style={{ backgroundColor: orgColor }}
                title={session.org}
                aria-label={`org: ${session.org}`}
              />
            )}
            {isEditing ? (
              <input
                ref={inputRef}
                className="tab-title-input"
                aria-label={t("tabBar.editTitleLabel")}
                maxLength={200}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    commit();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancel();
                  }
                }}
              />
            ) : (
              <button
                type="button"
                role="tab"
                className="tab-main"
                aria-selected={active}
                title={title}
                onClick={() => onActivate(key)}
                onDoubleClick={startEdit}
              >
                <span className="material-symbols-outlined" aria-hidden="true">
                  {TAB_ICON[tab.kind]}
                </span>
                <span className="tab-label">{label}</span>
              </button>
            )}
            <button
              type="button"
              className="tab-close"
              aria-label={t("tabBar.closeTab", { label })}
              title={t("tabBar.closeTabTitle")}
              onClick={(e) => {
                e.stopPropagation();
                onClose(key);
              }}
            >
              <span className="material-symbols-outlined" aria-hidden="true">
                close
              </span>
            </button>
          </div>
        );
      })}
      {menu !== null &&
        (onCopyResume !== undefined || onCopySessionId !== undefined) &&
        (() => {
          const target = sessions.find(
            (s) => s.cockpitTerminalId === menu.cockpitTerminalId,
          );
          const canResume =
            target !== undefined && resumeCommand(target) !== null;
          const canCopySessionId =
            target !== undefined && claudeSessionId(target) !== null;
          return (
            // biome-ignore lint/a11y/useKeyWithClickEvents: overlay solely for capturing clicks (Escape is handled by window keydown)
            // biome-ignore lint/a11y/noStaticElementInteractions: same as above (not an interactive widget, just an outside-click catcher)
            <div
              className="session-context-backdrop"
              onClick={() => setMenu(null)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu(null);
              }}
            >
              <div
                className="session-context-menu"
                role="menu"
                style={{ top: menu.y, left: menu.x }}
              >
                {onCopyResume !== undefined && (
                  <button
                    type="button"
                    role="menuitem"
                    className="session-context-item"
                    disabled={!canResume}
                    title={canResume ? undefined : t("common.cannotResume")}
                    onClick={() => {
                      onCopyResume(menu.cockpitTerminalId);
                      setMenu(null);
                    }}
                  >
                    {t("common.copyResume")}
                  </button>
                )}
                {onCopySessionId !== undefined && (
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
                      onCopySessionId(menu.cockpitTerminalId);
                      setMenu(null);
                    }}
                  >
                    {t("common.copySessionId")}
                  </button>
                )}
              </div>
            </div>
          );
        })()}
    </div>
  );
}
