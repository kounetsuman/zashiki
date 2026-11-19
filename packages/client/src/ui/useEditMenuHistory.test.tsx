// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useEditMenuHistory } from "./useEditMenuHistory.js";

const listeners = new Map<string, () => void>();
const listenTargets = new Map<string, unknown>();
const unlistenSpy = vi.fn();
const isTauriMock = vi.fn(() => true);
const runEditorHistory =
  vi.fn<(target: Element | null, command: string) => void>();

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => isTauriMock(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (
    event: string,
    handler: () => void,
    options?: { target?: unknown },
  ) => {
    listeners.set(event, handler);
    listenTargets.set(event, options?.target);
    return Promise.resolve(() => {
      listeners.delete(event);
      unlistenSpy();
    });
  },
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ label: "popout-4031" }),
}));

vi.mock("./editor-history.js", () => ({
  runEditorHistory: (target: Element | null, command: string) =>
    runEditorHistory(target, command),
}));

function Harness() {
  useEditMenuHistory();
  return null;
}

/** Lets the promise `listen` returns settle, which is what the subscriptions hang off. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  listeners.clear();
  unlistenSpy.mockClear();
  runEditorHistory.mockReset();
  isTauriMock.mockReturnValue(true);
});

afterEach(cleanup);

describe("useEditMenuHistory", () => {
  it("hears only the commands sent to its own window", () => {
    render(<Harness />);

    for (const event of ["zashiki:edit-undo", "zashiki:edit-redo"]) {
      expect(listenTargets.get(event)).toEqual({
        kind: "WebviewWindow",
        label: "popout-4031",
      });
    }
  });

  it("applies the shell's Undo to the element holding the caret", () => {
    render(<Harness />);

    listeners.get("zashiki:edit-undo")?.();

    expect(runEditorHistory).toHaveBeenCalledWith(
      document.activeElement,
      "undo",
    );
  });

  it("applies the shell's Redo the same way", () => {
    render(<Harness />);

    listeners.get("zashiki:edit-redo")?.();

    expect(runEditorHistory).toHaveBeenCalledWith(
      document.activeElement,
      "redo",
    );
  });

  it("stays out of the way in a browser, where the keys reach the editor themselves", () => {
    isTauriMock.mockReturnValue(false);

    render(<Harness />);

    expect(listeners.size).toBe(0);
  });

  it("drops its subscriptions when the app unmounts", async () => {
    const { unmount } = render(<Harness />);
    await flushMicrotasks();

    unmount();
    await flushMicrotasks();

    expect(listeners.size).toBe(0);
    expect(unlistenSpy).toHaveBeenCalledTimes(2);
  });
});
