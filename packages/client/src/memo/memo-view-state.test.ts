import { describe, expect, it } from "vitest";

import { clampMemoViewState } from "./memo-view-state.js";

describe("clampMemoViewState", () => {
  it("keeps a position that still fits the doc", () => {
    const state = { scrollTop: 240, anchor: 10, head: 18 };
    expect(clampMemoViewState(state, 40)).toEqual(state);
  });

  it("pulls a selection past the end back to the end of a shrunken doc", () => {
    expect(
      clampMemoViewState({ scrollTop: 240, anchor: 30, head: 38 }, 12),
    ).toEqual({ scrollTop: 240, anchor: 12, head: 12 });
  });

  it("floors a negative scroll offset at the top", () => {
    expect(
      clampMemoViewState({ scrollTop: -5, anchor: 0, head: 0 }, 12),
    ).toEqual({ scrollTop: 0, anchor: 0, head: 0 });
  });
});
