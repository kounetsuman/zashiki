// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useSessionStatsOpen } from "./useSessionStatsOpen.js";

afterEach(cleanup);

describe("useSessionStatsOpen", () => {
  it("opens and closes for the active Cockpit Terminal", () => {
    const { result } = renderHook(() => useSessionStatsOpen("t1"));
    expect(result.current.open).toBe(false);
    act(() => result.current.show());
    expect(result.current.open).toBe(true);
    act(() => result.current.hide());
    expect(result.current.open).toBe(false);
  });

  it("stays open across Cockpit Terminals", () => {
    const { result, rerender } = renderHook(
      ({ id }) => useSessionStatsOpen(id),
      { initialProps: { id: "t1" } },
    );
    act(() => result.current.show());
    rerender({ id: "t2" });
    expect(result.current.open).toBe(true);
  });

  it("closes for good once no Cockpit Terminal is active", () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useSessionStatsOpen(id),
      { initialProps: { id: "t1" as string | null } },
    );
    act(() => result.current.show());
    rerender({ id: null });
    expect(result.current.open).toBe(false);
    rerender({ id: "t1" });
    expect(result.current.open).toBe(false);
  });
});
