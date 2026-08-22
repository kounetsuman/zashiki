import type { GitDiffResponse } from "@zashiki/shared";
import { describe, expect, it } from "vitest";
import {
  closeDiffBuffer,
  type DiffBuffers,
  diffFailed,
  diffKey,
  diffLoaded,
  diffSide,
  diffToggleLayout,
  openDiffBuffer,
} from "./diff-model.js";

const payload = (over: Partial<GitDiffResponse> = {}): GitDiffResponse => ({
  oldText: "a\n",
  newText: "b\n",
  binary: false,
  tooLarge: false,
  added: 1,
  removed: 1,
  ...over,
});

describe("diffSide / diffKey", () => {
  it("maps staged/untracked flags to a side", () => {
    expect(diffSide(true, false)).toBe("staged");
    expect(diffSide(false, false)).toBe("changed");
    expect(diffSide(false, true)).toBe("untracked");
    // untracked wins even if staged is somehow set.
    expect(diffSide(true, true)).toBe("untracked");
  });

  it("puts the side first so a newline in relPath cannot shift the key head", () => {
    const key = diffKey("/repo", "we\nird.txt", "changed");
    expect(key.startsWith("c\n/repo\n")).toBe(true);
    // Distinct sides of the same file are distinct tabs.
    expect(diffKey("/repo", "a.ts", "staged")).not.toBe(
      diffKey("/repo", "a.ts", "changed"),
    );
  });
});

describe("diff buffer transitions", () => {
  it("opens once in loading state and is idempotent", () => {
    const k = diffKey("/r", "a.ts", "changed");
    const bufs: DiffBuffers = openDiffBuffer({}, "/r", "a.ts", "changed");
    expect(bufs[k]?.status).toBe("loading");
    expect(bufs[k]?.layout).toBe("unified");
    const again = openDiffBuffer(bufs, "/r", "a.ts", "changed");
    expect(again).toBe(bufs);
  });

  it("keeps the same reference when a reload yields identical versions", () => {
    const k = diffKey("/r", "a.ts", "changed");
    let bufs: DiffBuffers = openDiffBuffer({}, "/r", "a.ts", "changed");
    bufs = diffLoaded(bufs, k, payload());
    const reloaded = diffLoaded(bufs, k, payload());
    expect(reloaded).toBe(bufs);
  });

  it("replaces the buffer when the versions change", () => {
    const k = diffKey("/r", "a.ts", "changed");
    let bufs: DiffBuffers = openDiffBuffer({}, "/r", "a.ts", "changed");
    bufs = diffLoaded(bufs, k, payload());
    const reloaded = diffLoaded(bufs, k, payload({ newText: "c\n" }));
    expect(reloaded).not.toBe(bufs);
    expect(reloaded[k]?.payload?.newText).toBe("c\n");
  });

  it("toggles layout and records failures", () => {
    const k = diffKey("/r", "a.ts", "changed");
    let bufs: DiffBuffers = openDiffBuffer({}, "/r", "a.ts", "changed");
    bufs = diffToggleLayout(bufs, k);
    expect(bufs[k]?.layout).toBe("split");
    bufs = diffFailed(bufs, k, "boom");
    expect(bufs[k]?.status).toBe("error");
    expect(bufs[k]?.error).toBe("boom");
  });

  it("closes a buffer", () => {
    const k = diffKey("/r", "a.ts", "changed");
    const bufs = openDiffBuffer({}, "/r", "a.ts", "changed");
    expect(closeDiffBuffer(bufs, k)).toEqual({});
  });
});
