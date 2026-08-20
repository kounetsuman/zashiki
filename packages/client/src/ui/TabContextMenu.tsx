import {
  claudeSessionId,
  resumeCommand,
  type SessionInfo,
} from "@zashiki/shared";
import { useTranslation } from "react-i18next";

export interface TabContextMenuProps {
  menu: { windowId: string; x: number; y: number };
  sessions: SessionInfo[];
  closeMenu(): void;
  onCopyResume?(windowId: string): void;
  onCopySessionId?(windowId: string): void;
}

/** Right-click menu overlay for a session tab: copy resume command / copy session id. */
export function TabContextMenu({
  menu,
  sessions,
  closeMenu,
  onCopyResume,
  onCopySessionId,
}: TabContextMenuProps) {
  const { t } = useTranslation();
  const target = sessions.find((s) => s.windowId === menu.windowId);
  const canResume = target !== undefined && resumeCommand(target) !== null;
  const canCopySessionId =
    target !== undefined && claudeSessionId(target) !== null;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: overlay solely for capturing clicks (Escape is handled by window keydown)
    // biome-ignore lint/a11y/noStaticElementInteractions: same as above (not an interactive widget, just an outside-click catcher)
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
        {onCopyResume !== undefined && (
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
        )}
        {onCopySessionId !== undefined && (
          <button
            type="button"
            role="menuitem"
            className="session-context-item"
            disabled={!canCopySessionId}
            title={
              canCopySessionId ? undefined : t("common.cannotCopySessionId")
            }
            onClick={() => {
              onCopySessionId(menu.windowId);
              closeMenu();
            }}
          >
            {t("common.copySessionId")}
          </button>
        )}
      </div>
    </div>
  );
}
