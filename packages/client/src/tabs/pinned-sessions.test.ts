import { describe, expect, it } from "vitest";

import {
  forgetEndedSessions,
  forgetPinnedSession,
  loadPinnedSessions,
  orderPinnedSessions,
  PINNED_SESSIONS_KEY,
  rememberPinnedSession,
  restorePinnedSessions,
  savePinnedSessions,
  sessionIdOfKey,
} from "./pinned-sessions.js";
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

describe("sessionIdOfKey", () => {
  it("returns the cockpitTerminalId of a session tab key only", () => {
    expect(sessionIdOfKey("session:abc")).toBe("abc");
    expect(sessionIdOfKey("viewer:session:abc")).toBeNull();
    expect(sessionIdOfKey(MEMO_TAB_KEY)).toBeNull();
  });
});

describe("loadPinnedSessions / savePinnedSessions", () => {
  it("round-trips the ids in order", () => {
    const storage = memoryStorage();
    savePinnedSessions(storage, ["b", "a"]);
    expect(loadPinnedSessions(storage)).toEqual(["b", "a"]);
  });

  it("reads nothing from missing, malformed or non-string values", () => {
    expect(loadPinnedSessions(null)).toEqual([]);
    expect(loadPinnedSessions(memoryStorage())).toEqual([]);
    expect(
      loadPinnedSessions(memoryStorage({ [PINNED_SESSIONS_KEY]: "{" })),
    ).toEqual([]);
    expect(
      loadPinnedSessions(memoryStorage({ [PINNED_SESSIONS_KEY]: '"a"' })),
    ).toEqual([]);
    expect(
      loadPinnedSessions(
        memoryStorage({ [PINNED_SESSIONS_KEY]: '["a",1,"",null,"a","b"]' }),
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
    expect(loadPinnedSessions(throwing)).toEqual([]);
    expect(() => savePinnedSessions(throwing, ["a"])).not.toThrow();
  });
});

describe("remember / forget", () => {
  it("adds once at the end and removes by id, keeping the reference when unchanged", () => {
    const ids = ["a"];
    expect(rememberPinnedSession(ids, "b")).toEqual(["a", "b"]);
    expect(rememberPinnedSession(ids, "a")).toBe(ids);
    expect(forgetPinnedSession(["a", "b"], "a")).toEqual(["b"]);
    expect(forgetPinnedSession(ids, "z")).toBe(ids);
  });

  it("forgets the terminals that are not live", () => {
    const ids = ["a", "b", "c"];
    expect(forgetEndedSessions(ids, new Set(["a", "c"]))).toEqual(["a", "c"]);
    expect(forgetEndedSessions(ids, new Set(ids))).toBe(ids);
  });
});

describe("orderPinnedSessions", () => {
  it("follows the order of the open pinned tabs", () => {
    const st = state([s("c"), s("a"), s("x")], null, [
      "session:c",
      "session:a",
    ]);
    expect(orderPinnedSessions(["a", "c"], st)).toEqual(["c", "a"]);
  });

  it("keeps the slot of a terminal whose tab is not open", () => {
    const ids = ["a", "b", "c"];
    const st = state([s("a"), s("c")], null, ["session:a", "session:c"]);
    expect(orderPinnedSessions(ids, st)).toBe(ids);
    const swapped = state([s("c"), s("a")], null, ["session:c", "session:a"]);
    expect(orderPinnedSessions(ids, swapped)).toEqual(["c", "b", "a"]);
  });

  it("returns the same array when the order already matches", () => {
    const ids = ["a", "b"];
    const st = state([s("a"), s("b")], null, ["session:a", "session:b"]);
    expect(orderPinnedSessions(ids, st)).toBe(ids);
  });

  it("does not add an open pinned terminal that is not remembered", () => {
    const st = state([s("a")], null, ["session:a"]);
    expect(orderPinnedSessions([], st)).toEqual([]);
  });
});

describe("restorePinnedSessions", () => {
  const live = (...ids: string[]) => new Set(ids);

  it("reopens the live remembered terminals pinned, in remembered order, after the Memo tab", () => {
    const st = state([MEMO_TAB, s("x")], "session:x");
    const r = restorePinnedSessions(
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
    const r = restorePinnedSessions(st, ["a", "b"], live("a", "b"), true);
    expect(r.tabs).toEqual([s("a"), s("b"), v("f")]);
  });

  it("keeps pinned viewer tabs ahead of a restored terminal remembered after them", () => {
    const st = state([v("f"), s("x")], "viewer:f", ["viewer:f"]);
    const r = restorePinnedSessions(st, ["a"], live("a", "x"), true);
    expect(r.tabs).toEqual([v("f"), s("a"), s("x")]);
  });

  it("pins an open but unpinned remembered terminal", () => {
    const st = state([s("x"), s("a")], "session:a");
    const r = restorePinnedSessions(st, ["a"], live("a", "x"), true);
    expect(r.tabs).toEqual([s("a"), s("x")]);
    expect(r.pinned.has("session:a")).toBe(true);
    expect(r.activeKey).toBe("session:a");
  });

  it("activates the first restored tab only when asked and nothing is active", () => {
    expect(
      restorePinnedSessions(state([], null), ["a", "b"], live("a", "b"), true)
        .activeKey,
    ).toBe("session:a");
    expect(
      restorePinnedSessions(state([], null), ["a"], live("a"), false).activeKey,
    ).toBeNull();
  });

  it("returns the same state when nothing needs restoring", () => {
    const st = state([s("a")], "session:a", ["session:a"]);
    expect(restorePinnedSessions(st, ["a", "gone"], live("a"), true)).toBe(st);
  });
});
