import type { CockpitTerminalInfo, SessionState } from "@zashiki/shared";
import { describe, expect, it } from "vitest";
import {
  buildVisibleItems,
  displayOrgs,
  focusKey,
  isFresh,
  nextFocusTarget,
} from "./session-list-model.js";

function session(
  cockpitTerminalId: string,
  org: string,
  extra: Partial<CockpitTerminalInfo> = {},
): CockpitTerminalInfo {
  return {
    cockpitTerminalId,
    org,
    name: org,
    state: "idle" as SessionState,
    title: null,
    ...extra,
  } as CockpitTerminalInfo;
}

describe("focusKey", () => {
  it("prefixes by kind so org and row keys never collide", () => {
    expect(focusKey({ kind: "org", org: "a" })).toBe("o:a");
    expect(focusKey({ kind: "row", cockpitTerminalId: "a" })).toBe("r:a");
  });
});

describe("displayOrgs", () => {
  it("keeps the configured order and appends detected orgs at the end", () => {
    const sessions = [session("w1", "z"), session("w2", "a")];
    expect(displayOrgs(["a", "b"], sessions)).toEqual(["a", "b", "z"]);
  });

  it("does not duplicate a detected org already in the list", () => {
    expect(displayOrgs(["a"], [session("w1", "a")])).toEqual(["a"]);
  });
});

describe("isFresh", () => {
  it("is fresh only when idle with no automatic or manual title", () => {
    expect(isFresh(session("w", "a"), undefined)).toBe(true);
    expect(isFresh(session("w", "a"), "custom")).toBe(false);
    expect(isFresh(session("w", "a", { title: "auto" }), undefined)).toBe(
      false,
    );
    expect(isFresh(session("w", "a", { state: "running" }), undefined)).toBe(
      false,
    );
  });
});

describe("buildVisibleItems", () => {
  const sessions = [session("w1", "a"), session("w2", "a"), session("w3", "b")];

  it("interleaves org headers with their rows in display order", () => {
    expect(buildVisibleItems(["a", "b"], sessions, new Set())).toEqual([
      { kind: "org", org: "a" },
      { kind: "row", cockpitTerminalId: "w1" },
      { kind: "row", cockpitTerminalId: "w2" },
      { kind: "org", org: "b" },
      { kind: "row", cockpitTerminalId: "w3" },
    ]);
  });

  it("keeps a collapsed org's header but drops its rows", () => {
    expect(buildVisibleItems(["a", "b"], sessions, new Set(["a"]))).toEqual([
      { kind: "org", org: "a" },
      { kind: "org", org: "b" },
      { kind: "row", cockpitTerminalId: "w3" },
    ]);
  });
});

describe("nextFocusTarget", () => {
  const sessions = [session("w1", "a"), session("w2", "a")];
  const items = buildVisibleItems(["a"], sessions, new Set());

  it("steps down from the current ring", () => {
    expect(
      nextFocusTarget(items, { kind: "org", org: "a" }, null, sessions, 1),
    ).toEqual({ kind: "row", cockpitTerminalId: "w1" });
  });

  it("steps up from the current ring", () => {
    expect(
      nextFocusTarget(
        items,
        { kind: "row", cockpitTerminalId: "w1" },
        null,
        sessions,
        -1,
      ),
    ).toEqual({ kind: "org", org: "a" });
  });

  it("clamps at the bottom edge", () => {
    expect(
      nextFocusTarget(
        items,
        { kind: "row", cockpitTerminalId: "w2" },
        null,
        sessions,
        1,
      ),
    ).toEqual({ kind: "row", cockpitTerminalId: "w2" });
  });

  it("clamps at the top edge", () => {
    expect(
      nextFocusTarget(items, { kind: "org", org: "a" }, null, sessions, -1),
    ).toEqual({ kind: "org", org: "a" });
  });

  it("ignores a selected window that is not in the session list", () => {
    expect(nextFocusTarget(items, null, "missing", sessions, 1)).toEqual({
      kind: "org",
      org: "a",
    });
  });

  it("with no ring, anchors on the visible selected row", () => {
    expect(nextFocusTarget(items, null, "w1", sessions, 1)).toEqual({
      kind: "row",
      cockpitTerminalId: "w2",
    });
  });

  it("with no ring and a collapsed selected row, anchors on its org header", () => {
    const collapsedItems = buildVisibleItems(["a"], sessions, new Set(["a"]));
    expect(nextFocusTarget(collapsedItems, null, "w1", sessions, 1)).toEqual({
      kind: "org",
      org: "a",
    });
  });

  it("with no anchor, a down step lands on the first item", () => {
    expect(nextFocusTarget(items, null, null, sessions, 1)).toEqual({
      kind: "org",
      org: "a",
    });
  });

  it("with no anchor, an up step lands on the last item", () => {
    expect(nextFocusTarget(items, null, null, sessions, -1)).toEqual({
      kind: "row",
      cockpitTerminalId: "w2",
    });
  });
});
