import { useTranslation } from "react-i18next";
import type { ExplorerMenuTarget } from "./useExplorerContextMenu.js";

export interface ExplorerContextMenuProps {
  menu: ExplorerMenuTarget;
  closeMenu(): void;
  onReveal(target: ExplorerMenuTarget): void;
  onCopyPath(target: ExplorerMenuTarget): void;
  onCopyRelativePath(target: ExplorerMenuTarget): void;
  onRename(target: ExplorerMenuTarget): void;
  onDelete(target: ExplorerMenuTarget): void;
}

/** Right-click menu for an explorer file/directory: reveal, copy paths, rename, delete (trash). */
export function ExplorerContextMenu({
  menu,
  closeMenu,
  onReveal,
  onCopyPath,
  onCopyRelativePath,
  onRename,
  onDelete,
}: ExplorerContextMenuProps) {
  const { t } = useTranslation();
  const item = (label: string, run: (t: ExplorerMenuTarget) => void) => (
    <button
      type="button"
      role="menuitem"
      className="session-context-item"
      onClick={() => {
        run(menu);
        closeMenu();
      }}
    >
      {label}
    </button>
  );
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: overlay solely for capturing clicks (Escape is handled by the hook's window keydown)
    // biome-ignore lint/a11y/noStaticElementInteractions: outside-click catcher, not an interactive widget
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
        {item(t("explorer.revealInFinder"), onReveal)}
        {item(t("explorer.copyPath"), onCopyPath)}
        {item(t("explorer.copyRelativePath"), onCopyRelativePath)}
        {item(t("explorer.rename"), onRename)}
        {item(t("explorer.delete"), onDelete)}
      </div>
    </div>
  );
}
