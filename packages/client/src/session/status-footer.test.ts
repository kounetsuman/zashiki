import { describe, expect, it } from "vitest";

import {
  fmtDuration,
  fmtResetCountdown,
  fmtTokens,
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

  it("clamps negatives to zero", () => {
    expect(fmtDuration(-1_000)).toBe("0s");
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
