import {
  type CockpitTerminalInfo,
  canRestartCockpitTerminal,
  claudeSessionId,
} from "@zashiki/shared";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ContextMenu } from "./session-list-model.js";

/** A confirm this soon after arming is a double-click reaching the button that replaced the one it
 * armed, not a decision. Covers the usual double-click interval without making a deliberate confirm
 * feel blocked. */
export const ARM_SETTLE_MS = 350;

export interface SessionContextMenuProps {
  menu: ContextMenu;
  cockpitTerminals: CockpitTerminalInfo[];
  onNew(org: string): void;
  onClose(cockpitTerminalId: string): void;
  isRenamable(s: CockpitTerminalInfo): boolean;
  startRename(s: CockpitTerminalInfo): void;
  closeMenu(): void;
  onRename?(cockpitTerminalId: string, name: string, title: string): void;
  onDuplicate?(cockpitTerminalId: string): void;
  /** Relaunches a terminal whose process has ended. Rendered only for that state. */
  onRestart?(cockpitTerminalId: string): void;
  onCopySessionId?(cockpitTerminalId: string): void;
}

/** The right-click menu overlay: New for an org area; Rename/Copy/Delete for a session row. */
export function SessionContextMenu({
  menu,
  cockpitTerminals,
  onNew,
  onClose,
  isRenamable,
  startRename,
  closeMenu,
  onRename,
  onDuplicate,
  onRestart,
  onCopySessionId,
}: SessionContextMenuProps) {
  const { t } = useTranslation();
  // A no_claude terminal still has a live shell that may be running something, so restarting it asks
  // for a second click, the way closing a row does. The timestamp makes that independent of where the
  // confirm lands: a double-click cannot reach it, whatever row the arming item happened to be on.
  const [restartArmedAt, setRestartArmedAt] = useState<number | null>(null);
  const restartArmed = restartArmedAt !== null;
  const target =
    menu.kind === "row"
      ? cockpitTerminals.find(
          (s) => s.cockpitTerminalId === menu.cockpitTerminalId,
        )
      : undefined;
  // Re-checked while the confirm is on screen, not just when it was offered: a state.sync can land in
  // between and leave the terminal running again, or take it away entirely.
  const canRestart = target !== undefined && canRestartCockpitTerminal(target);

  // Dropped as soon as the terminal stops being restartable, so a row that goes away and comes back
  // does not return with the confirm already armed — the next click would then restart it outright.
  useEffect(() => {
    if (!canRestart) {
      setRestartArmedAt(null);
    }
  }, [canRestart]);
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
        ) : restartArmed && canRestart ? (
          // Confirming replaces the whole menu rather than growing it. Leaving the other items on
          // screen would shift them under the pointer, so a click aimed at one of them would confirm;
          // replacing it also moves both rows away from where the arming click landed.
          <div className="session-context-confirm" role="none">
            <button
              type="button"
              role="menuitem"
              className="session-context-item"
              onClick={(e) => {
                e.stopPropagation();
                setRestartArmedAt(null);
              }}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              role="menuitem"
              className="session-context-item"
              onClick={(e) => {
                // Too soon means a double-click landed here, not a decision. Swallow it rather than
                // letting it reach the backdrop, which would close the menu and lose the confirmation.
                if (
                  restartArmedAt !== null &&
                  Date.now() - restartArmedAt < ARM_SETTLE_MS
                ) {
                  e.stopPropagation();
                  return;
                }
                onRestart?.(menu.cockpitTerminalId);
                closeMenu();
              }}
            >
              {t(
                target?.state === "no_claude"
                  ? "common.restartSessionConfirmShell"
                  : "common.restartSessionConfirm",
              )}
            </button>
          </div>
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
            {onDuplicate !== undefined &&
              (() => {
                const canDuplicate =
                  target !== undefined && claudeSessionId(target) !== null;
                return (
                  <button
                    type="button"
                    role="menuitem"
                    className="session-context-item"
                    disabled={!canDuplicate}
                    title={
                      canDuplicate ? undefined : t("common.cannotDuplicate")
                    }
                    onClick={() => {
                      onDuplicate(menu.cockpitTerminalId);
                      closeMenu();
                    }}
                  >
                    {t("common.duplicateSession")}
                  </button>
                );
              })()}
            {onRestart !== undefined && canRestart && (
              <button
                type="button"
                role="menuitem"
                className="session-context-item"
                onClick={(e) => {
                  // The backdrop closes the menu on any click that reaches it, which would
                  // discard the pending confirmation.
                  e.stopPropagation();
                  setRestartArmedAt(Date.now());
                }}
              >
                {t("common.restartSession")}
              </button>
            )}
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
