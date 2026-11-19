import { describe, expect, it } from "vitest";

import {
  bufferFailed,
  bufferLoaded,
  bufferOpenAnyway,
  bufferSetEncoding,
  bufferShowText,
  bufferTogglePreview,
  bufferTooLarge,
  closeBuffer,
  encodingOf,
  externalMediaKey,
  externalTextKey,
  gaveUpForSize,
  isHtml,
  isMarkdown,
  openBuffer,
  openExternalBuffer,
  openExternalMediaBuffer,
  openMediaBuffer,
  repoFileOfViewerKey,
  shouldPollBuffer,
  type ViewerBuffer,
  type ViewerBuffers,
  viewerKey,
  viewerKeysUnderPath,
  viewersAffectedByRename,
} from "./viewer-model.js";

const REPO = "/ws/repo";

function openText(bufs: ViewerBuffers, name: string, content: string) {
  return openExternalBuffer(
    bufs,
    externalTextKey(name, content),
    name,
    content,
  );
}
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

describe("isHtml", () => {
  it("detects .html/.htm (case-insensitive)", () => {
    expect(isHtml("demo.html")).toBe(true);
    expect(isHtml("a.HTM")).toBe(true);
    expect(isHtml("a.xhtml")).toBe(false);
    expect(isHtml("a.ts")).toBe(false);
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

  it("opens delimited text in the table view and everything else as text", () => {
    const csv = "data/report.csv";
    expect(openBuffer({}, REPO, csv)[viewerKey(REPO, csv)]?.preview).toBe(true);
    expect(openBuffer({}, REPO, REL)[KEY]?.preview).toBe(false);
  });

  it("opens html in the rendered preview, for repo and dropped files alike", () => {
    const html = "site/demo.html";
    expect(openBuffer({}, REPO, html)[viewerKey(REPO, html)]?.preview).toBe(
      true,
    );
    const bufs = openText({}, "dropped.html", "<h1>hi</h1>");
    expect(bufs[externalTextKey("dropped.html", "<h1>hi</h1>")]?.preview).toBe(
      true,
    );
  });

  it("opens a dropped delimited file in the table view", () => {
    const name = "dropped.tsv";
    const bufs = openText({}, name, "a\tb\n");
    expect(bufs[externalTextKey(name, "a\tb\n")]?.preview).toBe(true);
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

describe("files too large to read", () => {
  const confirm = { reason: "confirm", size: 30_000_000 } as const;

  it("holds the size reason until a read lands", () => {
    let b = bufferTooLarge(openBuffer({}, REPO, REL), KEY, confirm);
    expect(b[KEY]).toMatchObject({ status: "tooLarge", tooLarge: confirm });
    b = bufferLoaded(b, KEY, "text");
    expect(b[KEY]?.status).toBe("ready");
    expect(b[KEY]?.tooLarge).toBeUndefined();
  });

  it("opening anyway goes back to loading and remembers the choice", () => {
    const b = bufferOpenAnyway(
      bufferTooLarge(openBuffer({}, REPO, REL), KEY, confirm),
      KEY,
    );
    expect(b[KEY]).toMatchObject({ status: "loading", openAnyway: true });
    expect(b[KEY]?.tooLarge).toBeUndefined();
    const encoded = bufferSetEncoding(b, KEY, "shift_jis");
    expect(encoded[KEY]?.openAnyway).toBe(true);
  });

  it("keeps the buffer as it is when a poll reports the same size problem again", () => {
    const b = bufferTooLarge(openBuffer({}, REPO, REL), KEY, confirm);
    expect(bufferTooLarge(b, KEY, { ...confirm })).toBe(b);
  });

  it("only a file waiting for confirmation can be opened anyway", () => {
    const overMax = bufferTooLarge(openBuffer({}, REPO, REL), KEY, {
      reason: "overMax",
      size: 300,
      maxBytes: 200,
    });
    expect(bufferOpenAnyway(overMax, KEY)).toBe(overMax);
  });

  it("stops polling only a file that failed after being opened anyway", () => {
    const opened = openBuffer({}, REPO, REL);
    const failed = bufferTooLarge(opened, KEY, {
      reason: "failedAfterConfirm",
    });
    expect(gaveUpForSize(failed[KEY] as ViewerBuffer)).toBe(true);
    expect(
      gaveUpForSize(bufferTooLarge(opened, KEY, confirm)[KEY] as ViewerBuffer),
    ).toBe(false);
  });
});

describe("external (dropped) buffers", () => {
  const NAME = "notes.md";
  const EKEY = externalTextKey(NAME, "hello");

  it("openExternalBuffer inserts a ready buffer with content and the external flag", () => {
    const bufs = openText({}, NAME, "hello");
    expect(bufs[EKEY]).toMatchObject({
      relPath: NAME,
      status: "ready",
      content: "hello",
      external: true,
    });
  });

  it("gives files that share a name but differ in content their own buffers", () => {
    let bufs = openText({}, NAME, "from folder a");
    bufs = openText(bufs, NAME, "from folder b");
    expect(bufs[externalTextKey(NAME, "from folder a")]?.content).toBe(
      "from folder a",
    );
    expect(bufs[externalTextKey(NAME, "from folder b")]?.content).toBe(
      "from folder b",
    );
  });

  it("keys files apart by name even when their content is identical", () => {
    expect(externalTextKey("a.md", "x")).not.toBe(externalTextKey("b.md", "x"));
  });

  it("re-opening the same file returns the same reference, keeping its preview toggle", () => {
    const bufs = bufferTogglePreview(openText({}, NAME, "hello"), EKEY);
    expect(openText(bufs, NAME, "hello")).toBe(bufs);
  });

  it("shouldPollBuffer excludes external buffers but includes repo buffers", () => {
    const repo = openBuffer({}, REPO, REL)[KEY];
    const ext = openText({}, NAME, "hello")[EKEY];
    expect(repo && shouldPollBuffer(repo)).toBe(true);
    expect(ext && shouldPollBuffer(ext)).toBe(false);
  });

  // The buffer's external flag and the key's sentinel repoPath express the same fact through
  // two representations; consumers without buffer access (the tab context menu) rely on the key.
  it("keeps the external flag and the key sentinel in agreement", () => {
    expect(openText({}, NAME, "hello")[EKEY]?.external).toBe(true);
    expect(repoFileOfViewerKey(EKEY)).toBeNull();
    expect(openBuffer({}, REPO, REL)[KEY]?.external).toBeUndefined();
    expect(repoFileOfViewerKey(KEY)).not.toBeNull();
  });
});

describe("externalMediaKey", () => {
  const stamp = { size: 10, lastModified: 1000 };

  it("is stable for the same name, size and modification time", () => {
    expect(externalMediaKey("a.png", stamp)).toBe(
      externalMediaKey("a.png", { ...stamp }),
    );
  });

  it("tells apart same-name media that differ in size or modification time", () => {
    const key = externalMediaKey("a.png", stamp);
    expect(externalMediaKey("a.png", { ...stamp, size: 11 })).not.toBe(key);
    expect(
      externalMediaKey("a.png", { ...stamp, lastModified: 2000 }),
    ).not.toBe(key);
  });
});

describe("media buffers", () => {
  const IMG = "assets/logo.png";
  const IMG_KEY = viewerKey(REPO, IMG);

  it("openMediaBuffer inserts a ready repo buffer that renders from the URL", () => {
    const bufs = openMediaBuffer({}, REPO, IMG, {
      kind: "image",
      url: "/api/media?x=1",
    });
    expect(bufs[IMG_KEY]).toMatchObject({
      repoPath: REPO,
      relPath: IMG,
      status: "ready",
      content: null,
      media: { kind: "image", url: "/api/media?x=1" },
    });
  });

  it("openMediaBuffer returns the same reference when the URL is unchanged", () => {
    const bufs = openMediaBuffer({}, REPO, IMG, { kind: "image", url: "u" });
    expect(openMediaBuffer(bufs, REPO, IMG, { kind: "image", url: "u" })).toBe(
      bufs,
    );
  });

  it("openExternalMediaBuffer marks the dropped buffer external", () => {
    const key = externalMediaKey("clip.mp4", { size: 1, lastModified: 1 });
    const bufs = openExternalMediaBuffer({}, key, "clip.mp4", {
      kind: "video",
      url: "blob:abc",
    });
    expect(bufs[key]).toMatchObject({
      relPath: "clip.mp4",
      status: "ready",
      external: true,
      media: { kind: "video", url: "blob:abc" },
    });
  });

  it("bufferTogglePreview switches media to its text, loading it the first time", () => {
    const media = openMediaBuffer({}, REPO, IMG, { kind: "image", url: "u" });
    const text = bufferTogglePreview(media, IMG_KEY);
    expect(text[IMG_KEY]).toMatchObject({ preview: true, status: "loading" });
    const loaded = bufferLoaded(text, IMG_KEY, "\u0089PNG");
    const back = bufferTogglePreview(loaded, IMG_KEY);
    expect(back[IMG_KEY]).toMatchObject({ preview: false, status: "ready" });
    expect(bufferTogglePreview(back, IMG_KEY)[IMG_KEY]).toMatchObject({
      preview: true,
      status: "ready",
      content: "\u0089PNG",
    });
  });

  it("bufferTogglePreview back to the media clears a failed text read", () => {
    const failed = bufferFailed(
      bufferTogglePreview(
        openMediaBuffer({}, REPO, IMG, { kind: "image", url: "u" }),
        IMG_KEY,
      ),
      IMG_KEY,
      "too large",
    );
    expect(bufferTogglePreview(failed, IMG_KEY)[IMG_KEY]).toMatchObject({
      preview: false,
      status: "ready",
      error: undefined,
    });
  });

  it("shouldPollBuffer excludes media buffers", () => {
    const media = openMediaBuffer({}, REPO, IMG, { kind: "image", url: "u" })[
      IMG_KEY
    ];
    expect(media && shouldPollBuffer(media)).toBe(false);
  });
});

describe("encoding", () => {
  it("a buffer reads as UTF-8 until another encoding is set, which reloads it", () => {
    const loaded = bufferLoaded(openBuffer({}, REPO, REL), KEY, "abc");
    expect(encodingOf(loaded[KEY] as ViewerBuffer)).toBe("utf8");
    const sjis = bufferSetEncoding(loaded, KEY, "shift_jis");
    expect(sjis[KEY]).toMatchObject({
      encoding: "shift_jis",
      status: "loading",
      content: null,
    });
    expect(bufferSetEncoding(sjis, KEY, "shift_jis")).toBe(sjis);
    expect(bufferSetEncoding(loaded, KEY, "utf8")).toBe(loaded);
  });

  it("openBuffer can open a file with the encoding it had before (a rename)", () => {
    const opened = openBuffer({}, REPO, REL, "euc_jp")[KEY] as ViewerBuffer;
    expect(encodingOf(opened)).toBe("euc_jp");
  });
});

describe("preview toggle / close", () => {
  it("bufferShowText leaves the alternate rendering, keeping the reference when already text", () => {
    const bufs = bufferTogglePreview(openBuffer({}, REPO, REL), KEY);
    expect(bufferShowText(bufs, KEY)[KEY]?.preview).toBe(false);
    const text = bufferShowText(bufs, KEY);
    expect(bufferShowText(text, KEY)).toBe(text);
  });

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

describe("repoFileOfViewerKey", () => {
  it("is the inverse of viewerKey for a repo-backed key", () => {
    expect(repoFileOfViewerKey(KEY)).toEqual({ repoPath: REPO, relPath: REL });
  });
  it("keeps a repo-root path (empty relPath) roundtrippable", () => {
    expect(repoFileOfViewerKey(viewerKey(REPO, ""))).toEqual({
      repoPath: REPO,
      relPath: "",
    });
  });
  it("returns null for an external file's key", () => {
    expect(repoFileOfViewerKey(externalTextKey("README.md", "x"))).toBeNull();
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
