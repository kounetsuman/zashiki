import { describe, expect, it } from "vitest";

import {
  clampFiveHourWhenLimited,
  durationSeverity,
  FIVE_HOUR_WINDOW_MS,
  fmtDuration,
  fmtResetClock,
  fmtResetCountdown,
  fmtTokens,
  fmtWeekResetCountdown,
  loadUsageTimeMode,
  nextUsageTimeMode,
  saveUsageTimeMode,
  tokenSeverity,
  USAGE_STALE_AFTER_MS,
  usageBandReached,
  usageDisplayMs,
  usageFreshness,
  usageRemainingPercent,
  usageSeverity,
  WEEK_WINDOW_MS,
} from "./status-footer.js";

describe("fmtTokens", () => {
  it("keeps sub-thousand exact and clamps negatives", () => {
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(950)).toBe("950");
    expect(fmtTokens(-5)).toBe("0");
  });

  it("uses one decimal with a suffix past a thousand and a million", () => {
    expect(fmtTokens(12_300)).toBe("12.3k");
    expect(fmtTokens(1_900_000)).toBe("1.9M");
  });
});

describe("fmtDuration", () => {
  it("drops leading zero units", () => {
    expect(fmtDuration(12_000)).toBe("12s");
    expect(fmtDuration(3 * 60_000 + 12_000)).toBe("3m 12s");
    expect(fmtDuration((60 + 24) * 60_000 + 5_000)).toBe("1h 24m 5s");
  });

  it("adds a day unit and keeps zero units between the largest and seconds", () => {
    expect(fmtDuration(86_400_000)).toBe("1d 0h 0m 0s");
    expect(
      fmtDuration(2 * 86_400_000 + 3 * 3_600_000 + 4 * 60_000 + 5_000),
    ).toBe("2d 3h 4m 5s");
  });

  it("clamps negatives to zero", () => {
    expect(fmtDuration(-1_000)).toBe("0s");
  });
});

describe("usageFreshness", () => {
  const now = 10_000_000;

  it("is live for a recently-captured reading within its window", () => {
    expect(
      usageFreshness({ usedPercent: 40, resetsAt: now + 60_000 }, now, now),
    ).toBe("live");
  });

  it("is expired once the window's reset time has passed", () => {
    expect(usageFreshness({ usedPercent: 40, resetsAt: now }, now, now)).toBe(
      "expired",
    );
    expect(
      usageFreshness({ usedPercent: 40, resetsAt: now - 1 }, now, now),
    ).toBe("expired");
  });

  it("is stale when no reading has arrived within the freshness window", () => {
    const capturedAt = now - USAGE_STALE_AFTER_MS - 1;
    expect(
      usageFreshness(
        { usedPercent: 40, resetsAt: now + 60_000 },
        capturedAt,
        now,
      ),
    ).toBe("stale");
  });

  it("prefers expired over stale when both apply", () => {
    const capturedAt = now - USAGE_STALE_AFTER_MS - 1;
    expect(
      usageFreshness({ usedPercent: 40, resetsAt: now - 1 }, capturedAt, now),
    ).toBe("expired");
  });

  it("falls back to age when a window carries no reset time", () => {
    expect(usageFreshness({ usedPercent: 40 }, now, now)).toBe("live");
    expect(
      usageFreshness({ usedPercent: 40 }, now - USAGE_STALE_AFTER_MS - 1, now),
    ).toBe("stale");
  });

  it("treats an absent cell and an unknown capture time as live", () => {
    expect(usageFreshness(undefined, undefined, now)).toBe("live");
    expect(
      usageFreshness(
        { usedPercent: 40, resetsAt: now + 60_000 },
        undefined,
        now,
      ),
    ).toBe("live");
  });
});

describe("durationSeverity", () => {
  it("turns critical only once a full day has elapsed", () => {
    expect(durationSeverity(0)).toBe("");
    expect(durationSeverity(86_400_000 - 1)).toBe("");
    expect(durationSeverity(86_400_000)).toBe("crit");
  });
});

describe("fmtResetCountdown", () => {
  it("renders at minute resolution with zero-padded minutes past an hour", () => {
    expect(fmtResetCountdown(23 * 60_000)).toBe("23m");
    expect(fmtResetCountdown((60 + 3) * 60_000)).toBe("1h 03m");
  });

  it("shows a floor marker under a minute and clamps negatives", () => {
    expect(fmtResetCountdown(30_000)).toBe("<1m");
    expect(fmtResetCountdown(-5_000)).toBe("<1m");
  });
});

describe("fmtWeekResetCountdown", () => {
  it("always renders days through seconds, zero-padding non-leading units", () => {
    expect(
      fmtWeekResetCountdown(
        6 * 86_400_000 + 8 * 3_600_000 + 2 * 60_000 + 3_000,
      ),
    ).toBe("6d 08h 02m 03s");
    expect(fmtWeekResetCountdown(9_000)).toBe("0d 00h 00m 09s");
  });

  it("clamps negatives to zero", () => {
    expect(fmtWeekResetCountdown(-5_000)).toBe("0d 00h 00m 00s");
  });
});

describe("severity bands", () => {
  it("maps usage percentages to statusline bands", () => {
    expect(usageSeverity(10)).toBe("");
    expect(usageSeverity(50)).toBe("warn");
    expect(usageSeverity(75)).toBe("high");
    expect(usageSeverity(91)).toBe("crit");
  });

  it("maps raw token totals to their thresholds", () => {
    expect(tokenSeverity(1_000_000)).toBe("");
    expect(tokenSeverity(1_500_000)).toBe("warn");
    expect(tokenSeverity(3_000_000)).toBe("crit");
  });
});

describe("severity with configured thresholds", () => {
  const band = (enabled: boolean, value: number) => ({ enabled, value });

  it("honors custom usage boundaries", () => {
    const t = {
      warn: band(true, 40),
      high: band(true, 60),
      crit: band(true, 80),
    };
    expect(usageSeverity(39, t)).toBe("");
    expect(usageSeverity(40, t)).toBe("warn");
    expect(usageSeverity(60, t)).toBe("high");
    expect(usageSeverity(80, t)).toBe("crit");
  });

  it("falls through a disabled band to the next lower enabled one", () => {
    const critOff = {
      warn: band(true, 50),
      high: band(true, 75),
      crit: band(false, 91),
    };
    expect(usageSeverity(95, critOff)).toBe("high");

    const highOff = {
      warn: band(true, 50),
      high: band(false, 75),
      crit: band(true, 91),
    };
    expect(usageSeverity(80, highOff)).toBe("warn");
    expect(usageSeverity(95, highOff)).toBe("crit");
  });

  it("returns no severity when every band is disabled", () => {
    const allOff = {
      warn: band(false, 50),
      high: band(false, 75),
      crit: band(false, 91),
    };
    expect(usageSeverity(99, allOff)).toBe("");
  });

  it("falls through tokens crit to warn when crit is disabled", () => {
    const t = { warn: band(true, 1_500_000), crit: band(false, 3_000_000) };
    expect(tokenSeverity(5_000_000, t)).toBe("warn");
  });

  it("never colors elapsed when its crit band is disabled", () => {
    expect(
      durationSeverity(999_999_999, { crit: band(false, 86_400_000) }),
    ).toBe("");
    expect(durationSeverity(100, { crit: band(true, 100) })).toBe("crit");
  });
});

describe("fmtResetClock", () => {
  const base = { locale: "en-GB", timeZone: "UTC" };
  const noon = Date.UTC(2026, 0, 1, 12, 0, 0);

  it("renders a bare clock when the reset is within a day", () => {
    expect(fmtResetClock(noon + 3 * 3_600_000, { now: noon, ...base })).toBe(
      "15:00",
    );
  });

  it("prefixes the weekday when the reset is a day or more out", () => {
    const twoDaysOut = noon + 2 * 86_400_000 + 3 * 3_600_000;
    expect(fmtResetClock(twoDaysOut, { now: noon, ...base })).toBe("Sat 15:00");
  });

  it("follows the locale's clock convention", () => {
    expect(
      fmtResetClock(noon + 3 * 3_600_000, {
        now: noon,
        locale: "en-US",
        timeZone: "UTC",
      }),
    ).toMatch(/03:00.PM/);
  });
});

describe("usageBandReached", () => {
  const band = (enabled: boolean, value: number) => ({ enabled, value });

  it("is true only for a defined limit at or over an enabled band", () => {
    expect(usageBandReached(undefined, band(true, 91))).toBe(false);
    expect(usageBandReached({ usedPercent: 90 }, band(true, 91))).toBe(false);
    expect(usageBandReached({ usedPercent: 91 }, band(true, 91))).toBe(true);
    expect(usageBandReached({ usedPercent: 99 }, band(false, 91))).toBe(false);
  });
});

describe("usageRemainingPercent", () => {
  it("returns the headroom clamped to 0..100", () => {
    expect(usageRemainingPercent(91)).toBe(9);
    expect(usageRemainingPercent(0)).toBe(100);
    expect(usageRemainingPercent(120)).toBe(0);
  });
});

describe("clampFiveHourWhenLimited", () => {
  const limits = {
    fiveHour: { usedPercent: 73, resetsAt: 1_200 },
    week: { usedPercent: 32, resetsAt: 9_000 },
  };

  it("forces the five-hour percent to 100 while a session shows the limit banner", () => {
    expect(clampFiveHourWhenLimited(limits, true)).toEqual({
      fiveHour: { usedPercent: 100, resetsAt: 1_200 },
      week: { usedPercent: 32, resetsAt: 9_000 },
    });
  });

  it("passes the reading through while no session is limited", () => {
    expect(clampFiveHourWhenLimited(limits, false)).toBe(limits);
  });

  it("passes through null and a reading without a five-hour limit", () => {
    expect(clampFiveHourWhenLimited(null, true)).toBeNull();
    const weekOnly = { week: { usedPercent: 32, resetsAt: 9_000 } };
    expect(clampFiveHourWhenLimited(weekOnly, true)).toBe(weekOnly);
  });
});

describe("usageDisplayMs", () => {
  it("returns the raw time to reset in remaining mode", () => {
    expect(usageDisplayMs("remaining", 5_000, 1_000, FIVE_HOUR_WINDOW_MS)).toBe(
      4_000,
    );
  });

  it("derives elapsed as window minus remaining", () => {
    const now = 1_000;
    const resetsAt = now + 2 * 3_600_000;
    expect(usageDisplayMs("elapsed", resetsAt, now, FIVE_HOUR_WINDOW_MS)).toBe(
      3 * 3_600_000,
    );
  });

  it("clamps elapsed into [0, window] past the reset", () => {
    const now = 10_000;
    expect(usageDisplayMs("elapsed", now - 1_000, now, WEEK_WINDOW_MS)).toBe(
      WEEK_WINDOW_MS,
    );
    expect(
      usageDisplayMs(
        "elapsed",
        now + WEEK_WINDOW_MS + 1_000,
        now,
        WEEK_WINDOW_MS,
      ),
    ).toBe(0);
  });
});

describe("nextUsageTimeMode", () => {
  it("toggles between the two modes", () => {
    expect(nextUsageTimeMode("remaining")).toBe("elapsed");
    expect(nextUsageTimeMode("elapsed")).toBe("remaining");
  });
});

describe("usage time mode persistence", () => {
  function memoryStorage(seed?: string) {
    const map = new Map<string, string>();
    if (seed !== undefined) map.set("zk.footer.usageTimeMode", seed);
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      read: () => map.get("zk.footer.usageTimeMode"),
    };
  }

  it("defaults to remaining when unset, null storage, or unrecognized", () => {
    expect(loadUsageTimeMode(null)).toBe("remaining");
    expect(loadUsageTimeMode(memoryStorage())).toBe("remaining");
    expect(loadUsageTimeMode(memoryStorage("bogus"))).toBe("remaining");
  });

  it("round-trips a saved mode", () => {
    const storage = memoryStorage();
    saveUsageTimeMode(storage, "elapsed");
    expect(storage.read()).toBe("elapsed");
    expect(loadUsageTimeMode(storage)).toBe("elapsed");
  });
});
