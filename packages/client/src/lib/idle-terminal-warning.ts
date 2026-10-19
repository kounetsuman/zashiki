import type { CockpitTerminalLastActivityResponse } from "@zashiki/shared";

type StoragePart = Pick<Storage, "getItem" | "setItem">;

/** localStorage key for the local day the idle-terminal warning was last shown on. */
export const IDLE_WARNING_SHOWN_DAY_KEY = "zk.idleTerminalWarning.shownDay";

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long a Cockpit Terminal has to go without input or output to count as left behind. */
export const IDLE_THRESHOLD_MS = DAY_MS;

/** Cockpit Terminal id → epoch ms of its last activity, for the terminals left behind. */
export type IdleTerminals = ReadonlyMap<string, number>;

export function idleTerminals(
  response: CockpitTerminalLastActivityResponse,
  nowMs: number,
): IdleTerminals {
  return new Map(
    response.terminals
      .filter((t) => nowMs - t.lastActivityAt >= IDLE_THRESHOLD_MS)
      .map((t) => [t.cockpitTerminalId, t.lastActivityAt]),
  );
}

/** Whole days since `lastActivityAt`, as the warning states it. */
export function idleDays(lastActivityAt: number, nowMs: number): number {
  return Math.floor((nowMs - lastActivityAt) / DAY_MS);
}

export function loadIdleWarningShownDay(
  storage: StoragePart | null,
): string | null {
  try {
    return storage?.getItem(IDLE_WARNING_SHOWN_DAY_KEY) ?? null;
  } catch {
    return null;
  }
}

export function saveIdleWarningShownDay(
  storage: StoragePart | null,
  day: string,
): void {
  try {
    storage?.setItem(IDLE_WARNING_SHOWN_DAY_KEY, day);
  } catch {
    // ignore (private mode / quota); at worst the warning shows again later today.
  }
}
