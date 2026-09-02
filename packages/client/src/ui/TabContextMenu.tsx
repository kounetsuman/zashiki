import { type CockpitTerminalInfo, claudeSessionId } from "@zashiki/shared";
import { useTranslation } from "react-i18next";

interface ViewerMenuFile {
  repoPath: string;
  relPath: string;
}

export interface TabContextMenuProps {
  menu: {
    key: string;
    cockpitTerminalId: string | null;
    viewer: ViewerMenuFile | null;
    pinnable: boolean;
    pinned: boolean;
    x: number;
    y: number;
  };
  cockpitTerminals: CockpitTerminalInfo[];
  closeMenu(): void;
  onClose(key: string): void;
  onCloseAll?(): void;
  /** Pins the tab so it stays in the fixed left strip. Hidden when unspecified or for the Memo tab. */
  onPin?(key: string): void;
  /** Unpins the tab. Hidden when unspecified or for the Memo tab. */
  onUnpin?(key: string): void;
  onDuplicate?(cockpitTerminalId: string): void;
  onCopySessionId?(cockpitTerminalId: string): void;
  onReveal?(file: ViewerMenuFile): void;
  onCopyPath?(file: ViewerMenuFile): void;
  onCopyRelativePath?(file: ViewerMenuFile): void;
  onRename?(key: string, file: ViewerMenuFile): void;
}

/**
 * Right-click menu overlay for a tab. Pin/Unpin renders for any pinnable tab; duplicate / copy
 * session id render only for session tabs; reveal / copy paths / rename render only for viewer tabs.
 */
export function TabContextMenu({
  menu,
  cockpitTerminals,
  closeMenu,
  onClose,
  onCloseAll,
  onPin,
  onUnpin,
  onDuplicate,
  onCopySessionId,
  onReveal,
  onCopyPath,
  onCopyRelativePath,
  onRename,
}: TabContextMenuProps) {
  const { t } = useTranslation();
  const { cockpitTerminalId, viewer } = menu;
  const target =
    cockpitTerminalId === null
      ? undefined
      : cockpitTerminals.find((s) => s.cockpitTerminalId === cockpitTerminalId);
  const canDuplicate = target !== undefined && claudeSessionId(target) !== null;
  const canCopySessionId =
    target !== undefined && claudeSessionId(target) !== null;
  const fileItem = (label: string, run: (f: ViewerMenuFile) => void) =>
    viewer !== null && (
      <button
        type="button"
        role="menuitem"
        className="session-context-item"
        onClick={() => {
          run(viewer);
          closeMenu();
        }}
      >
        {label}
      </button>
    );
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
        {menu.pinnable && menu.pinned && onUnpin !== undefined && (
          <button
            type="button"
            role="menuitem"
            className="session-context-item"
            onClick={() => {
              onUnpin(menu.key);
              closeMenu();
            }}
          >
            {t("common.unpinTab")}
          </button>
        )}
        {menu.pinnable && !menu.pinned && onPin !== undefined && (
          <button
            type="button"
            role="menuitem"
            className="session-context-item"
            onClick={() => {
              onPin(menu.key);
              closeMenu();
            }}
          >
            {t("common.pinTab")}
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
        {onReveal !== undefined &&
          fileItem(t("explorer.revealInFinder"), onReveal)}
        {onCopyPath !== undefined &&
          fileItem(t("explorer.copyPath"), onCopyPath)}
        {onCopyRelativePath !== undefined &&
          fileItem(t("explorer.copyRelativePath"), onCopyRelativePath)}
        {viewer !== null && onRename !== undefined && (
          <button
            type="button"
            role="menuitem"
            className="session-context-item"
            onClick={() => {
              onRename(menu.key, viewer);
              closeMenu();
            }}
          >
            {t("explorer.rename")}
          </button>
        )}
      </div>
    </div>
  );
}
