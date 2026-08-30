import type {
  CockpitTerminalInfo,
  CockpitTerminalState,
} from "@zashiki/shared";
import { describe, expect, it } from "vitest";
import {
  applyRowOrder,
  buildVisibleItems,
  displayOrgs,
  focusKey,
  isFresh,
  nextFocusTarget,
  reconcileOrgOrder,
  reorderOrgs,
  reorderRowsWithinOrg,
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
    state: "idle" as CockpitTerminalState,
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
    const cockpitTerminals = [session("w1", "z"), session("w2", "a")];
    expect(displayOrgs(["a", "b"], cockpitTerminals)).toEqual(["a", "b", "z"]);
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
  const cockpitTerminals = [
    session("w1", "a"),
    session("w2", "a"),
    session("w3", "b"),
  ];

  it("interleaves org headers with their rows in display order", () => {
    expect(buildVisibleItems(["a", "b"], cockpitTerminals, new Set())).toEqual([
      { kind: "org", org: "a" },
      { kind: "row", cockpitTerminalId: "w1" },
      { kind: "row", cockpitTerminalId: "w2" },
      { kind: "org", org: "b" },
      { kind: "row", cockpitTerminalId: "w3" },
    ]);
  });

  it("keeps a collapsed org's header but drops its rows", () => {
    expect(
      buildVisibleItems(["a", "b"], cockpitTerminals, new Set(["a"])),
    ).toEqual([
      { kind: "org", org: "a" },
      { kind: "org", org: "b" },
      { kind: "row", cockpitTerminalId: "w3" },
    ]);
  });
});

describe("nextFocusTarget", () => {
  const cockpitTerminals = [session("w1", "a"), session("w2", "a")];
  const items = buildVisibleItems(["a"], cockpitTerminals, new Set());

  it("steps down from the current ring", () => {
    expect(
      nextFocusTarget(
        items,
        { kind: "org", org: "a" },
        null,
        cockpitTerminals,
        1,
      ),
    ).toEqual({ kind: "row", cockpitTerminalId: "w1" });
  });

  it("steps up from the current ring", () => {
    expect(
      nextFocusTarget(
        items,
        { kind: "row", cockpitTerminalId: "w1" },
        null,
        cockpitTerminals,
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
        cockpitTerminals,
        1,
      ),
    ).toEqual({ kind: "row", cockpitTerminalId: "w2" });
  });

  it("clamps at the top edge", () => {
    expect(
      nextFocusTarget(
        items,
        { kind: "org", org: "a" },
        null,
        cockpitTerminals,
        -1,
      ),
    ).toEqual({ kind: "org", org: "a" });
  });

  it("ignores a selected window that is not in the session list", () => {
    expect(
      nextFocusTarget(items, null, "missing", cockpitTerminals, 1),
    ).toEqual({
      kind: "org",
      org: "a",
    });
  });

  it("with no ring, anchors on the visible selected row", () => {
    expect(nextFocusTarget(items, null, "w1", cockpitTerminals, 1)).toEqual({
      kind: "row",
      cockpitTerminalId: "w2",
    });
  });

  it("with no ring and a collapsed selected row, anchors on its org header", () => {
    const collapsedItems = buildVisibleItems(
      ["a"],
      cockpitTerminals,
      new Set(["a"]),
    );
    expect(
      nextFocusTarget(collapsedItems, null, "w1", cockpitTerminals, 1),
    ).toEqual({
      kind: "org",
      org: "a",
    });
  });

  it("with no anchor, a down step lands on the first item", () => {
    expect(nextFocusTarget(items, null, null, cockpitTerminals, 1)).toEqual({
      kind: "org",
      org: "a",
    });
  });

  it("with no anchor, an up step lands on the last item", () => {
    expect(nextFocusTarget(items, null, null, cockpitTerminals, -1)).toEqual({
      kind: "row",
      cockpitTerminalId: "w2",
    });
  });
});

describe("reorderOrgs", () => {
  it("drops a dragged org just before a later target", () => {
    expect(reorderOrgs(["a", "b", "c"], "a", "c")).toEqual(["b", "a", "c"]);
  });

  it("drops a dragged org just before an earlier target", () => {
    expect(reorderOrgs(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
  });

  it("returns the list unchanged when dragged equals target or either is absent", () => {
    expect(reorderOrgs(["a", "b"], "a", "a")).toEqual(["a", "b"]);
    expect(reorderOrgs(["a", "b"], "x", "a")).toEqual(["a", "b"]);
    expect(reorderOrgs(["a", "b"], "a", "x")).toEqual(["a", "b"]);
  });
});

describe("reconcileOrgOrder", () => {
  it("keeps the optimistic order while it covers the same org set", () => {
    expect(reconcileOrgOrder(["b", "a"], ["a", "b"])).toEqual(["b", "a"]);
  });

  it("falls back to the server order when the org set changes", () => {
    expect(reconcileOrgOrder(["b", "a"], ["a", "b", "c"])).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(reconcileOrgOrder(["b", "a"], ["a", "z"])).toEqual(["a", "z"]);
  });

  it("uses the server order when there is no optimistic order", () => {
    expect(reconcileOrgOrder(null, ["a", "b"])).toEqual(["a", "b"]);
  });
});

describe("reorderRowsWithinOrg", () => {
  const terms = [session("w1", "a"), session("w2", "a"), session("w3", "b")];

  it("moves a row just before another row in the same org", () => {
    expect(reorderRowsWithinOrg(terms, "w2", "w1")).toEqual(["w2", "w1", "w3"]);
  });

  it("refuses a cross-org move and returns the current id order", () => {
    expect(reorderRowsWithinOrg(terms, "w1", "w3")).toEqual(["w1", "w2", "w3"]);
  });

  it("is a no-op for equal or absent ids", () => {
    expect(reorderRowsWithinOrg(terms, "w1", "w1")).toEqual(["w1", "w2", "w3"]);
    expect(reorderRowsWithinOrg(terms, "zzz", "w1")).toEqual([
      "w1",
      "w2",
      "w3",
    ]);
  });
});

describe("applyRowOrder", () => {
  const terms = [session("w1", "a"), session("w2", "a")];

  it("sorts terminals by the optimistic order while the id set matches", () => {
    expect(
      applyRowOrder(terms, ["w2", "w1"]).map((s) => s.cockpitTerminalId),
    ).toEqual(["w2", "w1"]);
  });

  it("returns terminals untouched when the set differs or order is null", () => {
    expect(applyRowOrder(terms, ["w2", "w9"])).toEqual(terms);
    expect(applyRowOrder(terms, null)).toEqual(terms);
  });
});
