// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  clampMenuPos,
  DEFAULT_PANEL,
  isViewId,
  loadSelectedView,
  saveSelectedView,
  VIEW_DEFS,
  VIEWS_SELECTED_KEY,
  type ViewDef,
  viewClass,
} from "./views.js";

function memStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

describe("views pure logic", () => {
  it("VIEW_DEFS has explorer/search/git/notification/help/settings with unique ids and shortcuts (sessions are always fixed and not included)", () => {
    const ids = VIEW_DEFS.map((d: ViewDef) => d.id);
    const keys = VIEW_DEFS.map((d: ViewDef) => d.shortcutKey);
    expect(ids).toEqual([
      "explorer",
      "search",
      "sourceControl",
      "notification",
      "help",
      "settings",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("the default selection is the first view (explorer)", () => {
    expect(DEFAULT_PANEL).toBe("explorer");
    expect(DEFAULT_PANEL).toBe(VIEW_DEFS[0]?.id);
  });

  it("isViewId is true only for VIEW_DEFS ids and false otherwise", () => {
    expect(isViewId("explorer")).toBe(true);
    expect(isViewId("help")).toBe(true);
    expect(isViewId("sessions")).toBe(false);
    expect(isViewId("bogus")).toBe(false);
    expect(isViewId("")).toBe(false);
    expect(isViewId(null)).toBe(false);
    expect(isViewId(undefined)).toBe(false);
    expect(isViewId(42)).toBe(false);
  });

  it("loadSelectedView: storage=null defaults to explorer", () => {
    expect(loadSelectedView(null)).toBe("explorer");
  });

  it("loadSelectedView: a missing key defaults to explorer", () => {
    expect(loadSelectedView(memStorage())).toBe("explorer");
  });

  it("loadSelectedView: reads a valid saved id", () => {
    const s = memStorage({ [VIEWS_SELECTED_KEY]: "sourceControl" });
    expect(loadSelectedView(s)).toBe("sourceControl");
  });

  it("loadSelectedView: values outside VIEW_DEFS fall back to explorer (legacy sessions, invalid values)", () => {
    expect(
      loadSelectedView(memStorage({ [VIEWS_SELECTED_KEY]: "sessions" })),
    ).toBe("explorer");
    expect(
      loadSelectedView(memStorage({ [VIEWS_SELECTED_KEY]: "bogus" })),
    ).toBe("explorer");
  });

  it("loadSelectedView: does not read the legacy key zk.views.visibility (only the new key)", () => {
    const s = memStorage({
      "zk.views.visibility": JSON.stringify({ sourceControl: true }),
    });
    expect(loadSelectedView(s)).toBe("explorer");
  });

  it("round-trips through saveSelectedView → loadSelectedView (saved as a raw id string)", () => {
    const s = memStorage();
    saveSelectedView(s, "search");
    expect(s.map.get(VIEWS_SELECTED_KEY)).toBe("search");
    expect(loadSelectedView(s)).toBe("search");
  });

  it("saveSelectedView(storage=null) does not throw", () => {
    expect(() => saveSelectedView(null, "sourceControl")).not.toThrow();
  });

  it("saves the closed state (null) as `none` and reads it back as null", () => {
    const s = memStorage();
    saveSelectedView(s, null);
    expect(s.map.get(VIEWS_SELECTED_KEY)).toBe("none");
    expect(loadSelectedView(s)).toBeNull();
  });

  it("loadSelectedView: a saved `none` is null (distinct from a missing key defaulting to explorer)", () => {
    expect(
      loadSelectedView(memStorage({ [VIEWS_SELECTED_KEY]: "none" })),
    ).toBeNull();
    expect(loadSelectedView(memStorage())).toBe("explorer");
  });

  it("viewClass: adds view-inactive when inactive", () => {
    expect(viewClass("git-view")).toBe("git-view");
    expect(viewClass("git-view", false)).toBe("git-view");
    expect(viewClass("git-view", true)).toBe("git-view view-inactive");
  });
});

describe("clampMenuPos (clamps the right-click menu within the viewport)", () => {
  it("returns coordinates inside the viewport unchanged", () => {
    expect(clampMenuPos(10, 20)).toEqual({ x: 10, y: 20 });
  });

  it("pulls coordinates past the right/bottom edge back in by the menu width/height", () => {
    const { innerWidth, innerHeight } = window;
    const r = clampMenuPos(innerWidth + 100, innerHeight + 100, 2);
    expect(r.x).toBe(innerWidth - 200);
    expect(r.y).toBe(innerHeight - (12 + 2 * 28));
    expect(r.x).toBeLessThanOrEqual(innerWidth);
    expect(r.y).toBeLessThanOrEqual(innerHeight);
  });

  it("increases the downward clamp margin as the item count grows", () => {
    const y = window.innerHeight + 100;
    const one = clampMenuPos(0, y, 1).y;
    const two = clampMenuPos(0, y, 2).y;
    expect(two).toBeLessThan(one);
  });

  it("rounds negative coordinates to 0", () => {
    expect(clampMenuPos(-50, -50)).toEqual({ x: 0, y: 0 });
  });
});
