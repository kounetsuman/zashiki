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

describe("AccountUsageFooter", () => {
  it("shows only a clickable icon while opted out and opens the modal on click", () => {
    const onRequestEnable = vi.fn();
    const { container } = render(
      <AccountUsageFooter
        limits={LIMITS}
        enabled={false}
        onRequestEnable={onRequestEnable}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onRequestEnable).toHaveBeenCalledOnce();
    // No usage cells while opted out.
    expect(container.querySelectorAll(".ss-group")).toHaveLength(0);
  });

  it("renders the two usage cells while opted in", () => {
    const { container } = render(
      <AccountUsageFooter
        limits={LIMITS}
        enabled
        onRequestEnable={() => undefined}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelectorAll(".ss-group")).toHaveLength(2);
  });
});
