import type { CockpitTerminalInfo } from "@zashiki/shared";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

/** A confirm this soon after arming is a double-click reaching the button that replaced the one it
 * armed, not a decision. Covers the usual double-click interval without making a deliberate confirm
 * feel blocked. */
export const ARM_SETTLE_MS = 350;

export interface RestartConfirmProps {
  /** The terminal the confirm is for; a live shell is warned about differently. */
  target: CockpitTerminalInfo | undefined;
  onCancel(): void;
  onConfirm(): void;
}

/** The two-button confirm that replaces a context menu once a restart is armed. Replacing the menu
 * rather than growing it keeps the other items from shifting under the pointer, where a click aimed
 * at one of them would confirm instead; it also moves both rows away from the arming click. */
export function RestartConfirm({
  target,
  onCancel,
  onConfirm,
}: RestartConfirmProps) {
  const { t } = useTranslation();
  // Disabled while it settles rather than ignoring the click: a confirm this soon is a double-click
  // landing on the button that replaced the one it armed, and greying it out says so, where swallowing
  // it leaves a deliberate fast click looking broken.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(true), ARM_SETTLE_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className="session-context-confirm" role="none">
      <button
        type="button"
        role="menuitem"
        className="session-context-item"
        onClick={(e) => {
          e.stopPropagation();
          onCancel();
        }}
      >
        {t("common.cancel")}
      </button>
      <button
        type="button"
        role="menuitem"
        className="session-context-item"
        disabled={!settled}
        onClick={onConfirm}
      >
        {t(
          target?.state === "no_claude"
            ? "common.restartSessionConfirmShell"
            : "common.restartSessionConfirm",
        )}
      </button>
    </div>
  );
}
