import { describe, expect, it } from "vitest";

import {
  durationSeverity,
  fmtDuration,
  fmtResetClock,
  fmtResetCountdown,
  fmtTokens,
  fmtWeekResetCountdown,
  pickAccountLimits,
  tokenSeverity,
  usageBandReached,
  usageRemainingPercent,
  usageSeverity,
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
    expect(fmtResetCountdown((60 + 3) * 60_000)).toBe("1h03m");
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
    ).toBe("6d08h02m03s");
    expect(fmtWeekResetCountdown(9_000)).toBe("0d00h00m09s");
  });

  it("clamps negatives to zero", () => {
    expect(fmtWeekResetCountdown(-5_000)).toBe("0d00h00m00s");
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

describe("pickAccountLimits", () => {
  it("returns null when no session carries limits", () => {
    expect(pickAccountLimits([])).toBeNull();
    expect(pickAccountLimits([{ usage: null }, { usage: {} }])).toBeNull();
  });

  it("collapses to the freshest reading per limit, not the highest usedPercent", () => {
    const picked = pickAccountLimits([
      {
        usage: {
          limits: {
            fiveHour: { usedPercent: 55, resetsAt: 200 },
            week: { usedPercent: 99, resetsAt: 900 },
            updatedAt: 1_000,
          },
        },
      },
      {
        usage: {
          limits: {
            fiveHour: { usedPercent: 3, resetsAt: 300 },
            week: { usedPercent: 1, resetsAt: 950 },
            updatedAt: 2_000,
          },
        },
      },
    ]);
    expect(picked).toEqual({
      fiveHour: { usedPercent: 3, resetsAt: 300 },
      week: { usedPercent: 1, resetsAt: 950 },
    });
  });

  it("falls back per limit to the freshest reading that carries it", () => {
    const picked = pickAccountLimits([
      {
        usage: {
          limits: {
            fiveHour: { usedPercent: 40, resetsAt: 200 },
            week: { usedPercent: 70, resetsAt: 900 },
            updatedAt: 1_000,
          },
        },
      },
      {
        usage: {
          limits: {
            fiveHour: { usedPercent: 5, resetsAt: 300 },
            updatedAt: 2_000,
          },
        },
      },
    ]);
    expect(picked).toEqual({
      fiveHour: { usedPercent: 5, resetsAt: 300 },
      week: { usedPercent: 70, resetsAt: 900 },
    });
  });
});
