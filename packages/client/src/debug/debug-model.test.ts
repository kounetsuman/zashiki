import type { CockpitTerminalInfo, ServerMessage } from "@zashiki/shared";
import { describe, expect, it } from "vitest";

import {
  describeServerEvent,
  footerAbnormalNotice,
  isControlAbnormal,
  isTermAbnormal,
  pushRing,
  sessionName,
  summarizeSessions,
} from "./debug-model.js";

describe("sessionName", () => {
  it("derives zk-<termId> from the termId", () => {
    expect(sessionName("abc-123")).toBe("zk-abc-123");
  });
  it("null when there is no termId", () => {
    expect(sessionName(null)).toBeNull();
  });
});

describe("isControlAbnormal", () => {
  it("open is normal regardless of attempt", () => {
    expect(isControlAbnormal("open", 0)).toBe(false);
    expect(isControlAbnormal("open", 3)).toBe(false);
  });
  it("connecting right after startup (attempt=0) is normal (no false positive)", () => {
    expect(isControlAbnormal("connecting", 0)).toBe(false);
    expect(isControlAbnormal("closed", 0)).toBe(false);
  });
  it("accumulated reconnects (attempt>0) is abnormal", () => {
    expect(isControlAbnormal("closed", 1)).toBe(true);
    expect(isControlAbnormal("connecting", 2)).toBe(true);
  });
});

describe("isTermAbnormal", () => {
  it("treats only disposed as abnormal (transitional states are treated as normal)", () => {
    expect(isTermAbnormal("attached")).toBe(false);
    expect(isTermAbnormal("idle")).toBe(false);
    expect(isTermAbnormal("opening")).toBe(false);
    expect(isTermAbnormal("waiting-control")).toBe(false);
    expect(isTermAbnormal("reconnecting")).toBe(false);
    expect(isTermAbnormal("disposed")).toBe(true);
  });
});

describe("footerAbnormalNotice", () => {
  it("null when normal (shows nothing)", () => {
    expect(
      footerAbnormalNotice(
        { status: "open", attempt: 0, lastCloseCode: null },
        "attached",
      ),
    ).toBeNull();
    // connecting right after startup / idle with 0 cockpit terminals are also normal
    expect(
      footerAbnormalNotice(
        { status: "connecting", attempt: 0, lastCloseCode: null },
        "idle",
      ),
    ).toBeNull();
  });
  it("only control is abnormal (reconnecting)", () => {
    expect(
      footerAbnormalNotice(
        { status: "closed", attempt: 2, lastCloseCode: 1006 },
        "attached",
      ),
    ).toBe("接続に問題があります（control closed）");
  });
  it("both abnormal are concatenated", () => {
    expect(
      footerAbnormalNotice(
        { status: "closed", attempt: 1, lastCloseCode: null },
        "disposed",
      ),
    ).toBe("接続に問題があります（control closed / term disposed）");
  });
});

const cockpitTerminals: CockpitTerminalInfo[] = [
  {
    cockpitTerminalId: "@1",
    name: "zashiki",
    org: "kilo",
    repo: "zashiki",
    state: "running",
    title: null,
    active: true,
  },
  {
    cockpitTerminalId: "@2",
    name: "tango",
    org: "kilo",
    repo: "tango",
    state: "idle",
    title: null,
    active: false,
  },
];

describe("summarizeSessions", () => {
  it("formats each window into cockpitTerminalId/label/active/state", () => {
    expect(summarizeSessions(cockpitTerminals)).toEqual([
      {
        cockpitTerminalId: "@1",
        label: "kilo/zashiki zashiki",
        active: true,
        state: "running",
      },
      {
        cockpitTerminalId: "@2",
        label: "kilo/tango tango",
        active: false,
        state: "idle",
      },
    ]);
  });
});

describe("describeServerEvent", () => {
  it("formats notify", () => {
    const m: ServerMessage = {
      t: "notify",
      kind: "waiting",
      cockpitTerminalId: "@1",
      title: "zashiki",
    };
    expect(describeServerEvent(m)).toBe('notify waiting @1 "zashiki"');
  });
  it("formats git.dirty", () => {
    expect(describeServerEvent({ t: "git.dirty" })).toBe("git.dirty");
  });
  it("formats term.reconnect", () => {
    expect(
      describeServerEvent({ t: "term.reconnect", termIds: ["a", "b"] }),
    ).toBe("term.reconnect [a, b]");
  });
  it("does not push state.sync/error to the event log (null)", () => {
    expect(
      describeServerEvent({
        t: "state.sync",
        cockpitTerminals: [],
        orgs: [],
        orgColors: {},
        orgAliases: {},
      }),
    ).toBeNull();
    expect(
      describeServerEvent({ t: "error", code: "x", message: "y" }),
    ).toBeNull();
  });
});

describe("pushRing", () => {
  it("appends as-is while within the limit", () => {
    expect(pushRing([1, 2], 3, 5)).toEqual([1, 2, 3]);
  });
  it("drops the oldest first when exceeding the limit", () => {
    expect(pushRing([1, 2, 3], 4, 3)).toEqual([2, 3, 4]);
  });
  it("does not mutate the original array", () => {
    const buf = [1, 2, 3];
    pushRing(buf, 4, 3);
    expect(buf).toEqual([1, 2, 3]);
  });
});
