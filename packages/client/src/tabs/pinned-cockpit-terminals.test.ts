import { describe, expect, it } from "vitest";

import {
  cockpitTerminalIdOfKey,
  forgetEndedCockpitTerminals,
  forgetPinnedCockpitTerminal,
  loadPinnedCockpitTerminals,
  orderPinnedCockpitTerminals,
  PINNED_COCKPIT_TERMINALS_KEY,
  rememberPinnedCockpitTerminal,
  restorePinnedCockpitTerminals,
  savePinnedCockpitTerminals,
} from "./pinned-cockpit-terminals.js";
import {
  MEMO_TAB,
  MEMO_TAB_KEY,
  type Tab,
  type TabsState,
} from "./tab-model.js";

const s = (id: string): Tab => ({ kind: "session", id });
const v = (id: string): Tab => ({ kind: "viewer", id });

function state(
  tabs: Tab[],
  activeKey: string | null,
  pinned: string[] = [],
): TabsState {
  return { tabs, activeKey, pinned: new Set(pinned) };
}

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, val: string) => {
      data.set(k, val);
    },
    data,
  };
}

describe("cockpitTerminalIdOfKey", () => {
  it("returns the cockpitTerminalId of a session tab key only", () => {
    expect(cockpitTerminalIdOfKey("session:abc")).toBe("abc");
    expect(cockpitTerminalIdOfKey("viewer:session:abc")).toBeNull();
    expect(cockpitTerminalIdOfKey(MEMO_TAB_KEY)).toBeNull();
  });
});

describe("loadPinnedCockpitTerminals / savePinnedCockpitTerminals", () => {
  it("round-trips the ids in order", () => {
    const storage = memoryStorage();
    savePinnedCockpitTerminals(storage, ["b", "a"]);
    expect(loadPinnedCockpitTerminals(storage)).toEqual(["b", "a"]);
  });

  it("reads nothing from missing, malformed or non-string values", () => {
    expect(loadPinnedCockpitTerminals(null)).toEqual([]);
    expect(loadPinnedCockpitTerminals(memoryStorage())).toEqual([]);
    expect(
      loadPinnedCockpitTerminals(
        memoryStorage({ [PINNED_COCKPIT_TERMINALS_KEY]: "{" }),
      ),
    ).toEqual([]);
    expect(
      loadPinnedCockpitTerminals(
        memoryStorage({ [PINNED_COCKPIT_TERMINALS_KEY]: '"a"' }),
      ),
    ).toEqual([]);
    expect(
      loadPinnedCockpitTerminals(
        memoryStorage({
          [PINNED_COCKPIT_TERMINALS_KEY]: '["a",1,"",null,"a","b"]',
        }),
      ),
    ).toEqual(["a", "b"]);
  });

  it("survives a storage that throws", () => {
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(loadPinnedCockpitTerminals(throwing)).toEqual([]);
    expect(() => savePinnedCockpitTerminals(throwing, ["a"])).not.toThrow();
  });
});

describe("remember / forget", () => {
  it("adds once at the end and removes by id, keeping the reference when unchanged", () => {
    const ids = ["a"];
    expect(rememberPinnedCockpitTerminal(ids, "b")).toEqual(["a", "b"]);
    expect(rememberPinnedCockpitTerminal(ids, "a")).toBe(ids);
    expect(forgetPinnedCockpitTerminal(["a", "b"], "a")).toEqual(["b"]);
    expect(forgetPinnedCockpitTerminal(ids, "z")).toBe(ids);
  });

  it("forgets the terminals that are not live", () => {
    const ids = ["a", "b", "c"];
    expect(forgetEndedCockpitTerminals(ids, new Set(["a", "c"]))).toEqual([
      "a",
      "c",
    ]);
    expect(forgetEndedCockpitTerminals(ids, new Set(ids))).toBe(ids);
  });
});

describe("orderPinnedCockpitTerminals", () => {
  it("follows the order of the open pinned tabs", () => {
    const st = state([s("c"), s("a"), s("x")], null, [
      "session:c",
      "session:a",
    ]);
    expect(orderPinnedCockpitTerminals(["a", "c"], st)).toEqual(["c", "a"]);
  });

  it("keeps the slot of a terminal whose tab is not open", () => {
    const ids = ["a", "b", "c"];
    const st = state([s("a"), s("c")], null, ["session:a", "session:c"]);
    expect(orderPinnedCockpitTerminals(ids, st)).toBe(ids);
    const swapped = state([s("c"), s("a")], null, ["session:c", "session:a"]);
    expect(orderPinnedCockpitTerminals(ids, swapped)).toEqual(["c", "b", "a"]);
  });

  it("returns the same array when the order already matches", () => {
    const ids = ["a", "b"];
    const st = state([s("a"), s("b")], null, ["session:a", "session:b"]);
    expect(orderPinnedCockpitTerminals(ids, st)).toBe(ids);
  });

  it("does not add an open pinned terminal that is not remembered", () => {
    const st = state([s("a")], null, ["session:a"]);
    expect(orderPinnedCockpitTerminals([], st)).toEqual([]);
  });
});

describe("restorePinnedCockpitTerminals", () => {
  const live = (...ids: string[]) => new Set(ids);

  it("reopens the live remembered terminals pinned, in remembered order, after the Memo tab", () => {
    const st = state([MEMO_TAB, s("x")], "session:x");
    const r = restorePinnedCockpitTerminals(
      st,
      ["b", "gone", "a"],
      live("a", "b", "x"),
      true,
    );
    expect(r.tabs).toEqual([MEMO_TAB, s("b"), s("a"), s("x")]);
    expect([...r.pinned]).toEqual(["session:b", "session:a"]);
    expect(r.activeKey).toBe("session:x");
  });

  it("places a terminal that comes back later in its remembered slot", () => {
    const st = state([s("b"), v("f")], "session:b", ["session:b"]);
    const r = restorePinnedCockpitTerminals(
      st,
      ["a", "b"],
      live("a", "b"),
      true,
    );
    expect(r.tabs).toEqual([s("a"), s("b"), v("f")]);
  });

  it("keeps pinned viewer tabs ahead of a restored terminal remembered after them", () => {
    const st = state([v("f"), s("x")], "viewer:f", ["viewer:f"]);
    const r = restorePinnedCockpitTerminals(st, ["a"], live("a", "x"), true);
    expect(r.tabs).toEqual([v("f"), s("a"), s("x")]);
  });

  it("pins an open but unpinned remembered terminal", () => {
    const st = state([s("x"), s("a")], "session:a");
    const r = restorePinnedCockpitTerminals(st, ["a"], live("a", "x"), true);
    expect(r.tabs).toEqual([s("a"), s("x")]);
    expect(r.pinned.has("session:a")).toBe(true);
    expect(r.activeKey).toBe("session:a");
  });

  it("activates the first restored tab only when asked and nothing is active", () => {
    expect(
      restorePinnedCockpitTerminals(
        state([], null),
        ["a", "b"],
        live("a", "b"),
        true,
      ).activeKey,
    ).toBe("session:a");
    expect(
      restorePinnedCockpitTerminals(state([], null), ["a"], live("a"), false)
        .activeKey,
    ).toBeNull();
  });

  it("returns the same state when nothing needs restoring", () => {
    const st = state([s("a")], "session:a", ["session:a"]);
    expect(
      restorePinnedCockpitTerminals(st, ["a", "gone"], live("a"), true),
    ).toBe(st);
  });
});
