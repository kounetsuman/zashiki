import { describe, expect, it } from "vitest";

import {
  claudeSessionId,
  clientMessageSchema,
  focusRequestSchema,
  focusResponseSchema,
  resumeCommand,
  serverMessageSchema,
  sessionInfoSchema,
  termIdSchema,
  windowIdSchema,
} from "./protocol.js";

describe("resumeCommand", () => {
  it("returns claude --resume <sid> when a sid is present", () => {
    expect(resumeCommand({ sid: "0b6cbc45-83a9-4f2e-9c3d-1a2b3c4d5e6f" })).toBe(
      "claude --resume 0b6cbc45-83a9-4f2e-9c3d-1a2b3c4d5e6f",
    );
  });

  it("returns null when the sid is missing/empty (the caller disables the menu)", () => {
    expect(resumeCommand({})).toBeNull();
    expect(resumeCommand({ sid: undefined })).toBeNull();
    expect(resumeCommand({ sid: "" })).toBeNull();
  });
});

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

describe("windowIdSchema", () => {
  it("accepts tmux's @N", () => {
    expect(windowIdSchema.safeParse("@0").success).toBe(true);
    expect(windowIdSchema.safeParse("@42").success).toBe(true);
  });

  it("accepts an owned UUID", () => {
    // The owned backend's windowId is a SessionRegistry UUID. Rejecting it here would
    // discard the entire state.sync originating from owned, so new/restored sessions would never appear in the list.
    expect(
      windowIdSchema.safeParse("0954e103-14ff-4406-bc6c-325449ef07ba").success,
    ).toBe(true);
  });

  it("rejects separator characters, empty, and a bare @", () => {
    expect(windowIdSchema.safeParse("work:1").success).toBe(false);
    expect(windowIdSchema.safeParse("@").success).toBe(false);
    expect(windowIdSchema.safeParse("").success).toBe(false);
    expect(windowIdSchema.safeParse("a b").success).toBe(false);
  });
});

describe("sessionInfoSchema", () => {
  it("accepts SessionInfo (state includes unknown)", () => {
    const info = {
      windowId: "@3",
      name: "zashiki",
      org: "kilo",
      repo: "zashiki",
      state: "unknown",
      title: null,
      active: true,
    };
    expect(sessionInfoSchema.parse(info)).toEqual(info);
  });
  it("optionally accepts sid (the key for a custom title)", () => {
    const info = {
      windowId: "@3",
      name: "zashiki",
      org: "kilo",
      repo: "zashiki",
      state: "idle",
      title: null,
      sid: "0b6cbc45-83a9-4f2e-9c3d-1a2b3c4d5e6f",
      active: true,
    };
    expect(sessionInfoSchema.parse(info)).toEqual(info);
  });
  it("rejects an unknown state", () => {
    expect(
      sessionInfoSchema.safeParse({
        windowId: "@3",
        name: "x",
        org: "",
        repo: "x",
        state: "sleeping",
        title: null,
        active: false,
      }).success,
    ).toBe(false);
  });
});

describe("clientMessageSchema", () => {
  const termId = "c0a8012e-1111-4222-8333-444455556666";
  it.each([
    [{ t: "term.open", termId, cols: 80, rows: 24 }],
    [{ t: "term.open", termId, windowId: "@1", cols: 80, rows: 24 }],
    [{ t: "term.resize", termId, cols: 120, rows: 40 }],
    [{ t: "term.select", termId, windowId: "@2" }],
    [{ t: "term.close", termId }],
    [{ t: "session.new", org: "kilo" }],
    [{ t: "session.close", windowId: "@5" }],
    [{ t: "state.refresh" }],
    [{ t: "config.update", language: "ja" }],
    [{ t: "config.update", language: "en" }],
  ])("accepts: %j", (msg) => {
    expect(clientMessageSchema.parse(msg)).toEqual(msg);
  });

  it.each([
    [{ t: "term.open", termId }], // cols/rows missing
    [{ t: "term.open", termId, cols: 0, rows: 24 }], // cols out of range
    [{ t: "term.open", termId, cols: 80.5, rows: 24 }], // non-integer
    [{ t: "term.select", termId, windowId: "work:1" }], // invalid windowId format (separator character)
    [{ t: "state.sync", sessions: [], orgs: [] }], // server→client message
    [{ t: "config.update", language: "fr" }], // unsupported language
    [{ t: "config.update" }], // language missing
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
        sessions: [
          {
            windowId: "@1",
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
      // owned: a state.sync whose windowId is a UUID is also accepted in full (rejecting it
      // would make decodeServerMessage discard the entire message, so new/restored sessions would not appear in the list).
      {
        t: "state.sync",
        sessions: [
          {
            windowId: "0954e103-14ff-4406-bc6c-325449ef07ba",
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
    [{ t: "notify", kind: "waiting", windowId: "@1", title: "x" }],
    [{ t: "notify", kind: "done", windowId: "@2", title: "" }],
    [{ t: "select", windowId: "@3" }],
    [{ t: "select", windowId: "0954e103-14ff-4406-bc6c-325449ef07ba" }],
    [{ t: "error", code: "work_not_found", message: "work session not found" }],
    [
      {
        t: "config.sync",
        notifySound: true,
        debug: false,
        updateCheck: true,
        language: "ja",
      },
    ],
    [
      {
        t: "config.sync",
        notifySound: false,
        debug: true,
        updateCheck: false,
        language: null,
      },
    ],
  ])("accepts: %j", (msg) => {
    expect(serverMessageSchema.parse(msg)).toEqual(msg);
  });

  it("defaults omitted config.sync updateCheck/language (compatible with old servers)", () => {
    expect(
      serverMessageSchema.parse({
        t: "config.sync",
        notifySound: true,
        debug: false,
      }),
    ).toEqual({
      t: "config.sync",
      notifySound: true,
      debug: false,
      updateCheck: true,
      language: null,
    });
  });

  it.each([
    [{ t: "notify", kind: "other", windowId: "@1", title: "x" }],
    [{ t: "select" }], // windowId missing
    [{ t: "select", windowId: "work:1" }], // invalid windowId format
    [{ t: "term.open", termId: "abc", cols: 80, rows: 24 }], // client→server message
    [{ t: "error", code: "x" }], // message missing
    [{ t: "config.sync", notifySound: true }], // debug missing
    [{ t: "config.sync", notifySound: "yes", debug: false }], // wrong type
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

  it("accepts a resolved response carrying the windowId and an unresolved one", () => {
    expect(
      focusResponseSchema.parse({ resolved: true, windowId: "@1" }),
    ).toEqual({ resolved: true, windowId: "@1" });
    expect(focusResponseSchema.parse({ resolved: false })).toEqual({
      resolved: false,
    });
  });

  it("rejects a response with a malformed windowId", () => {
    expect(
      focusResponseSchema.safeParse({ resolved: true, windowId: "work:1" })
        .success,
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
