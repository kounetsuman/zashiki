import {
  type CockpitTerminalInfo,
  claudeSessionId,
  resumeCommand,
} from "@zashiki/shared";
import { useTranslation } from "react-i18next";

export interface TabContextMenuProps {
  menu: { cockpitTerminalId: string; x: number; y: number };
  cockpitTerminals: CockpitTerminalInfo[];
  closeMenu(): void;
  onCopyResume?(cockpitTerminalId: string): void;
  onCopySessionId?(cockpitTerminalId: string): void;
}

/** Right-click menu overlay for a session tab: copy resume command / copy session id. */
export function TabContextMenu({
  menu,
  cockpitTerminals,
  closeMenu,
  onCopyResume,
  onCopySessionId,
}: TabContextMenuProps) {
  const { t } = useTranslation();
  const target = cockpitTerminals.find(
    (s) => s.cockpitTerminalId === menu.cockpitTerminalId,
  );
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
              onCopyResume(menu.cockpitTerminalId);
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
              onCopySessionId(menu.cockpitTerminalId);
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
