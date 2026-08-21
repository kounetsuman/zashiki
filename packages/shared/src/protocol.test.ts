import { describe, expect, it } from "vitest";

import {
  claudeSessionId,
  clientMessageSchema,
  cockpitTerminalIdSchema,
  cockpitTerminalInfoSchema,
  focusRequestSchema,
  focusResponseSchema,
  serverMessageSchema,
  termIdSchema,
} from "./protocol.js";

describe("claudeSessionId", () => {
  it("returns the sid verbatim when present", () => {
    expect(
      claudeSessionId({ sid: "0b6cbc45-83a9-4f2e-9c3d-1a2b3c4d5e6f" }),
    ).toBe("0b6cbc45-83a9-4f2e-9c3d-1a2b3c4d5e6f");
  });

  it("returns null when the sid is missing/empty (the caller disables the menu)", () => {
    expect(claudeSessionId({})).toBeNull();
    expect(claudeSessionId({ sid: undefined })).toBeNull();
    expect(claudeSessionId({ sid: "" })).toBeNull();
  });
});

describe("termIdSchema", () => {
  it("accepts the UUID format", () => {
    expect(
      termIdSchema.safeParse("c0a8012e-1111-4222-8333-444455556666").success,
    ).toBe(true);
  });
  it("allows only alphanumerics and hyphens (because it is embedded in a tmux session name)", () => {
    expect(termIdSchema.safeParse("abc_def").success).toBe(false);
    expect(termIdSchema.safeParse("a b").success).toBe(false);
    expect(termIdSchema.safeParse("a:b").success).toBe(false);
    expect(termIdSchema.safeParse("").success).toBe(false);
    expect(termIdSchema.safeParse("-leading").success).toBe(false);
    expect(termIdSchema.safeParse("a".repeat(65)).success).toBe(false);
  });
});

describe("cockpitTerminalIdSchema", () => {
  it("accepts tmux's @N", () => {
    expect(cockpitTerminalIdSchema.safeParse("@0").success).toBe(true);
    expect(cockpitTerminalIdSchema.safeParse("@42").success).toBe(true);
  });

  it("accepts an owned UUID", () => {
    // The owned backend's cockpitTerminalId is a SessionRegistry UUID. Rejecting it here would
    // discard the entire state.sync originating from owned, so new/restored cockpit terminals would never appear in the list.
    expect(
      cockpitTerminalIdSchema.safeParse("0954e103-14ff-4406-bc6c-325449ef07ba")
        .success,
    ).toBe(true);
  });

  it("rejects separator characters, empty, and a bare @", () => {
    expect(cockpitTerminalIdSchema.safeParse("work:1").success).toBe(false);
    expect(cockpitTerminalIdSchema.safeParse("@").success).toBe(false);
    expect(cockpitTerminalIdSchema.safeParse("").success).toBe(false);
    expect(cockpitTerminalIdSchema.safeParse("a b").success).toBe(false);
  });
});

describe("cockpitTerminalInfoSchema", () => {
  it("accepts CockpitTerminalInfo (state includes unknown)", () => {
    const info = {
      cockpitTerminalId: "@3",
      name: "zashiki",
      org: "kilo",
      repo: "zashiki",
      state: "unknown",
      title: null,
      active: true,
    };
    expect(cockpitTerminalInfoSchema.parse(info)).toEqual(info);
  });
  it("optionally accepts sid (the key for a custom title)", () => {
    const info = {
      cockpitTerminalId: "@3",
      name: "zashiki",
      org: "kilo",
      repo: "zashiki",
      state: "idle",
      title: null,
      sid: "0b6cbc45-83a9-4f2e-9c3d-1a2b3c4d5e6f",
      active: true,
    };
    expect(cockpitTerminalInfoSchema.parse(info)).toEqual(info);
  });
  it("rejects an unknown state", () => {
    expect(
      cockpitTerminalInfoSchema.safeParse({
        cockpitTerminalId: "@3",
        name: "x",
        org: "",
        repo: "x",
        state: "sleeping",
        title: null,
        active: false,
      }).success,
    ).toBe(false);
  });
  // Wire parity with the Rust server's CockpitTerminalInfo.usage (crates/zashiki-server/src/protocol.rs).
  it("accepts the usage footer material with account limits", () => {
    const info = {
      cockpitTerminalId: "@1",
      name: "repo",
      org: "o",
      repo: "repo",
      state: "running",
      title: null,
      active: true,
      usage: {
        turnTokens: 1200,
        sessionTokens: 3400000,
        turnStartedAt: 1700000000000,
        sessionStartedAt: 1699999000000,
        limits: {
          fiveHour: { usedPercent: 42, resetsAt: 1700010000000 },
          week: { usedPercent: 61 },
        },
      },
    };
    expect(cockpitTerminalInfoSchema.parse(info)).toEqual(info);
  });
});

describe("clientMessageSchema", () => {
  const termId = "c0a8012e-1111-4222-8333-444455556666";
  it.each([
    [{ t: "term.open", termId, cols: 80, rows: 24 }],
    [{ t: "term.open", termId, cockpitTerminalId: "@1", cols: 80, rows: 24 }],
    [{ t: "term.resize", termId, cols: 120, rows: 40 }],
    [{ t: "term.select", termId, cockpitTerminalId: "@2" }],
    [{ t: "term.close", termId }],
    [{ t: "cockpitTerminal.new", org: "kilo" }],
    [
      {
        t: "cockpitTerminal.new",
        org: "kilo",
        resumeSid: "0b6cbc45-83a9-4f2e-9c3d-1a2b3c4d5e6f",
      },
    ],
    [{ t: "cockpitTerminal.close", cockpitTerminalId: "@5" }],
    [{ t: "state.refresh" }],
    [{ t: "config.update", language: "ja" }],
    [{ t: "config.update", language: "en" }],
    [{ t: "config.setAccountUsage", enabled: true }],
    [{ t: "config.setAccountUsage", enabled: false }],
    [{ t: "update.check" }],
    [{ t: "update.perform" }],
  ])("accepts: %j", (msg) => {
    expect(clientMessageSchema.parse(msg)).toEqual(msg);
  });

  it.each([
    [{ t: "term.open", termId }], // cols/rows missing
    [{ t: "term.open", termId, cols: 0, rows: 24 }], // cols out of range
    [{ t: "term.open", termId, cols: 80.5, rows: 24 }], // non-integer
    [{ t: "term.select", termId, cockpitTerminalId: "work:1" }], // invalid cockpitTerminalId format (separator character)
    [{ t: "state.sync", cockpitTerminals: [], orgs: [] }], // server→client message
    [{ t: "config.update", language: "fr" }], // unsupported language
    [{ t: "config.update" }], // language missing
    [{ t: "config.setAccountUsage" }], // enabled missing
    [{ t: "config.setAccountUsage", enabled: "yes" }], // enabled not a boolean
    [{ t: "nope" }],
    ["hello"],
    [null],
  ])("rejects: %j", (msg) => {
    expect(clientMessageSchema.safeParse(msg).success).toBe(false);
  });
});

describe("serverMessageSchema", () => {
  it.each([
    [
      {
        t: "state.sync",
        cockpitTerminals: [
          {
            cockpitTerminalId: "@1",
            name: "zashiki",
            org: "kilo",
            repo: "zashiki",
            state: "running",
            title: "issue #5 を実装して",
            active: true,
          },
        ],
        orgs: ["kilo"],
        orgColors: { kilo: "#7aa2f7" },
      },
    ],
    [
      // owned: a state.sync whose cockpitTerminalId is a UUID is also accepted in full (rejecting it
      // would make decodeServerMessage discard the entire message, so new/restored cockpit terminals would not appear in the list).
      {
        t: "state.sync",
        cockpitTerminals: [
          {
            cockpitTerminalId: "0954e103-14ff-4406-bc6c-325449ef07ba",
            name: "initech",
            org: "initech",
            repo: "initech",
            state: "no_claude",
            title: null,
            active: true,
            runningSubagents: 0,
          },
        ],
        orgs: ["acme", "globex", "initech"],
        orgColors: {},
      },
    ],
    [
      {
        t: "term.reconnect",
        termIds: ["c0a8012e-1111-4222-8333-444455556666"],
      },
    ],
    [{ t: "git.dirty" }],
    [{ t: "notify", kind: "waiting", cockpitTerminalId: "@1", title: "x" }],
    [{ t: "notify", kind: "done", cockpitTerminalId: "@2", title: "" }],
    [{ t: "select", cockpitTerminalId: "@3" }],
    [
      {
        t: "select",
        cockpitTerminalId: "0954e103-14ff-4406-bc6c-325449ef07ba",
      },
    ],
    [{ t: "error", code: "work_not_found", message: "work session not found" }],
    [
      {
        t: "config.sync",
        notifySound: true,
        updateCheck: true,
        language: "ja",
        accountUsage: true,
      },
    ],
    [
      {
        t: "config.sync",
        notifySound: false,
        updateCheck: false,
        language: null,
        accountUsage: false,
      },
    ],
    [{ t: "update.check.result", status: "available", version: "0.2.0" }],
    [{ t: "update.status", state: "running", detail: null }],
    [{ t: "update.status", state: "relaunching", detail: null }],
    [{ t: "update.status", state: "opened", detail: null }],
    [{ t: "update.status", state: "failed", detail: "boom" }],
  ])("accepts: %j", (msg) => {
    expect(serverMessageSchema.parse(msg)).toEqual(msg);
  });

  it("defaults omitted config.sync updateCheck/language/accountUsage (compatible with old servers)", () => {
    expect(
      serverMessageSchema.parse({
        t: "config.sync",
        notifySound: true,
      }),
    ).toEqual({
      t: "config.sync",
      notifySound: true,
      updateCheck: true,
      language: null,
      accountUsage: false,
    });
  });

  it.each([
    [{ t: "notify", kind: "other", cockpitTerminalId: "@1", title: "x" }],
    [{ t: "select" }], // cockpitTerminalId missing
    [{ t: "select", cockpitTerminalId: "work:1" }], // invalid cockpitTerminalId format
    [{ t: "term.open", termId: "abc", cols: 80, rows: 24 }], // client→server message
    [{ t: "error", code: "x" }], // message missing
    [{ t: "config.sync" }], // notifySound missing
    [{ t: "config.sync", notifySound: "yes" }], // wrong type
  ])("rejects: %j", (msg) => {
    expect(serverMessageSchema.safeParse(msg).success).toBe(false);
  });
});

describe("focus request/response (POST /api/focus)", () => {
  it("accepts a focus request with sid and/or cwd, and an empty one", () => {
    expect(focusRequestSchema.safeParse({ sid: "abc" }).success).toBe(true);
    expect(focusRequestSchema.safeParse({ cwd: "/repos/a" }).success).toBe(
      true,
    );
    expect(focusRequestSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a resolved response carrying the cockpitTerminalId and an unresolved one", () => {
    expect(
      focusResponseSchema.parse({ resolved: true, cockpitTerminalId: "@1" }),
    ).toEqual({ resolved: true, cockpitTerminalId: "@1" });
    expect(focusResponseSchema.parse({ resolved: false })).toEqual({
      resolved: false,
    });
  });

  it("rejects a response with a malformed cockpitTerminalId", () => {
    expect(
      focusResponseSchema.safeParse({
        resolved: true,
        cockpitTerminalId: "work:1",
      }).success,
    ).toBe(false);
  });
});

describe("termAckSchema (client→server flow-control ACK)", () => {
  it("accepts term.ack (bytes 0 is the signal to enable ACK)", () => {
    expect(
      clientMessageSchema.safeParse({ t: "term.ack", termId: "abc", bytes: 0 })
        .success,
    ).toBe(true);
    expect(
      clientMessageSchema.safeParse({
        t: "term.ack",
        termId: "abc",
        bytes: 65536,
      }).success,
    ).toBe(true);
  });
  it("rejects negative, non-integer, and excessive values", () => {
    expect(
      clientMessageSchema.safeParse({ t: "term.ack", termId: "abc", bytes: -1 })
        .success,
    ).toBe(false);
    expect(
      clientMessageSchema.safeParse({
        t: "term.ack",
        termId: "abc",
        bytes: 1.5,
      }).success,
    ).toBe(false);
    expect(
      clientMessageSchema.safeParse({
        t: "term.ack",
        termId: "abc",
        bytes: 2_000_000_000,
      }).success,
    ).toBe(false);
  });
});

describe("hooks integration messages", () => {
  it("accepts hooks.register / hooks.unregister from the client", () => {
    expect(clientMessageSchema.safeParse({ t: "hooks.register" }).success).toBe(
      true,
    );
    expect(
      clientMessageSchema.safeParse({ t: "hooks.unregister" }).success,
    ).toBe(true);
  });

  it("parses hooks.status and defaults its booleans off for old servers", () => {
    const full = serverMessageSchema.safeParse({
      t: "hooks.status",
      hooksRegistered: true,
      statusLineRegistered: false,
      statusLineConflict: true,
    });
    expect(full.success).toBe(true);
    const bare = serverMessageSchema.parse({ t: "hooks.status" });
    expect(bare).toEqual({
      t: "hooks.status",
      hooksRegistered: false,
      statusLineRegistered: false,
      statusLineConflict: false,
    });
  });
});
