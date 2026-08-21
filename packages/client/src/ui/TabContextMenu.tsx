import { type CockpitTerminalInfo, claudeSessionId } from "@zashiki/shared";
import { useTranslation } from "react-i18next";

export interface TabContextMenuProps {
  menu: { cockpitTerminalId: string; x: number; y: number };
  cockpitTerminals: CockpitTerminalInfo[];
  closeMenu(): void;
  onDuplicate?(cockpitTerminalId: string): void;
  onCopySessionId?(cockpitTerminalId: string): void;
}

/** Right-click menu overlay for a session tab: duplicate session / copy session id. */
export function TabContextMenu({
  menu,
  cockpitTerminals,
  closeMenu,
  onDuplicate,
  onCopySessionId,
}: TabContextMenuProps) {
  const { t } = useTranslation();
  const target = cockpitTerminals.find(
    (s) => s.cockpitTerminalId === menu.cockpitTerminalId,
  );
  const canDuplicate = target !== undefined && claudeSessionId(target) !== null;
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
        {onDuplicate !== undefined && (
          <button
            type="button"
            role="menuitem"
            className="session-context-item"
            disabled={!canDuplicate}
            title={canDuplicate ? undefined : t("common.cannotDuplicate")}
            onClick={() => {
              onDuplicate(menu.cockpitTerminalId);
              closeMenu();
            }}
          >
            {t("common.duplicateSession")}
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
