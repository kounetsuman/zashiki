import { describe, expect, it } from "vitest";

import {
  activateTab,
  activeSessionId,
  activeTab,
  closeTab,
  EMPTY_TABS,
  hasTab,
  keyFor,
  moveTab,
  openTab,
  pruneSessions,
  type Tab,
  type TabsState,
  tabKey,
} from "./tab-model.js";

const s = (id: string): Tab => ({ kind: "session", id });
const e = (id: string): Tab => ({ kind: "editor", id });

/** Small helper that builds a state from a tabs array and the active key. */
function state(tabs: Tab[], activeKey: string | null): TabsState {
  return { tabs, activeKey };
}

describe("keyFor / tabKey", () => {
  it("separates id collisions across kinds", () => {
    expect(keyFor("session", "@1")).toBe("session:@1");
    expect(tabKey(s("@1"))).toBe("session:@1");
    expect(tabKey(e("@1"))).toBe("editor:@1");
    expect(tabKey(s("@1"))).not.toBe(tabKey(e("@1")));
  });
});

describe("openTab", () => {
  it("opening from empty adds the tab and makes it active", () => {
    const r = openTab(EMPTY_TABS, s("@1"));
    expect(r.tabs).toEqual([s("@1")]);
    expect(r.activeKey).toBe("session:@1");
  });

  it("appends a new tab at the end and moves active to it", () => {
    let r = openTab(EMPTY_TABS, s("@1"));
    r = openTab(r, s("@2"));
    expect(r.tabs).toEqual([s("@1"), s("@2")]);
    expect(r.activeKey).toBe("session:@2");
  });

  it("opening an existing tab keeps the order and only moves active", () => {
    const base = state([s("@1"), s("@2"), s("@3")], "session:@3");
    const r = openTab(base, s("@1"));
    expect(r.tabs).toEqual([s("@1"), s("@2"), s("@3")]);
    expect(r.activeKey).toBe("session:@1");
  });

  it("returns the same reference when opening an already-active existing tab (suppresses a wasteful re-render)", () => {
    const base = state([s("@1")], "session:@1");
    expect(openTab(base, s("@1"))).toBe(base);
  });

  it("session and editor are distinct tabs even with the same id", () => {
    let r = openTab(EMPTY_TABS, s("@1"));
    r = openTab(r, e("@1"));
    expect(r.tabs).toEqual([s("@1"), e("@1")]);
    expect(r.activeKey).toBe("editor:@1");
  });
});

describe("activateTab", () => {
  it("makes an existing key active", () => {
    const base = state([s("@1"), s("@2")], "session:@1");
    expect(activateTab(base, "session:@2").activeKey).toBe("session:@2");
  });

  it("a nonexistent key is a no-op (same reference)", () => {
    const base = state([s("@1")], "session:@1");
    expect(activateTab(base, "session:@9")).toBe(base);
  });

  it("returns the same reference when already active", () => {
    const base = state([s("@1")], "session:@1");
    expect(activateTab(base, "session:@1")).toBe(base);
  });
});

describe("closeTab", () => {
  it("closing the active tab makes its right neighbor active", () => {
    const base = state([s("@1"), s("@2"), s("@3")], "session:@2");
    const r = closeTab(base, "session:@2");
    expect(r.tabs).toEqual([s("@1"), s("@3")]);
    expect(r.activeKey).toBe("session:@3");
  });

  it("closing the last active tab makes its left neighbor active", () => {
    const base = state([s("@1"), s("@2")], "session:@2");
    const r = closeTab(base, "session:@2");
    expect(r.tabs).toEqual([s("@1")]);
    expect(r.activeKey).toBe("session:@1");
  });

  it("closing the only tab makes active null", () => {
    const base = state([s("@1")], "session:@1");
    expect(closeTab(base, "session:@1")).toEqual({ tabs: [], activeKey: null });
  });

  it("closing a non-active tab leaves active unchanged", () => {
    const base = state([s("@1"), s("@2"), s("@3")], "session:@2");
    const r = closeTab(base, "session:@1");
    expect(r.tabs).toEqual([s("@2"), s("@3")]);
    expect(r.activeKey).toBe("session:@2");
  });

  it("a nonexistent key is a no-op (same reference)", () => {
    const base = state([s("@1")], "session:@1");
    expect(closeTab(base, "session:@9")).toBe(base);
  });
});

describe("pruneSessions", () => {
  it("prunes session tabs that are no longer alive", () => {
    const base = state([s("@1"), s("@2"), s("@3")], "session:@1");
    const r = pruneSessions(base, ["@1", "@3"]);
    expect(r.tabs).toEqual([s("@1"), s("@3")]);
    expect(r.activeKey).toBe("session:@1");
  });

  it("keeps editor tabs regardless of the windowId set", () => {
    const base = state([s("@1"), e("readme.md"), s("@2")], "editor:readme.md");
    const r = pruneSessions(base, []);
    expect(r.tabs).toEqual([e("readme.md")]);
    expect(r.activeKey).toBe("editor:readme.md");
  });

  it("moves to the right neighboring surviving tab in original order when active disappears", () => {
    const base = state([s("@1"), s("@2"), s("@3")], "session:@2");
    const r = pruneSessions(base, ["@1", "@3"]);
    expect(r.activeKey).toBe("session:@3");
  });

  it("uniquely picks the nearest surviving tab in original order even on multiple simultaneous removals", () => {
    // [A,B,C,D] active=C, B and C disappear together -> in original order, D is C's right neighbor.
    const base = state([s("A"), s("B"), s("C"), s("D")], "session:C");
    const r = pruneSessions(base, ["A", "D"]);
    expect(r.tabs).toEqual([s("A"), s("D")]);
    expect(r.activeKey).toBe("session:D");
  });

  it("falls back to the nearest surviving tab on the left when everything to the right of active is gone", () => {
    const base = state([s("A"), s("B"), s("C"), s("D")], "session:C");
    const r = pruneSessions(base, ["A"]); // B,C,D disappear -> C's left is B (gone) -> A.
    expect(r.tabs).toEqual([s("A")]);
    expect(r.activeKey).toBe("session:A");
  });

  it("makes active null when everything is gone", () => {
    const base = state([s("@1"), s("@2")], "session:@1");
    expect(pruneSessions(base, [])).toEqual({ tabs: [], activeKey: null });
  });

  it("returns the same reference when nothing changed", () => {
    const base = state([s("@1"), s("@2")], "session:@1");
    expect(pruneSessions(base, ["@1", "@2"])).toBe(base);
  });
});

describe("activeTab / activeSessionId / hasTab", () => {
  it("activeTab returns the active Tab", () => {
    const base = state([s("@1"), e("x")], "editor:x");
    expect(activeTab(base)).toEqual(e("x"));
  });

  it("returns null for empty or unknown active", () => {
    expect(activeTab(EMPTY_TABS)).toBeNull();
    expect(activeTab(state([s("@1")], "session:@9"))).toBeNull();
  });

  it("activeSessionId returns an id only when a session is active", () => {
    expect(activeSessionId(state([s("@1")], "session:@1"))).toBe("@1");
    expect(activeSessionId(state([e("x")], "editor:x"))).toBeNull();
    expect(activeSessionId(EMPTY_TABS)).toBeNull();
  });

  it("hasTab decides on the combination of kind and id", () => {
    const base = state([s("@1"), e("@1")], "session:@1");
    expect(hasTab(base, "session", "@1")).toBe(true);
    expect(hasTab(base, "editor", "@1")).toBe(true);
    expect(hasTab(base, "session", "@2")).toBe(false);
  });
});

describe("moveTab", () => {
  const base = state([s("@1"), s("@2"), s("@3"), s("@4")], "session:@2");

  it("moves a right-side tab to just before the drop target (dragging left)", () => {
    const r = moveTab(base, "session:@4", "session:@2");
    expect(r.tabs).toEqual([s("@1"), s("@4"), s("@2"), s("@3")]);
  });

  it("moves a left-side tab to just before the drop target (dragging right)", () => {
    const r = moveTab(base, "session:@1", "session:@3");
    expect(r.tabs).toEqual([s("@2"), s("@1"), s("@3"), s("@4")]);
  });

  it("leaves activeKey unchanged after reordering (identity-based)", () => {
    const r = moveTab(base, "session:@4", "session:@1");
    expect(r.activeKey).toBe("session:@2");
  });

  it("can move across kinds even when session and editor are mixed", () => {
    const mixed = state([s("@1"), e("x"), s("@2")], "editor:x");
    const r = moveTab(mixed, "session:@2", "session:@1");
    expect(r.tabs).toEqual([s("@2"), s("@1"), e("x")]);
    expect(r.activeKey).toBe("editor:x");
  });

  it("moving to the same key is a no-op (returns the same reference)", () => {
    expect(moveTab(base, "session:@2", "session:@2")).toBe(base);
  });

  it("an unknown from/to is a no-op (returns the same reference)", () => {
    expect(moveTab(base, "session:@9", "session:@2")).toBe(base);
    expect(moveTab(base, "session:@2", "session:@9")).toBe(base);
  });
});
