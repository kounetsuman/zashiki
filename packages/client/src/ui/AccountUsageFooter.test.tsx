// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { UsageLimits } from "@zashiki/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountUsageFooter } from "./AccountUsageFooter.js";

afterEach(cleanup);

const LIMITS: UsageLimits = {
  fiveHour: { usedPercent: 20 },
  week: { usedPercent: 40 },
};

function memoryStorage(seed?: string) {
  const map = new Map<string, string>();
  if (seed !== undefined) map.set("zk.footer.usageTimeMode", seed);
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    read: () => map.get("zk.footer.usageTimeMode"),
  };
}

describe("AccountUsageFooter", () => {
  it("shows only a clickable icon while opted out and opens the modal on click", () => {
    const onRequestEnable = vi.fn();
    const { container } = render(
      <AccountUsageFooter
        limits={LIMITS}
        enabled={false}
        onRequestEnable={onRequestEnable}
        storage={memoryStorage()}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onRequestEnable).toHaveBeenCalledOnce();
    // No usage cells while opted out.
    expect(container.querySelectorAll(".ss-group")).toHaveLength(0);
  });

  it("renders the two usage cells and falls back to the used-percent meter when no reset is known", () => {
    const { container } = render(
      <AccountUsageFooter
        limits={LIMITS}
        enabled
        onRequestEnable={() => undefined}
        storage={memoryStorage()}
      />,
    );
    expect(container.querySelectorAll(".ss-group")).toHaveLength(2);
    const fills = container.querySelectorAll<HTMLElement>(
      ".account-usage-meter-fill",
    );
    expect(fills).toHaveLength(2);
    const [sessionFill, weekFill] = fills;
    expect(sessionFill?.style.width).toBe("20%");
    expect(weekFill?.style.width).toBe("40%");
  });

  it("sizes each meter to the displayed time fraction of its window and flips it with the mode", () => {
    const now = Date.now();
    const { container } = render(
      <AccountUsageFooter
        limits={{ fiveHour: { usedPercent: 20, resetsAt: now + 60 * 60_000 } }}
        enabled
        onRequestEnable={() => undefined}
        storage={memoryStorage()}
      />,
    );
    const width = () =>
      parseFloat(
        container.querySelector<HTMLElement>(".account-usage-meter-fill")?.style
          .width ?? "",
      );

    // Remaining mode: 1h left of the 5h window ≈ 20% (independent of the 20% used).
    expect(width()).toBeGreaterThan(19.5);
    expect(width()).toBeLessThan(20.5);

    fireEvent.click(screen.getByRole("button"));

    // Elapsed mode: 4h elapsed of the 5h window ≈ 80% — the gauge visibly flips.
    expect(width()).toBeGreaterThan(79.5);
    expect(width()).toBeLessThan(80.5);
  });

  it("reserves each cell's width for its longest reading so the value doesn't jitter as it ticks", () => {
    const now = Date.now();
    const { container } = render(
      <AccountUsageFooter
        limits={{
          fiveHour: { usedPercent: 20, resetsAt: now + 60 * 60_000 },
          week: { usedPercent: 40, resetsAt: now + 3 * 86_400_000 },
        }}
        enabled
        onRequestEnable={() => undefined}
        storage={memoryStorage()}
      />,
    );
    const sizers = container.querySelectorAll(".account-usage-value-sizer");
    expect([...sizers].map((s) => s.textContent)).toEqual([
      "100% · 残り5h 00m",
      "100% · 残り7d 00h 00m 00s",
    ]);
  });

  it("appends the local reset time to the tooltip when the reset is known", () => {
    const resetsAt = Date.now() + 2 * 3_600_000;
    const { container } = render(
      <AccountUsageFooter
        limits={{ fiveHour: { usedPercent: 20, resetsAt } }}
        enabled
        onRequestEnable={() => undefined}
        storage={memoryStorage()}
      />,
    );
    const clock = new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    }).format(resetsAt);
    const label = container
      .querySelector(".ss-group")
      ?.getAttribute("aria-label");
    expect(label).toContain(clock);
  });

  it("flips both cells between remaining and elapsed on the gauge click and persists it", () => {
    const now = Date.now();
    const storage = memoryStorage();
    const { container } = render(
      <AccountUsageFooter
        limits={{
          fiveHour: { usedPercent: 20, resetsAt: now + 90 * 60_000 + 30_000 },
        }}
        enabled
        onRequestEnable={() => undefined}
        storage={storage}
      />,
    );
    const toggle = screen.getByRole("button");
    const value = () => container.querySelector(".ss-val")?.textContent ?? "";

    // ~1h30m remaining of the 5-hour window, prefixed with 残り.
    expect(value()).toContain("残り1h");

    fireEvent.click(toggle);

    // Elapsed = 5h window − ~1h30m ≈ 3h30m, prefixed with 経過.
    expect(value()).toContain("経過3h");
    expect(storage.read()).toBe("elapsed");
  });

  it("restores the persisted elapsed mode on mount", () => {
    const { container } = render(
      <AccountUsageFooter
        limits={{ fiveHour: { usedPercent: 20 } }}
        enabled
        onRequestEnable={() => undefined}
        storage={memoryStorage("elapsed")}
      />,
    );
    expect(
      container.querySelector(".account-usage-value-sizer")?.textContent,
    ).toContain("経過");
  });
});
