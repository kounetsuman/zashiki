// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { SessionUsage } from "@zashiki/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionStatusFooter } from "./SessionStatusFooter.js";

afterEach(cleanup);

const base: SessionUsage = {
  turnTokens: 1_200,
  sessionTokens: 3_400_000,
  turnStartedAt: 0,
  sessionStartedAt: 0,
};

describe("SessionStatusFooter", () => {
  it("renders compact tokens and flags the session total's severity", () => {
    render(<SessionStatusFooter usage={base} />);
    expect(screen.getByText("1.2k")).toBeTruthy();
    expect(screen.getByText("3.4M").className).toContain("ss-crit");
  });

  it("renders live elapsed from the epoch anchors", () => {
    vi.useFakeTimers();
    vi.setSystemTime(90_000);
    try {
      render(<SessionStatusFooter usage={base} />);
      expect(screen.getAllByText("1m 30s").length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("omits the limits group until the bridge reports usage", () => {
    render(<SessionStatusFooter usage={base} />);
    expect(screen.queryByText("speed")).toBeNull();
  });

  it("shows dashes for every cell before a transcript is readable", () => {
    render(<SessionStatusFooter usage={null} />);
    expect(screen.getAllByText("–").length).toBe(4);
    expect(screen.queryByText("speed")).toBeNull();
  });

  it("tints the top border with the org accent color", () => {
    const { container } = render(
      <SessionStatusFooter usage={null} accentColor="#f5c2e7" />,
    );
    const footer = container.querySelector(".session-status") as HTMLElement;
    expect(footer.style.borderTopColor).toBe("rgb(245, 194, 231)");
  });

  it("leaves the top border untinted without an accent color", () => {
    const { container } = render(<SessionStatusFooter usage={null} />);
    const footer = container.querySelector(".session-status") as HTMLElement;
    expect(footer.style.borderTopColor).toBe("");
  });

  it("shows per-limit percentages with their severity when present", () => {
    render(
      <SessionStatusFooter
        usage={{
          ...base,
          limits: {
            fiveHour: { usedPercent: 92 },
            week: { usedPercent: 61 },
          },
        }}
      />,
    );
    expect(screen.getByText("speed")).toBeTruthy();
    expect(screen.getByText("92%").className).toContain("ss-crit");
    expect(screen.getByText("61%").className).toContain("ss-warn");
  });
});
