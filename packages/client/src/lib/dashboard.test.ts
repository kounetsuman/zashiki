import {
  type DashboardSettings,
  DEFAULT_DASHBOARD_SETTINGS,
} from "@zashiki/shared";
import { describe, expect, it } from "vitest";

import {
  DASHBOARD_LAST_SHOWN_KEY,
  DASHBOARD_SANDBOX,
  dashboardDayKey,
  dashboardFailureSpendsDay,
  dashboardTarget,
  loadDashboardLastShown,
  saveDashboardLastShown,
  shouldShowDashboard,
} from "./dashboard.js";

const settings = (
  patch: Partial<DashboardSettings> = {},
): DashboardSettings => ({
  ...DEFAULT_DASHBOARD_SETTINGS,
  url: "https://dash.example/board",
  ...patch,
});

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
  };
}

describe("dashboardTarget", () => {
  it("treats a blank or whitespace-only url as the feature being off", () => {
    expect(dashboardTarget("").kind).toBe("off");
    expect(dashboardTarget("   ").kind).toBe("off");
  });

  it("loads an http(s) url directly", () => {
    expect(dashboardTarget("https://dash.example/board")).toEqual({
      kind: "remote",
      url: "https://dash.example/board",
    });
    expect(dashboardTarget("HTTP://dash.example").kind).toBe("remote");
  });

  it("loads a file url or a plain path through the server", () => {
    expect(dashboardTarget("file:///Users/me/board.html").kind).toBe("local");
    expect(dashboardTarget("/Users/me/board.html").kind).toBe("local");
    expect(dashboardTarget("~/board.html").kind).toBe("local");
  });

  it("trims the configured value", () => {
    expect(dashboardTarget("  https://dash.example  ")).toEqual({
      kind: "remote",
      url: "https://dash.example",
    });
  });
});

describe("DASHBOARD_SANDBOX", () => {
  it("is an opaque origin, which no navigation inside the frame can widen", () => {
    expect(DASHBOARD_SANDBOX).toBe("allow-scripts");
    expect(DASHBOARD_SANDBOX).not.toContain("allow-same-origin");
    expect(DASHBOARD_SANDBOX).not.toContain("allow-top-navigation");
  });
});

describe("shouldShowDashboard", () => {
  it("stays off while no url is configured", () => {
    expect(
      shouldShowDashboard(settings({ url: "" }), "launch", null, "2026-09-14"),
    ).toBe(false);
    expect(
      shouldShowDashboard(settings({ url: "" }), "wake", null, "2026-09-14"),
    ).toBe(false);
  });

  it("shows only at the configured moment", () => {
    const onLaunch = settings({ showOn: "launch" });
    expect(shouldShowDashboard(onLaunch, "launch", null, "2026-09-14")).toBe(
      true,
    );
    expect(shouldShowDashboard(onLaunch, "wake", null, "2026-09-14")).toBe(
      false,
    );

    const onWake = settings({ showOn: "wake" });
    expect(shouldShowDashboard(onWake, "wake", null, "2026-09-14")).toBe(true);
    expect(shouldShowDashboard(onWake, "launch", null, "2026-09-14")).toBe(
      false,
    );

    const onBoth = settings({ showOn: "both" });
    expect(shouldShowDashboard(onBoth, "launch", null, "2026-09-14")).toBe(
      true,
    );
    expect(shouldShowDashboard(onBoth, "wake", null, "2026-09-14")).toBe(true);
  });

  it("repeats on every trigger at every_time, even twice in one day", () => {
    const every = settings({ showOn: "both", frequency: "every_time" });
    const shownToday = { url: every.url, day: "2026-09-14" };
    expect(shouldShowDashboard(every, "wake", shownToday, "2026-09-14")).toBe(
      true,
    );
  });

  it("shows once a day at once_per_day: the first trigger of the day, then not again", () => {
    const once = settings({ showOn: "both", frequency: "once_per_day" });
    expect(shouldShowDashboard(once, "launch", null, "2026-09-14")).toBe(true);
    expect(
      shouldShowDashboard(
        once,
        "wake",
        { url: once.url, day: "2026-09-13" },
        "2026-09-14",
      ),
    ).toBe(true);
    const shownToday = { url: once.url, day: "2026-09-14" };
    expect(shouldShowDashboard(once, "wake", shownToday, "2026-09-14")).toBe(
      false,
    );
    expect(shouldShowDashboard(once, "launch", shownToday, "2026-09-14")).toBe(
      false,
    );
  });

  it("gives a newly configured address its own first showing the same day", () => {
    const once = settings({
      showOn: "both",
      frequency: "once_per_day",
      url: "https://dash.example/other",
    });
    const shownToday = { url: "https://dash.example/board", day: "2026-09-14" };
    expect(shouldShowDashboard(once, "launch", shownToday, "2026-09-14")).toBe(
      true,
    );
  });
});

describe("dashboardFailureSpendsDay", () => {
  it("spends the day on a refusal the server will repeat, so wakes stop nagging", () => {
    expect(dashboardFailureSpendsDay(400)).toBe(true); // not a local path / not .html
    expect(dashboardFailureSpendsDay(404)).toBe(true); // file moved or renamed
    expect(dashboardFailureSpendsDay(413)).toBe(true); // too large to display
  });

  it("leaves the day free for a failure that could succeed later today", () => {
    expect(dashboardFailureSpendsDay(null)).toBe(false); // offline, no response at all
    expect(dashboardFailureSpendsDay(500)).toBe(false);
    expect(dashboardFailureSpendsDay(503)).toBe(false); // server still starting
  });
});

describe("dashboardDayKey", () => {
  it("formats the local calendar day zero-padded", () => {
    expect(dashboardDayKey(new Date(2026, 8, 14, 23, 59))).toBe("2026-09-14");
    expect(dashboardDayKey(new Date(2026, 0, 5, 0, 0))).toBe("2026-01-05");
  });

  it("turns the day over at local midnight, not at UTC's", () => {
    const justBeforeLocalMidnight = new Date(2026, 8, 14, 23, 30);
    const justAfterLocalMidnight = new Date(2026, 8, 15, 0, 30);
    expect(dashboardDayKey(justBeforeLocalMidnight)).toBe("2026-09-14");
    expect(dashboardDayKey(justAfterLocalMidnight)).toBe("2026-09-15");
  });
});

describe("dashboard last-shown persistence", () => {
  const shown = { url: "https://dash.example/board", day: "2026-09-14" };

  it("round-trips the address and day through storage", () => {
    const storage = memoryStorage();
    expect(loadDashboardLastShown(storage)).toBeNull();
    saveDashboardLastShown(storage, shown);
    expect(loadDashboardLastShown(storage)).toEqual(shown);
  });

  it("treats absent storage as never shown and swallows a write failure", () => {
    expect(loadDashboardLastShown(null)).toBeNull();
    expect(() => saveDashboardLastShown(null, shown)).not.toThrow();
    const throwing = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(() => saveDashboardLastShown(throwing, shown)).not.toThrow();
  });

  it("treats a corrupt or outgrown stored value as never shown", () => {
    for (const raw of ["", "2026-09-14", "{", '{"day":"2026-09-14"}', "null"]) {
      const storage = memoryStorage({ [DASHBOARD_LAST_SHOWN_KEY]: raw });
      expect(loadDashboardLastShown(storage), raw).toBeNull();
    }
  });
});
