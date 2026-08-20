import type { CockpitTerminalInfo } from "@zashiki/shared";
import type React from "react";
import { useTranslation } from "react-i18next";
import { type Tab, tabKey } from "../tabs/tab-model.js";
import { TAB_ICON } from "./tab-bar-model.js";
import type { TabDrag } from "./useTabDrag.js";
import type { TabRename } from "./useTabRename.js";

export interface TabItemProps {
  tab: Tab;
  active: boolean;
  label: string;
  title: string;
  session: CockpitTerminalInfo | undefined;
  orgColor: string | undefined;
  /** Whether reordering is enabled (onReorder provided by the caller). */
  reorderable: boolean;
  rename: TabRename;
  drag: TabDrag;
  onActivate(key: string): void;
  onClose(key: string): void;
  /** Pre-bound context-menu opener, or undefined when the tab has no menu. */
  onContextMenu?: (e: React.MouseEvent) => void;
}

/** A single tab: org dot, icon + label (or inline rename input), and close button. */
export function TabItem({
  tab,
  active,
  label,
  title,
  session,
  orgColor,
  reorderable,
  rename,
  drag,
  onActivate,
  onClose,
  onContextMenu,
}: TabItemProps) {
  const { t } = useTranslation();
  const key = tabKey(tab);
  const isEditing = rename.editingKey === key;
  const renamable = session !== undefined && rename.isRenamable(session);
  const draggable = reorderable && !isEditing;
  const dragging = drag.dragKey === key;
  const dropTarget =
    drag.dragKey !== null && drag.dragKey !== key && drag.dragOverKey === key;

  const startEdit = (): void => {
    if (!renamable || session === undefined) return;
    rename.startEdit(key, session, label);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: DnD drop target for tab reordering (interaction is on the role="tab" button; keyboard reordering is handled separately)
    <div
      className={`tab${active ? " tab-active" : ""}${
        dragging ? " tab-dragging" : ""
      }${dropTarget ? " tab-drag-over" : ""}`}
      style={
        active && orgColor !== undefined
          ? { borderTopColor: orgColor }
          : undefined
      }
      draggable={draggable}
      onDragStart={draggable ? (e) => drag.onDragStart(key, e) : undefined}
      onDragEnter={draggable ? (e) => drag.markDropTarget(key, e) : undefined}
      onDragOver={draggable ? (e) => drag.markDropTarget(key, e) : undefined}
      onDragLeave={draggable ? () => drag.onDragLeave(key) : undefined}
      onDrop={draggable ? (e) => drag.onDrop(key, e) : undefined}
      onDragEnd={draggable ? drag.endDrag : undefined}
      onContextMenu={onContextMenu}
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
          ref={rename.inputRef}
          className="tab-title-input"
          aria-label={t("tabBar.editTitleLabel")}
          maxLength={200}
          value={rename.draft}
          onChange={(e) => rename.setDraft(e.target.value)}
          onBlur={rename.commit}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              rename.commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              rename.cancel();
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
}
