import { describe, expect, it } from "vitest";

import {
  canCreatePty,
  countDistinctTtys,
  isPtyExhaustionError,
  isPtyLevelEscalation,
  nextPtyLevel,
  PTY_MAX_FALLBACK,
  type PtyBudget,
  type PtyLevel,
  parsePtyMax,
  ptyUsageRatio,
  translatePtyError,
} from "./pty-budget.js";

describe("countDistinctTtys (counting distinct real ttys from the leading ps -o tty= column)", () => {
  it("counts distinct ttysNNN and counts a shared tty as 1", () => {
    const out = [
      "ttys003  -zsh",
      "ttys003  claude --session-id x", // same tty → not duplicated
      "ttys004  vim",
      "ttys010  node",
    ].join("\n");
    expect(countDistinctTtys(out)).toBe(3);
  });

  it("excludes ?? / - / empty / non-macOS format (pts/N) as having no controlling terminal", () => {
    const out = [
      "??       /sbin/launchd",
      "-        some-daemon",
      "         ", // blank line
      "pts/3    linux-shell", // non-macOS format is not counted
      "ttys007  -zsh",
    ].join("\n");
    expect(countDistinctTtys(out)).toBe(1);
  });

  it("picks up the leading token even with surrounding whitespace or a right-aligned column", () => {
    const out = "  ttys012    -zsh\n\tttys012\tclaude\n";
    expect(countDistinctTtys(out)).toBe(1);
  });

  it("returns 0 for an empty string", () => {
    expect(countDistinctTtys("")).toBe(0);
  });
});

describe("parsePtyMax (sysctl output → limit; invalid falls back)", () => {
  it.each([
    ["511\n", 511],
    ["  1024 ", 1024],
    ["", PTY_MAX_FALLBACK],
    ["abc", PTY_MAX_FALLBACK],
    ["0", PTY_MAX_FALLBACK],
    ["-1", PTY_MAX_FALLBACK],
    ["3.5", PTY_MAX_FALLBACK],
  ])("parsePtyMax(%o) = %i", (input, expected) => {
    expect(parsePtyMax(input)).toBe(expected);
  });
});

describe("ptyUsageRatio (guards against divide-by-zero and invalid max)", () => {
  it.each<[PtyBudget, number]>([
    [{ used: 0, max: 100 }, 0],
    [{ used: 80, max: 100 }, 0.8],
    [{ used: 100, max: 100 }, 1],
    [{ used: 5, max: 0 }, 0], // max<=0 is 0 (not a silent ok; a separate fallback makes max positive)
    [{ used: 5, max: -1 }, 0],
    [{ used: 5, max: Number.NaN }, 0],
  ])("ratio(%o) = %d", (budget, expected) => {
    expect(ptyUsageRatio(budget)).toBeCloseTo(expected, 6);
  });
});

describe("nextPtyLevel (level transitions with hysteresis)", () => {
  const max = 100;
  it("from ok: >=0.95 → block, >=0.8 → warn, below that → ok", () => {
    expect(nextPtyLevel("ok", { used: 79, max })).toBe("ok");
    expect(nextPtyLevel("ok", { used: 80, max })).toBe("warn");
    expect(nextPtyLevel("ok", { used: 95, max })).toBe("block");
  });

  it("when dropping from warn, reaches ok only below 0.75 (deadband)", () => {
    expect(nextPtyLevel("warn", { used: 78, max })).toBe("warn"); // 0.78 stays
    expect(nextPtyLevel("warn", { used: 75, max })).toBe("warn"); // 0.75 stays
    expect(nextPtyLevel("warn", { used: 74, max })).toBe("ok"); // drops at 0.74
    expect(nextPtyLevel("warn", { used: 95, max })).toBe("block"); // escalation is immediate
  });

  it("when dropping from block, reaches warn only below 0.90 (deadband)", () => {
    expect(nextPtyLevel("block", { used: 92, max })).toBe("block"); // 0.92 stays
    expect(nextPtyLevel("block", { used: 90, max })).toBe("block"); // 0.90 stays
    expect(nextPtyLevel("block", { used: 89, max })).toBe("warn"); // moves to warn at 0.89
    expect(nextPtyLevel("block", { used: 70, max })).toBe("ok"); // ok if it drops all at once
  });

  it("does not oscillate warn↔block infinitely across the 0.949↔0.951 boundary (block holds down to 0.90)", () => {
    let level: PtyLevel = "ok";
    level = nextPtyLevel(level, { used: 95, max }); // 0.95 → block
    expect(level).toBe("block");
    level = nextPtyLevel(level, { used: 94, max }); // 0.94 → block stays (>= 0.90)
    expect(level).toBe("block");
    level = nextPtyLevel(level, { used: 95, max }); // block stays
    expect(level).toBe("block");
  });
});

describe("isPtyLevelEscalation (notify only on escalation)", () => {
  it.each<[PtyLevel, PtyLevel, boolean]>([
    ["ok", "warn", true],
    ["ok", "block", true],
    ["warn", "block", true],
    ["warn", "warn", false],
    ["block", "warn", false],
    ["block", "ok", false],
    ["warn", "ok", false],
  ])("escalation(%s → %s) = %s", (prev, next, expected) => {
    expect(isPtyLevelEscalation(prev, next)).toBe(expected);
  });
});

describe("canCreatePty (absolute-slot fail-fast; does not block by ratio)", () => {
  const max = 100; // RESERVE=8 → allowed if used after creation is 92 or below

  it("can create even at a high ratio when enough slots remain (avoids the 27-slot problem)", () => {
    // used=88, need=1 → projected 89 <= 92 → allowed (passes even at ratio 0.88)
    expect(canCreatePty({ used: 88, max }, { need: 1 })).toBe(true);
  });

  it("cannot create beyond max - RESERVE", () => {
    expect(canCreatePty({ used: 91, max }, { need: 1 })).toBe(true); // 92<=92
    expect(canCreatePty({ used: 92, max }, { need: 1 })).toBe(false); // 93>92
  });

  it("accounts for inflight (accepted creations not yet reflected in the measurement)", () => {
    // used=88 + inflight=4 + need=1 = 93 > 92 → prevents a burst from slipping through
    expect(canCreatePty({ used: 88, max }, { need: 1, inflight: 4 })).toBe(
      false,
    );
    expect(canCreatePty({ used: 88, max }, { need: 1, inflight: 3 })).toBe(
      true,
    );
  });

  it("counts a need greater than one (e.g. creating in bulk during restore)", () => {
    expect(canCreatePty({ used: 80, max }, { need: 12 })).toBe(true); // 92<=92
    expect(canCreatePty({ used: 80, max }, { need: 13 })).toBe(false); // 93>92
  });

  it("does not allow creation when max<=0 (invalid) (fail-closed)", () => {
    expect(canCreatePty({ used: 0, max: 0 }, { need: 1 })).toBe(false);
    expect(canCreatePty({ used: 0, max: Number.NaN }, { need: 1 })).toBe(false);
  });
});

describe("isPtyExhaustionError (only ENXIO-family; does not match EAGAIN fork failed)", () => {
  it.each([
    [
      "tmux new-window failed: open terminal failed: Device not configured",
      true,
    ],
    ["fork failed: Device not configured", true],
    ["posix_openpt: ENXIO", true],
    ["openpty failed", true],
    ["no more ptys available", true],
    ["fork failed: Resource temporarily unavailable", false], // EAGAIN=process-count limit, a different cause
    ["some unrelated tmux error", false],
    ["", false],
  ])("isPtyExhaustionError(%o) = %s", (msg, expected) => {
    expect(isPtyExhaustionError(msg)).toBe(expected);
  });
});

describe("translatePtyError (typed message; used is a lower bound shown with ≥)", () => {
  it("includes usage/limit and appends the original text", () => {
    const budget: PtyBudget = { used: 498, max: 511 };
    const out = translatePtyError("fork failed: Device not configured", budget);
    expect(out).toContain("≥498");
    expect(out).toContain("511");
    expect(out).toContain("Device not configured"); // original text for debugging
    expect(out).toContain("PTY");
  });
});
