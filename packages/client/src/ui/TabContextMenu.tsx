import { type CockpitTerminalInfo, claudeSessionId } from "@zashiki/shared";
import { useTranslation } from "react-i18next";

export interface TabContextMenuProps {
  menu: { key: string; cockpitTerminalId: string | null; x: number; y: number };
  cockpitTerminals: CockpitTerminalInfo[];
  closeMenu(): void;
  onClose(key: string): void;
  onCloseAll?(): void;
  onDuplicate?(cockpitTerminalId: string): void;
  onCopySessionId?(cockpitTerminalId: string): void;
}

/** Right-click menu overlay for a tab. Duplicate / copy session id render only for session tabs. */
export function TabContextMenu({
  menu,
  cockpitTerminals,
  closeMenu,
  onClose,
  onCloseAll,
  onDuplicate,
  onCopySessionId,
}: TabContextMenuProps) {
  const { t } = useTranslation();
  const { cockpitTerminalId } = menu;
  const target =
    cockpitTerminalId === null
      ? undefined
      : cockpitTerminals.find((s) => s.cockpitTerminalId === cockpitTerminalId);
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
        <button
          type="button"
          role="menuitem"
          className="session-context-item"
          onClick={() => {
            onClose(menu.key);
            closeMenu();
          }}
        >
          {t("common.close")}
        </button>
        {onCloseAll !== undefined && (
          <button
            type="button"
            role="menuitem"
            className="session-context-item"
            onClick={() => {
              onCloseAll();
              closeMenu();
            }}
          >
            {t("common.closeAllTabs")}
          </button>
        )}
        {cockpitTerminalId !== null && onDuplicate !== undefined && (
          <button
            type="button"
            role="menuitem"
            className="session-context-item"
            disabled={!canDuplicate}
            title={canDuplicate ? undefined : t("common.cannotDuplicate")}
            onClick={() => {
              onDuplicate(cockpitTerminalId);
              closeMenu();
            }}
          >
            {t("common.duplicateSession")}
          </button>
        )}
        {cockpitTerminalId !== null && onCopySessionId !== undefined && (
          <button
            type="button"
            role="menuitem"
            className="session-context-item"
            disabled={!canCopySessionId}
            title={
              canCopySessionId ? undefined : t("common.cannotCopySessionId")
            }
            onClick={() => {
              onCopySessionId(cockpitTerminalId);
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
