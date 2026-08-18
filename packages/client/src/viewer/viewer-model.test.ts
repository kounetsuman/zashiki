import { describe, expect, it } from "vitest";

import {
  bufferFailed,
  bufferLoaded,
  bufferTogglePreview,
  closeBuffer,
  isMarkdown,
  openBuffer,
  viewerKey,
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
