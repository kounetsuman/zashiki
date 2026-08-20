import { describe, expect, it } from "vitest";

import { decodeServerMessage, encodeClientMessage } from "./protocol.js";

describe("encodeClientMessage", () => {
  it("validates the schema and serializes to a JSON string", () => {
    const s = encodeClientMessage({
      t: "term.open",
      termId: "abc",
      cols: 80,
      rows: 24,
    });
    expect(JSON.parse(s)).toEqual({
      t: "term.open",
      termId: "abc",
      cols: 80,
      rows: 24,
    });
  });

  it("throws on schema violation (detected before sending)", () => {
    // cockpitTerminalId is typed as string, but its format is validated at runtime with
    // zod (an @N or owned opaque id; values containing separators are invalid).
    expect(() =>
      encodeClientMessage({
        t: "term.select",
        termId: "abc",
        cockpitTerminalId: "not a window",
      }),
    ).toThrow();
  });
});

describe("decodeServerMessage", () => {
  it("parses a valid server message", () => {
    expect(decodeServerMessage(JSON.stringify({ t: "git.dirty" }))).toEqual({
      t: "git.dirty",
    });
    expect(
      decodeServerMessage(
        JSON.stringify({
          t: "state.sync",
          cockpitTerminals: [],
          orgs: [],
          orgColors: {},
        }),
      ),
    ).toEqual({
      t: "state.sync",
      cockpitTerminals: [],
      orgs: [],
      orgColors: {},
    });
  });

  it("returns null for invalid JSON, schema violations, and non-strings (does not throw)", () => {
    expect(decodeServerMessage("not-json{{{")).toBeNull();
    expect(decodeServerMessage(JSON.stringify({ t: "nope" }))).toBeNull();
    expect(decodeServerMessage(12345)).toBeNull();
    expect(decodeServerMessage(new ArrayBuffer(4))).toBeNull();
  });
});
