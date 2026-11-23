import type {
  CockpitTerminalInfo,
  CockpitTerminalLastActivityResponse,
} from "@zashiki/shared";

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long a Cockpit Terminal has to go without activity to count as left idle. */
export const IDLE_THRESHOLD_MS = DAY_MS;

/** Cockpit Terminal id → epoch ms of its last activity, for the idle terminals. */
export type IdleCockpitTerminals = ReadonlyMap<string, number>;

export function idleCockpitTerminals(
  response: CockpitTerminalLastActivityResponse,
  nowMs: number,
): IdleCockpitTerminals {
  return new Map(
    response.terminals
      .filter((t) => nowMs - t.lastActivityAt >= IDLE_THRESHOLD_MS)
      .map((t) => [t.cockpitTerminalId, t.lastActivityAt]),
  );
}

export interface IdleCockpitTerminalRow {
  terminal: CockpitTerminalInfo;
  /** The label the Cockpit Terminal list shows for it. */
  title: string;
  lastActivityAt: number;
}

/** Listed idle terminals, longest-idle first; a terminal closed since the check drops out. */
export function idleCockpitTerminalRows(
  idle: IdleCockpitTerminals,
  terminals: readonly CockpitTerminalInfo[],
  titleOf: (terminal: CockpitTerminalInfo) => string,
): IdleCockpitTerminalRow[] {
  return terminals
    .flatMap((terminal) => {
      const lastActivityAt = idle.get(terminal.cockpitTerminalId);
      return lastActivityAt === undefined
        ? []
        : [{ terminal, title: titleOf(terminal), lastActivityAt }];
    })
    .sort((a, b) => a.lastActivityAt - b.lastActivityAt);
}

/** Whole days since `lastActivityAt`. */
export function idleDays(lastActivityAt: number, nowMs: number): number {
  return Math.floor((nowMs - lastActivityAt) / DAY_MS);
}

/** Idle this many days or more reads as long forgotten. */
export const IDLE_LONG_DAYS = 7;

export function idleTone(days: number): "red" | "amber" {
  return days >= IDLE_LONG_DAYS ? "red" : "amber";
}
