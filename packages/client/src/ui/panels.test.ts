// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  clampMenuPos,
  DEFAULT_PANEL,
  isPanelId,
  loadSelectedPanel,
  PANEL_DEFS,
  PANELS_SELECTED_KEY,
  type PanelDef,
  panelClass,
  saveSelectedPanel,
} from "./panels.js";

function memStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

describe("panels pure logic", () => {
  it("PANEL_DEFS has explorer/search/git/notification/help/settings with unique ids and shortcuts (sessions are always fixed and not included)", () => {
    const ids = PANEL_DEFS.map((d: PanelDef) => d.id);
    const keys = PANEL_DEFS.map((d: PanelDef) => d.shortcutKey);
    expect(ids).toEqual([
      "explorer",
      "search",
      "git",
      "notification",
      "help",
      "settings",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("the default selection is the first panel (explorer)", () => {
    expect(DEFAULT_PANEL).toBe("explorer");
    expect(DEFAULT_PANEL).toBe(PANEL_DEFS[0]?.id);
  });

  it("isPanelId is true only for PANEL_DEFS ids and false otherwise", () => {
    expect(isPanelId("explorer")).toBe(true);
    expect(isPanelId("help")).toBe(true);
    expect(isPanelId("sessions")).toBe(false);
    expect(isPanelId("bogus")).toBe(false);
    expect(isPanelId("")).toBe(false);
    expect(isPanelId(null)).toBe(false);
    expect(isPanelId(undefined)).toBe(false);
    expect(isPanelId(42)).toBe(false);
  });

  it("loadSelectedPanel: storage=null defaults to explorer", () => {
    expect(loadSelectedPanel(null)).toBe("explorer");
  });

  it("loadSelectedPanel: a missing key defaults to explorer", () => {
    expect(loadSelectedPanel(memStorage())).toBe("explorer");
  });

  it("loadSelectedPanel: reads a valid saved id", () => {
    const s = memStorage({ [PANELS_SELECTED_KEY]: "git" });
    expect(loadSelectedPanel(s)).toBe("git");
  });

  it("loadSelectedPanel: values outside PANEL_DEFS fall back to explorer (legacy sessions, invalid values)", () => {
    expect(
      loadSelectedPanel(memStorage({ [PANELS_SELECTED_KEY]: "sessions" })),
    ).toBe("explorer");
    expect(
      loadSelectedPanel(memStorage({ [PANELS_SELECTED_KEY]: "bogus" })),
    ).toBe("explorer");
  });

  it("loadSelectedPanel: does not read the legacy key zk.panels.visibility (only the new key)", () => {
    const s = memStorage({
      "zk.panels.visibility": JSON.stringify({ git: true }),
    });
    expect(loadSelectedPanel(s)).toBe("explorer");
  });

  it("round-trips through saveSelectedPanel → loadSelectedPanel (saved as a raw id string)", () => {
    const s = memStorage();
    saveSelectedPanel(s, "search");
    expect(s.map.get(PANELS_SELECTED_KEY)).toBe("search");
    expect(loadSelectedPanel(s)).toBe("search");
  });

  it("saveSelectedPanel(storage=null) does not throw", () => {
    expect(() => saveSelectedPanel(null, "git")).not.toThrow();
  });

  it("saves the closed state (null) as `none` and reads it back as null", () => {
    const s = memStorage();
    saveSelectedPanel(s, null);
    expect(s.map.get(PANELS_SELECTED_KEY)).toBe("none");
    expect(loadSelectedPanel(s)).toBeNull();
  });

  it("loadSelectedPanel: a saved `none` is null (distinct from a missing key defaulting to explorer)", () => {
    expect(
      loadSelectedPanel(memStorage({ [PANELS_SELECTED_KEY]: "none" })),
    ).toBeNull();
    expect(loadSelectedPanel(memStorage())).toBe("explorer");
  });

  it("panelClass: adds panel-inactive when inactive", () => {
    expect(panelClass("git-panel")).toBe("git-panel");
    expect(panelClass("git-panel", false)).toBe("git-panel");
    expect(panelClass("git-panel", true)).toBe("git-panel panel-inactive");
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
