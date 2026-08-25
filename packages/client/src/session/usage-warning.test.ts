import { describe, expect, it } from "vitest";

import {
  dismissUsageWarning,
  EMPTY_USAGE_WARNING,
  reduceUsageWarning,
} from "./usage-warning.js";

describe("reduceUsageWarning", () => {
  it("stays quiet while below the threshold, tracking the window", () => {
    const step = reduceUsageWarning(EMPTY_USAGE_WARNING, {
      active: false,
      window: 500,
    });
    expect(step).toEqual({
      record: { window: 500, notified: false, dismissed: false },
      shouldOpen: false,
      shouldNotify: false,
    });
  });

  it("opens and notifies once when first crossing the threshold", () => {
    const first = reduceUsageWarning(
      { window: 500, notified: false, dismissed: false },
      { active: true, window: 500 },
    );
    expect(first.shouldOpen).toBe(true);
    expect(first.shouldNotify).toBe(true);
    expect(first.record).toEqual({
      window: 500,
      notified: true,
      dismissed: false,
    });

    const second = reduceUsageWarning(first.record, {
      active: true,
      window: 500,
    });
    expect(second.shouldOpen).toBe(true);
    expect(second.shouldNotify).toBe(false);
  });

  it("keeps the dialog closed once dismissed within the same window", () => {
    const dismissed = dismissUsageWarning({
      window: 500,
      notified: true,
      dismissed: false,
    });
    const step = reduceUsageWarning(dismissed, { active: true, window: 500 });
    expect(step.shouldOpen).toBe(false);
    expect(step.shouldNotify).toBe(false);
  });

  it("re-arms both the dialog and the notification when the window rolls over", () => {
    const dismissed = { window: 500, notified: true, dismissed: true };
    const step = reduceUsageWarning(dismissed, { active: true, window: 900 });
    expect(step.shouldOpen).toBe(true);
    expect(step.shouldNotify).toBe(true);
    expect(step.record.window).toBe(900);
  });

  it("preserves a dismissal across a dip below the threshold in the same window", () => {
    const dismissed = { window: 500, notified: true, dismissed: true };
    const dip = reduceUsageWarning(dismissed, { active: false, window: 500 });
    expect(dip.record).toEqual(dismissed);
    const backUp = reduceUsageWarning(dip.record, {
      active: true,
      window: 500,
    });
    expect(backUp.shouldOpen).toBe(false);
  });

  it("keeps state and stays closed across a transient window gap", () => {
    const prev = { window: 500, notified: true, dismissed: true };
    const step = reduceUsageWarning(prev, { active: true, window: null });
    expect(step.record).toEqual(prev);
    expect(step.shouldOpen).toBe(false);
    expect(step.shouldNotify).toBe(false);

    const back = reduceUsageWarning(step.record, {
      active: true,
      window: 500,
    });
    expect(back.shouldOpen).toBe(false);
    expect(back.shouldNotify).toBe(false);
  });
});
