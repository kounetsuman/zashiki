import { describe, expect, it } from "vitest";

import {
  durationSeverity,
  fmtDuration,
  fmtResetCountdown,
  fmtTokens,
  pickAccountLimits,
  tokenSeverity,
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

describe("pickAccountLimits", () => {
  it("returns null when no session carries limits", () => {
    expect(pickAccountLimits([])).toBeNull();
    expect(pickAccountLimits([{ usage: null }, { usage: {} }])).toBeNull();
  });

  it("collapses to the highest usedPercent per limit, carrying its reset time", () => {
    const picked = pickAccountLimits([
      { usage: { limits: { fiveHour: { usedPercent: 20, resetsAt: 100 } } } },
      {
        usage: {
          limits: {
            fiveHour: { usedPercent: 55, resetsAt: 200 },
            week: { usedPercent: 40, resetsAt: 900 },
          },
        },
      },
    ]);
    expect(picked).toEqual({
      fiveHour: { usedPercent: 55, resetsAt: 200 },
      week: { usedPercent: 40, resetsAt: 900 },
    });
  });
});
