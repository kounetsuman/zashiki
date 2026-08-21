type StoragePart = Pick<Storage, "getItem" | "setItem">;

/** localStorage key for whether the first-run integration wizard has been dismissed ("1" = seen). */
export const FIRST_RUN_WIZARD_SEEN_KEY = "zk.firstRunWizard.seen";

export function loadFirstRunWizardSeen(storage: StoragePart | null): boolean {
  return storage?.getItem(FIRST_RUN_WIZARD_SEEN_KEY) === "1";
}

export function saveFirstRunWizardSeen(storage: StoragePart | null): void {
  try {
    storage?.setItem(FIRST_RUN_WIZARD_SEEN_KEY, "1");
  } catch {
    // ignore (private mode / quota); the in-memory dismissal still hides it this session.
  }
}

/**
 * The wizard shows once per machine while the integration is absent: not yet dismissed, the status
 * has arrived, and either the hooks or the statusLine is missing. A wrapped foreign statusLine still
 * counts as registered, so it does not force the wizard.
 */
export function shouldShowFirstRunWizard(
  seen: boolean,
  status: { hooksRegistered: boolean; statusLineRegistered: boolean } | null,
): boolean {
  if (seen || status === null) return false;
  return !(status.hooksRegistered && status.statusLineRegistered);
}
