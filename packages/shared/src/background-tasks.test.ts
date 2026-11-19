import { describe, expect, it } from "vitest";

import {
  type BackgroundTaskFacts,
  backgroundTaskStatus,
  DEFAULT_STALL_RULES,
  launchLimitMinFor,
  type StallRules,
} from "./background-tasks.js";

const MIN = 60_000;
const NOW = 1_800_000_000_000;

function running(over: Partial<BackgroundTaskFacts> = {}): BackgroundTaskFacts {
  return {
    command: "pnpm test",
    phase: "running",
    startedAt: NOW - 3 * MIN,
    outputModifiedAt: NOW - 2_000,
    lastLine: "ok",
    lastLineRepeats: 1,
    ...over,
  };
}

describe("backgroundTaskStatus", () => {
  it("a fresh task with changing output is running", () => {
    expect(backgroundTaskStatus(running(), NOW, DEFAULT_STALL_RULES)).toEqual({
      kind: "running",
    });
  });

  it("stalls once launched longer ago than the launch limit", () => {
    const status = backgroundTaskStatus(
      running({ startedAt: NOW - 21 * MIN }),
      NOW,
      DEFAULT_STALL_RULES,
    );
    expect(status).toEqual({
      kind: "stalled",
      reasons: [{ kind: "launch_age", limitMin: 20 }],
    });
  });

  it("stalls when the output has not changed for the quiet limit", () => {
    const status = backgroundTaskStatus(
      running({ outputModifiedAt: NOW - 5 * MIN - 1 }),
      NOW,
      DEFAULT_STALL_RULES,
    );
    expect(status).toEqual({
      kind: "stalled",
      reasons: [{ kind: "quiet", limitMin: 5 }],
    });
  });

  it("falls back to the launch time when the output file was never seen", () => {
    const status = backgroundTaskStatus(
      running({ outputModifiedAt: undefined, startedAt: NOW - 6 * MIN }),
      NOW,
      DEFAULT_STALL_RULES,
    );
    expect(status.kind).toBe("stalled");
  });

  it("stalls when the last line repeats the repeat limit times", () => {
    const status = backgroundTaskStatus(
      running({ lastLine: "waiting for lock", lastLineRepeats: 5 }),
      NOW,
      DEFAULT_STALL_RULES,
    );
    expect(status).toEqual({
      kind: "stalled",
      reasons: [{ kind: "repeat", line: "waiting for lock", count: 5 }],
    });
    expect(
      backgroundTaskStatus(
        running({ lastLine: "waiting", lastLineRepeats: 4 }),
        NOW,
        DEFAULT_STALL_RULES,
      ).kind,
    ).toBe("running");
  });

  it("lists every rule that fired, in a fixed order", () => {
    const status = backgroundTaskStatus(
      running({
        startedAt: NOW - 40 * MIN,
        outputModifiedAt: NOW - 30 * MIN,
        lastLine: "w",
        lastLineRepeats: 42,
      }),
      NOW,
      DEFAULT_STALL_RULES,
    );
    expect(
      status.kind === "stalled" ? status.reasons.map((r) => r.kind) : [],
    ).toEqual(["launch_age", "quiet", "repeat"]);
  });

  it("an ended task carries its notice, or nothing while it is not written yet", () => {
    expect(
      backgroundTaskStatus(
        { ...running(), phase: "ended", endStatus: "failed", exitCode: 3 },
        NOW,
        DEFAULT_STALL_RULES,
      ),
    ).toEqual({ kind: "ended", endStatus: "failed", exitCode: 3 });
    expect(
      backgroundTaskStatus(
        { ...running({ startedAt: NOW - 90 * MIN }), phase: "ended" },
        NOW,
        DEFAULT_STALL_RULES,
      ),
    ).toEqual({ kind: "ended" });
  });

  it("a disconnected task is never stalled", () => {
    expect(
      backgroundTaskStatus(
        { ...running({ startedAt: NOW - 90 * MIN }), phase: "disconnected" },
        NOW,
        DEFAULT_STALL_RULES,
      ),
    ).toEqual({ kind: "disconnected" });
  });
});

describe("launchLimitMinFor", () => {
  const rules: StallRules = {
    ...DEFAULT_STALL_RULES,
    overrides: [
      { match: "  ", launchLimitMin: 1 },
      { match: "make ci", launchLimitMin: 25 },
      { match: "make", launchLimitMin: 40 },
    ],
  };

  it("uses the first override whose text the command contains", () => {
    expect(
      launchLimitMinFor(
        "cd ~/w/wonder-api && make ci > log/ci.log 2>&1",
        rules,
      ),
    ).toBe(25);
    expect(launchLimitMinFor("make build", rules)).toBe(40);
  });

  it("falls back to the default and ignores blank overrides", () => {
    expect(launchLimitMinFor("sleep 3600", rules)).toBe(20);
  });

  it("an override raises the launch limit for that command", () => {
    const status = backgroundTaskStatus(
      running({ command: "make ci", startedAt: NOW - 22 * MIN }),
      NOW,
      rules,
    );
    expect(status.kind).toBe("running");
  });
});
