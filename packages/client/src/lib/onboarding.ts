type StoragePart = Pick<Storage, "getItem" | "setItem">;

/** localStorage key for whether the welcome onboarding has been shown ("1" = seen). */
export const ONBOARDING_SEEN_KEY = "zk.onboarding.seen";

/**
 * True once the welcome onboarding has been shown on this machine. The key persists across app
 * updates, so a returning user (including right after an update) reads back true and is not greeted
 * again; only a fresh install with no key reads false and is treated as a first run.
 */
export function loadOnboardingSeen(storage: StoragePart | null): boolean {
  return storage?.getItem(ONBOARDING_SEEN_KEY) === "1";
}

export function saveOnboardingSeen(storage: StoragePart | null): void {
  try {
    storage?.setItem(ONBOARDING_SEEN_KEY, "1");
  } catch {
    // ignore (private mode / quota); the in-memory dismissal still hides it this session.
  }
}
