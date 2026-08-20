import {
  type CockpitTerminalInfo,
  claudeSessionId,
  resumeCommand,
} from "@zashiki/shared";
import { useTranslation } from "react-i18next";
import type { ContextMenu } from "./session-list-model.js";

export interface SessionContextMenuProps {
  menu: ContextMenu;
  sessions: CockpitTerminalInfo[];
  onNew(org: string): void;
  onClose(cockpitTerminalId: string): void;
  isRenamable(s: CockpitTerminalInfo): boolean;
  startRename(s: CockpitTerminalInfo): void;
  closeMenu(): void;
  onRename?(cockpitTerminalId: string, name: string, title: string): void;
  onCopyResume?(cockpitTerminalId: string): void;
  onCopySessionId?(cockpitTerminalId: string): void;
}

/** The right-click menu overlay: New for an org area; Rename/Copy/Delete for a session row. */
export function SessionContextMenu({
  menu,
  sessions,
  onNew,
  onClose,
  isRenamable,
  startRename,
  closeMenu,
  onRename,
  onCopyResume,
  onCopySessionId,
}: SessionContextMenuProps) {
  const { t } = useTranslation();
  const target =
    menu.kind === "row"
      ? sessions.find((s) => s.cockpitTerminalId === menu.cockpitTerminalId)
      : undefined;
  return (
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
                const canRename = target !== undefined && isRenamable(target);
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
                      onCopyResume(menu.cockpitTerminalId);
                      closeMenu();
                    }}
                  >
                    {t("common.copyResume")}
                  </button>
                );
              })()}
            {onCopySessionId !== undefined &&
              (() => {
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
                      onCopySessionId(menu.cockpitTerminalId);
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
                onClose(menu.cockpitTerminalId);
                closeMenu();
              }}
            >
              {t("sessionList.delete")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
