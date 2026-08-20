import { type CockpitTerminalInfo, resolveOrgColor } from "@zashiki/shared";
import type React from "react";
import { useTranslation } from "react-i18next";
import {
  effectiveCustomTitle,
  resolveTitle,
  type TitleMap,
} from "../lib/conversation-title.js";
import { ActivityChips, StateIcon } from "./SessionStateIcons.js";
import { isFresh } from "./session-list-model.js";

export interface SessionRowProps {
  session: CockpitTerminalInfo;
  orgColors: Record<string, string>;
  conversationTitles: TitleMap;
  selectedCockpitTerminalId: string | null;
  isFocused: boolean;
  focusedRef: React.RefObject<HTMLButtonElement | null>;
  isRenaming: boolean;
  renameDraft: string;
  renameInputRef: React.RefObject<HTMLInputElement | null>;
  confirming: boolean;
  onContextMenu(e: React.MouseEvent): void;
  onSetRenameDraft(value: string): void;
  onCommitRename(): void;
  onCancelRename(): void;
  onFocusRow(cockpitTerminalId: string): void;
  onSelect(cockpitTerminalId: string): void;
  onClose(cockpitTerminalId: string): void;
  onConfirmClose(cockpitTerminalId: string): void;
  onCancelConfirm(): void;
}

/** A single session row: state glyph, title (or inline rename input), close button, and inline close confirm. */
export function SessionRow({
  session: s,
  orgColors,
  conversationTitles,
  selectedCockpitTerminalId,
  isFocused,
  focusedRef,
  isRenaming,
  renameDraft,
  renameInputRef,
  confirming,
  onContextMenu,
  onSetRenameDraft,
  onCommitRename,
  onCancelRename,
  onFocusRow,
  onSelect,
  onClose,
  onConfirmClose,
  onCancelConfirm,
}: SessionRowProps) {
  const { t } = useTranslation();
  // Prefer the manual title (header rename); fall back to the automatic title if none.
  const custom = effectiveCustomTitle(conversationTitles, s);
  const summaryTitle = custom ?? s.title;
  // Visible label. Falls back to the window name (= org name for owned sessions) via resolveTitle,
  // the same fallback the tab uses, so an unresolved title (e.g. right after resume, before the
  // summary is computed) shows the org name rather than a blank row.
  const displayTitle = resolveTitle(custom, s);
  const fresh = isFresh(s, custom);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: right-click menu for the row (keyboard is covered by Ctrl-X)
    <div className="session-row" onContextMenu={onContextMenu}>
      {isRenaming ? (
        <div className="panel-row session-row-main session-row-editing">
          <StateIcon session={s} fresh={fresh} />
          <input
            ref={renameInputRef}
            className="session-title-input"
            aria-label={t("sessionList.editTitleLabel")}
            maxLength={200}
            value={renameDraft}
            onChange={(e) => onSetRenameDraft(e.target.value)}
            onBlur={onCommitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                e.stopPropagation();
                onCommitRename();
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                onCancelRename();
              }
            }}
          />
        </div>
      ) : (
        <>
          <button
            type="button"
            ref={isFocused ? focusedRef : undefined}
            className={`panel-row panel-row-hover session-row-main${
              isFocused ? " session-row-focused" : ""
            }`}
            style={
              {
                "--org-color": resolveOrgColor(s.org, orgColors),
              } as React.CSSProperties
            }
            aria-current={
              s.cockpitTerminalId === selectedCockpitTerminalId
                ? "true"
                : undefined
            }
            // Keep the window name in aria-label for row identification and a11y.
            // Pair it with the summary only when one exists; the visible label may
            // fall back to the name, but the aria-label must not repeat it.
            aria-label={
              summaryTitle !== null ? `${s.name} ${summaryTitle}` : s.name
            }
            // Expand via double-click/Enter. A single click is the focus ring only (to prevent accidental triggering).
            title={t("sessionList.openHint")}
            onClick={() => onFocusRow(s.cockpitTerminalId)}
            onDoubleClick={() => onSelect(s.cockpitTerminalId)}
          >
            <StateIcon session={s} fresh={fresh} />
            <ActivityChips session={s} />
            <span className="session-title"> {displayTitle}</span>
          </button>
          <button
            type="button"
            className="session-row-close"
            aria-label={t("sessionList.closeRow", { name: s.name })}
            title={t("common.close")}
            onClick={(e) => {
              e.stopPropagation();
              onClose(s.cockpitTerminalId);
            }}
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              delete
            </span>
          </button>
          {confirming && (
            <span className="session-row-confirm">
              <button
                type="button"
                className="session-confirm-ok"
                aria-label={t("sessionList.closeRowConfirm", { name: s.name })}
                title={t("common.close")}
                onClick={() => onConfirmClose(s.cockpitTerminalId)}
              >
                {t("common.close")}
              </button>
              <button
                type="button"
                className="session-confirm-cancel"
                aria-label={t("sessionList.cancelClose")}
                title={t("common.cancel")}
                onClick={onCancelConfirm}
              >
                {t("common.cancel")}
              </button>
            </span>
          )}
        </>
      )}
    </div>
  );
}
