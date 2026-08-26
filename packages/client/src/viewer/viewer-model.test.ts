import { describe, expect, it } from "vitest";

import {
  bufferFailed,
  bufferLoaded,
  bufferTogglePreview,
  closeBuffer,
  isMarkdown,
  openBuffer,
  splitViewerKey,
  viewerKey,
  viewerKeysUnderPath,
  viewersAffectedByRename,
} from "./viewer-model.js";

const REPO = "/ws/repo";
const REL = "src/app.ts";
const KEY = viewerKey(REPO, REL);

describe("viewerKey", () => {
  it("concatenates repoPath and relPath into a unique key", () => {
    expect(viewerKey("/a", "b")).not.toBe(viewerKey("/a/b", ""));
    expect(viewerKey("/a", "b")).toBe(viewerKey("/a", "b"));
  });
});

describe("isMarkdown", () => {
  it("detects .md/.markdown/.mdx (case-insensitive)", () => {
    expect(isMarkdown("README.md")).toBe(true);
    expect(isMarkdown("a.MARKDOWN")).toBe(true);
    expect(isMarkdown("a.mdx")).toBe(true);
    expect(isMarkdown("a.ts")).toBe(false);
  });
});

describe("openBuffer", () => {
  it("adds it in the loading state when not yet open", () => {
    const b = openBuffer({}, REPO, REL)[KEY];
    expect(b).toMatchObject({
      repoPath: REPO,
      relPath: REL,
      status: "loading",
      content: null,
      preview: false,
    });
  });

  it("leaves an existing entry unchanged with the same reference", () => {
    const bufs = openBuffer({}, REPO, REL);
    expect(openBuffer(bufs, REPO, REL)).toBe(bufs);
  });
});

describe("loading/failure", () => {
  it("bufferLoaded sets content and marks it ready", () => {
    const bufs = bufferLoaded(openBuffer({}, REPO, REL), KEY, "hello");
    expect(bufs[KEY]).toMatchObject({ status: "ready", content: "hello" });
  });

  it("reloading from an error (bufferLoaded) returns to ready and clears the error", () => {
    let bufs = bufferFailed(openBuffer({}, REPO, REL), KEY, "boom");
    bufs = bufferLoaded(bufs, KEY, "recovered");
    expect(bufs[KEY]).toMatchObject({
      status: "ready",
      content: "recovered",
      error: undefined,
    });
  });

  it("re-sending the same value while ready returns the same reference (suppresses wasteful polling renders)", () => {
    const bufs = bufferLoaded(openBuffer({}, REPO, REL), KEY, "same");
    expect(bufferLoaded(bufs, KEY, "same")).toBe(bufs);
  });

  it("reflects the new content when it changes while ready", () => {
    const bufs = bufferLoaded(openBuffer({}, REPO, REL), KEY, "old");
    const next = bufferLoaded(bufs, KEY, "new");
    expect(next).not.toBe(bufs);
    expect(next[KEY]?.content).toBe("new");
  });

  it("bufferFailed puts it into the error state", () => {
    const bufs = bufferFailed(openBuffer({}, REPO, REL), KEY, "boom");
    expect(bufs[KEY]).toMatchObject({ status: "error", error: "boom" });
  });

  it("a nonexistent key is a no-op (same reference)", () => {
    const bufs = openBuffer({}, REPO, REL);
    expect(bufferLoaded(bufs, "nope", "x")).toBe(bufs);
  });
});

describe("preview toggle / close", () => {
  it("bufferTogglePreview flips preview", () => {
    const bufs = bufferTogglePreview(openBuffer({}, REPO, REL), KEY);
    expect(bufs[KEY]?.preview).toBe(true);
  });

  it("closeBuffer removes the key", () => {
    const bufs = closeBuffer(openBuffer({}, REPO, REL), KEY);
    expect(bufs[KEY]).toBeUndefined();
  });

  it("closing a nonexistent key returns the same reference", () => {
    const bufs = openBuffer({}, REPO, REL);
    expect(closeBuffer(bufs, "nope")).toBe(bufs);
  });
});

describe("splitViewerKey", () => {
  it("is the inverse of viewerKey", () => {
    expect(splitViewerKey(viewerKey(REPO, REL))).toEqual({
      repoPath: REPO,
      relPath: REL,
    });
  });
  it("keeps a repo-root path (empty relPath) roundtrippable", () => {
    expect(splitViewerKey(viewerKey(REPO, ""))).toEqual({
      repoPath: REPO,
      relPath: "",
    });
  });
});

describe("viewerKeysUnderPath", () => {
  const open = (rel: string, bufs = {}) => openBuffer(bufs, REPO, rel);

  it("matches an exact file path", () => {
    let bufs = open("src/app.ts");
    bufs = open("src/util.ts", bufs);
    expect(viewerKeysUnderPath(bufs, REPO, "src/app.ts")).toEqual([
      viewerKey(REPO, "src/app.ts"),
    ]);
  });

  it("matches every buffer under a directory but not a sibling prefix", () => {
    let bufs = open("src/app.ts");
    bufs = open("src/ui/tab.ts", bufs);
    bufs = open("src2/other.ts", bufs);
    const keys = viewerKeysUnderPath(bufs, REPO, "src");
    expect(keys).toContain(viewerKey(REPO, "src/app.ts"));
    expect(keys).toContain(viewerKey(REPO, "src/ui/tab.ts"));
    expect(keys).not.toContain(viewerKey(REPO, "src2/other.ts"));
  });

  it("ignores buffers in a different repo", () => {
    const bufs = openBuffer(open("src/app.ts"), "/other", "src/app.ts");
    expect(viewerKeysUnderPath(bufs, "/other", "src")).toEqual([
      viewerKey("/other", "src/app.ts"),
    ]);
  });
});

describe("viewersAffectedByRename", () => {
  it("remaps an exact file rename", () => {
    const bufs = openBuffer({}, REPO, "src/app.ts");
    expect(
      viewersAffectedByRename(bufs, REPO, "src/app.ts", "src/main.ts"),
    ).toEqual([
      { key: viewerKey(REPO, "src/app.ts"), newRelPath: "src/main.ts" },
    ]);
  });

  it("remaps a directory rename across its subtree", () => {
    let bufs = openBuffer({}, REPO, "src/ui/tab.ts");
    bufs = openBuffer(bufs, REPO, "src/app.ts");
    const affected = viewersAffectedByRename(bufs, REPO, "src", "app");
    const map = new Map(affected.map((a) => [a.key, a.newRelPath]));
    expect(map.get(viewerKey(REPO, "src/ui/tab.ts"))).toBe("app/ui/tab.ts");
    expect(map.get(viewerKey(REPO, "src/app.ts"))).toBe("app/app.ts");
  });

  it("leaves unrelated buffers untouched", () => {
    const bufs = openBuffer({}, REPO, "docs/readme.md");
    expect(
      viewersAffectedByRename(bufs, REPO, "src/app.ts", "src/main.ts"),
    ).toEqual([]);
  });
});
