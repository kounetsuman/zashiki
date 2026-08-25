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

  it("renders the two usage cells and each cell's used-percent meter while opted in", () => {
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
    const tag = () =>
      toggle.querySelector(".account-usage-mode-tag")?.textContent;

    // ~1h30m remaining of the 5-hour window.
    expect(value()).toContain("1h");
    expect(tag()).toBe("−");

    fireEvent.click(toggle);

    // Elapsed = 5h window − ~1h30m ≈ 3h30m.
    expect(value()).toContain("3h");
    expect(tag()).toBe("+");
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
      container.querySelector(".account-usage-mode-tag")?.textContent,
    ).toBe("+");
  });
});
