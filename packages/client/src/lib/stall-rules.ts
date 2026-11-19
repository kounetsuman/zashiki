import {
  DEFAULT_STALL_RULES,
  type LaunchLimitOverride,
  type StallRules,
} from "@zashiki/shared";

type StoragePart = Pick<Storage, "getItem" | "setItem">;

/** localStorage key for the Background Task View's stall rules (JSON; client-only setting). */
export const STALL_RULES_KEY = "zk.backgroundTasks.stallRules";

export const MAX_STALL_MINUTES = 24 * 60;
export const MAX_STALL_REPEAT = 1000;

const wholeIn = (value: unknown, max: number): number | null =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 1 &&
  value <= max
    ? value
    : null;

function sanitizeOverrides(value: unknown): LaunchLimitOverride[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((o: unknown) => {
    if (typeof o !== "object" || o === null) return [];
    const { match, launchLimitMin } = o as Record<string, unknown>;
    const minutes = wholeIn(launchLimitMin, MAX_STALL_MINUTES);
    return typeof match === "string" && match.trim() !== "" && minutes !== null
      ? [{ match: match.trim(), launchLimitMin: minutes }]
      : [];
  });
}

/** Keeps each valid field and puts the default back for anything missing or out of range. */
export function sanitizeStallRules(value: unknown): StallRules {
  const raw =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  return {
    launchLimitMin:
      wholeIn(raw.launchLimitMin, MAX_STALL_MINUTES) ??
      DEFAULT_STALL_RULES.launchLimitMin,
    quietLimitMin:
      wholeIn(raw.quietLimitMin, MAX_STALL_MINUTES) ??
      DEFAULT_STALL_RULES.quietLimitMin,
    repeatLimit:
      wholeIn(raw.repeatLimit, MAX_STALL_REPEAT) ??
      DEFAULT_STALL_RULES.repeatLimit,
    overrides: sanitizeOverrides(raw.overrides),
  };
}

export function loadStallRules(storage: StoragePart | null): StallRules {
  try {
    const raw = storage?.getItem(STALL_RULES_KEY);
    return raw == null
      ? DEFAULT_STALL_RULES
      : sanitizeStallRules(JSON.parse(raw));
  } catch {
    return DEFAULT_STALL_RULES;
  }
}

export function saveStallRules(
  storage: StoragePart | null,
  rules: StallRules,
): void {
  try {
    storage?.setItem(
      STALL_RULES_KEY,
      JSON.stringify(sanitizeStallRules(rules)),
    );
  } catch {
    // ignore (private mode / quota); the in-memory rules still apply this session.
  }
}
