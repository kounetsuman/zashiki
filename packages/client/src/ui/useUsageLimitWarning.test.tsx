// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import type { UsageLimit } from "@zashiki/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Notifier } from "../lib/notify.js";
import { useUsageLimitWarning } from "./useUsageLimitWarning.js";

const CRIT = { enabled: true, value: 91 };

function fakeNotifier(): Notifier & { notify: ReturnType<typeof vi.fn> } {
  return {
    isEnabled: () => true,
    setEnabled: () => undefined,
    applyServerConfig: () => undefined,
    permission: () => "granted",
    requestPermission: async () => "granted",
    notify: vi.fn(),
  };
}

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

const build = () => ({ title: "t", body: "b" });

afterEach(() => vi.clearAllMocks());

describe("useUsageLimitWarning", () => {
  it("stays closed below the threshold", () => {
    const notifier = fakeNotifier();
    const { result } = renderHook(() =>
      useUsageLimitWarning({
        limit: { usedPercent: 50, resetsAt: 500 },
        band: CRIT,
        notifier,
        buildNotification: build,
        storage: memoryStorage(),
      }),
    );
    expect(result.current.open).toBe(false);
    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it("opens and notifies once when the session reaches the threshold", () => {
    const notifier = fakeNotifier();
    const storage = memoryStorage();
    const limit: UsageLimit = { usedPercent: 95, resetsAt: 500 };
    const { result } = renderHook(() =>
      useUsageLimitWarning({
        limit,
        band: CRIT,
        notifier,
        buildNotification: build,
        storage,
      }),
    );
    expect(result.current.open).toBe(true);
    expect(notifier.notify).toHaveBeenCalledOnce();

    act(() => result.current.dismiss());
    expect(result.current.open).toBe(false);
  });

  it("closes the dialog when the session data drops away", () => {
    const notifier = fakeNotifier();
    const storage = memoryStorage();
    const { result, rerender } = renderHook(
      ({ limit }: { limit: UsageLimit | undefined }) =>
        useUsageLimitWarning({
          limit,
          band: CRIT,
          notifier,
          buildNotification: build,
          storage,
        }),
      {
        initialProps: {
          limit: { usedPercent: 95, resetsAt: 500 } as UsageLimit | undefined,
        },
      },
    );
    expect(result.current.open).toBe(true);

    rerender({ limit: undefined });
    expect(result.current.open).toBe(false);
  });

  it("does not reopen for a window already dismissed in storage", () => {
    const notifier = fakeNotifier();
    const storage = memoryStorage();
    storage.setItem(
      "zk.usageWarning.session",
      JSON.stringify({ window: 500, notified: true, dismissed: true }),
    );
    const { result } = renderHook(() =>
      useUsageLimitWarning({
        limit: { usedPercent: 95, resetsAt: 500 },
        band: CRIT,
        notifier,
        buildNotification: build,
        storage,
      }),
    );
    expect(result.current.open).toBe(false);
    expect(notifier.notify).not.toHaveBeenCalled();
  });
});
