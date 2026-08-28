import { useEffect } from "react";

/**
 * While `dirty`, asks the browser to confirm before the page unloads so unsaved edits are not
 * silently lost. No-op (no listener) while clean.
 */
export function useBeforeUnloadGuard(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Legacy engines only show the dialog when returnValue is set.
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
}
