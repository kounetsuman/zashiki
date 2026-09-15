import {
  type CockpitTerminalInfo,
  canRestartCockpitTerminal,
  claudeSessionId,
} from "@zashiki/shared";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RepoFile } from "../viewer/viewer-model.js";
import { RestartConfirm } from "./RestartConfirm.js";

export interface TabContextMenuProps {
  menu: {
    key: string;
    cockpitTerminalId: string | null;
    viewer: RepoFile | null;
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
  /** Relaunches a terminal whose process has ended. Rendered only for that state. */
  onRestart?(cockpitTerminalId: string): void;
  onCopySessionId?(cockpitTerminalId: string): void;
  onReveal?(file: RepoFile): void;
  onCopyPath?(file: RepoFile): void;
  onRename?(key: string, file: RepoFile): void;
}

/**
 * Right-click menu overlay for a tab. Close is hidden for a pinned tab (it must be unpinned first);
 * Pin/Unpin renders for any pinnable tab; duplicate / copy session id render only for session tabs;
 * restart renders only for a terminal whose process has ended; reveal / copy path / rename render
 * only for viewer tabs.
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
  onRestart,
  onCopySessionId,
  onReveal,
  onCopyPath,
  onRename,
}: TabContextMenuProps) {
  const { t } = useTranslation();
  // A no_claude terminal still has a live shell that may be running something, so restarting it asks
  // for a second click. The timestamp makes that independent of where the confirm lands: a
  // double-click cannot reach it, whatever row the arming item happened to be on.
  const [restartArmedAt, setRestartArmedAt] = useState<number | null>(null);
  const { cockpitTerminalId, viewer } = menu;
  const target =
    cockpitTerminalId === null
      ? undefined
      : cockpitTerminals.find((s) => s.cockpitTerminalId === cockpitTerminalId);
  const canDuplicate = target !== undefined && claudeSessionId(target) !== null;
  const canRestart = target !== undefined && canRestartCockpitTerminal(target);

  // Dropped as soon as the terminal stops being restartable, so a row that goes away and comes back
  // does not return with the confirm already armed — the next click would then restart it outright.
  useEffect(() => {
    if (!canRestart) {
      setRestartArmedAt(null);
    }
  }, [canRestart]);
  const canCopySessionId =
    target !== undefined && claudeSessionId(target) !== null;
  const fileItem = (label: string, run: (f: RepoFile) => void) =>
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
        {restartArmedAt !== null && canRestart && cockpitTerminalId !== null ? (
          <RestartConfirm
            armedAt={restartArmedAt}
            target={target}
            onCancel={() => setRestartArmedAt(null)}
            onConfirm={() => {
              onRestart?.(cockpitTerminalId);
              closeMenu();
            }}
          />
        ) : (
          <>
            {!menu.pinned && (
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
            )}
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
            {cockpitTerminalId !== null &&
              onRestart !== undefined &&
              canRestart && (
                <button
                  type="button"
                  role="menuitem"
                  className="session-context-item"
                  onClick={(e) => {
                    // The backdrop closes the menu on any click that reaches it, which would discard
                    // the pending confirmation.
                    e.stopPropagation();
                    setRestartArmedAt(Date.now());
                  }}
                >
                  {t("common.restartSession")}
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
              fileItem(t("common.copyAbsPath"), onCopyPath)}
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
          </>
        )}
      </div>
    </div>
  );
}
