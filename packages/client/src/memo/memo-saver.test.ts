import { describe, expect, it, vi } from "vitest";

import {
  confirmMemoSaved,
  EMPTY_MEMO,
  editMemo,
  type MemoBuffer,
} from "./memo-model.js";
import { createMemoSaver } from "./memo-saver.js";

/** A store double: the buffer moves like the app store (edits in, confirmed saves re-base). */
function fakeBuffer(initial: MemoBuffer) {
  let memo = initial;
  return {
    get: () => memo,
    type(text: string) {
      memo = editMemo(memo, text);
    },
    saved(text: string) {
      memo = confirmMemoSaved(memo, text);
    },
  };
}

describe("createMemoSaver.save", () => {
  it("runs posts strictly one after another in call order", async () => {
    const events: string[] = [];
    let releaseFirst = () => {};
    const gate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const post = vi.fn(async (text: string) => {
      events.push(`start:${text}`);
      if (text === "first") await gate;
      events.push(`done:${text}`);
    });
    const saver = createMemoSaver(
      () => EMPTY_MEMO,
      post,
      () => {},
    );

    const p1 = saver.save("first");
    const p2 = saver.save("second");
    // Let queued microtasks run: the second post must not start while the first is in flight.
    await new Promise((r) => setTimeout(r, 0));
    expect(events).toEqual(["start:first"]);
    releaseFirst();
    await Promise.all([p1, p2]);
    expect(events).toEqual([
      "start:first",
      "done:first",
      "start:second",
      "done:second",
    ]);
  });

  it("reports each confirmed save and propagates failures without blocking later saves", async () => {
    const onSaved = vi.fn();
    const post = vi
      .fn<(text: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(undefined);
    const saver = createMemoSaver(() => EMPTY_MEMO, post, onSaved);

    await expect(saver.save("fails")).rejects.toThrow("boom");
    expect(onSaved).not.toHaveBeenCalled();
    await saver.save("works");
    expect(onSaved).toHaveBeenCalledWith("works");
  });

  it("times out and aborts a stalled post so it doesn't wedge later saves", async () => {
    const onSaved = vi.fn();
    let aborted = false;
    // A realistic stalled request: it only settles once its signal aborts, like fetch on timeout.
    const stalled = (_text: string, signal: AbortSignal) =>
      new Promise<void>((_, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      });
    const post = vi
      .fn<(text: string, signal: AbortSignal) => Promise<void>>()
      .mockImplementationOnce(stalled)
      .mockResolvedValue(undefined);
    const saver = createMemoSaver(() => EMPTY_MEMO, post, onSaved, 5);

    await expect(saver.save("stalls")).rejects.toThrow();
    expect(aborted).toBe(true);
    expect(onSaved).not.toHaveBeenCalled();

    await saver.save("recovers");
    expect(post).toHaveBeenCalledTimes(2);
    expect(onSaved).toHaveBeenCalledExactlyOnceWith("recovers");
  });
});

describe("createMemoSaver.flush", () => {
  it("does nothing when the buffer is clean", async () => {
    const post = vi.fn(async () => {});
    const saver = createMemoSaver(
      () => EMPTY_MEMO,
      post,
      () => {},
    );
    await saver.flush();
    expect(post).not.toHaveBeenCalled();
  });

  it("drains edits typed while a save was in flight", async () => {
    const buffer = fakeBuffer({ text: "v1", savedText: "" });
    const posted: string[] = [];
    const saver = createMemoSaver(
      buffer.get,
      async (text) => {
        posted.push(text);
        // A keystroke lands during the first POST round-trip.
        if (text === "v1") buffer.type("v2");
      },
      buffer.saved,
    );
    await saver.flush();
    expect(posted).toEqual(["v1", "v2"]);
    expect(buffer.get()).toEqual({ text: "v2", savedText: "v2" });
  });

  it("propagates a failing save instead of looping", async () => {
    const buffer = fakeBuffer({ text: "v1", savedText: "" });
    const saver = createMemoSaver(
      buffer.get,
      async () => {
        throw new Error("save failed");
      },
      buffer.saved,
    );
    await expect(saver.flush()).rejects.toThrow("save failed");
  });
});
