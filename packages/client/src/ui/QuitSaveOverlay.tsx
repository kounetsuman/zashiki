import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

/**
 * Covers the whole window while the shell's quit-time Memo save is in flight, so the app reads as
 * busy rather than frozen. It blocks keystrokes as well as clicks: the flush keeps saving until the
 * buffer reads clean, so edits typed on top of it would queue further writes and push the answer past
 * the shell's wait — and a shortcut like Cmd+W would act on the app mid-quit.
 *
 * It has no controls of its own — the way out of a save that never finishes is the shell's native
 * dialog, which still reaches the user when the window is the unresponsive part.
 */
export function QuitSaveOverlay(): React.JSX.Element {
  const { t } = useTranslation();
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const restoreFocusTo = document.activeElement;
    overlayRef.current?.focus();
    // The app's Cmd shortcuts listen on window (useAppKeyboardShortcuts), which a React onKeyDown
    // cannot reach — the same measured reason QuickOpen shields them here rather than on its box.
    // Unlike QuickOpen this shields every key, since nothing behind the overlay may act on one.
    const shield = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", shield, true);
    return () => {
      window.removeEventListener("keydown", shield, true);
      // A quit can still be called off (the shell asks again about running sessions), and focus left
      // on <body> means keystrokes reach nothing until the user clicks back into the terminal. An
      // element that went away while the overlay was up is left alone: focus would have fallen to
      // <body> then anyway, overlay or not.
      if (restoreFocusTo instanceof HTMLElement && restoreFocusTo.isConnected) {
        restoreFocusTo.focus();
      }
    };
  }, []);

  return (
    <div
      ref={overlayRef}
      className="quit-save-overlay"
      role="dialog"
      aria-modal="true"
      aria-busy="true"
      aria-label={t("quitSave.saving")}
      tabIndex={-1}
    >
      <div className="quit-save-box">
        <span className="loading-spinner" />
        <span className="quit-save-text">{t("quitSave.saving")}</span>
      </div>
    </div>
  );
}
