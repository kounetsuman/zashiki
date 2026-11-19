// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type FilesApi, FileTooLargeError } from "../api/files.js";
import i18n from "../i18n/index.js";
import { viewerKey } from "../viewer/viewer-model.js";
import { useViewer } from "./useViewer.js";

const MIB = 1024 * 1024;
const LIMITS = { confirmBytes: MIB, maxBytes: 2 * MIB };

function text(content: string, version: string | null = null) {
  return { content, version };
}

const filesApi: FilesApi = {
  read: () => Promise.resolve({ content: "", version: null }),
  mediaUrl: (repoPath, file) => `/api/media?repoPath=${repoPath}&file=${file}`,
};

let created: string[];
let createdFrom: Blob[];
let revoked: string[];

beforeEach(() => {
  created = [];
  createdFrom = [];
  revoked = [];
  let n = 0;
  vi.stubGlobal("URL", {
    createObjectURL: (blob: Blob) => {
      createdFrom.push(blob);
      const url = `blob:${n++}`;
      created.push(url);
      return url;
    },
    revokeObjectURL: (url: string) => revoked.push(url),
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("useViewer media", () => {
  it("ensureMediaBuffer opens a repo buffer from the server URL without an object URL", () => {
    const { result } = renderHook(() => useViewer(filesApi, null, LIMITS));
    let key = "";
    act(() => {
      key = result.current.ensureMediaBuffer("/repo", "a.png", "image");
    });
    expect(key).toBe(viewerKey("/repo", "a.png"));
    expect(result.current.buffers[key]?.media).toEqual({
      kind: "image",
      url: "/api/media?repoPath=/repo&file=a.png",
    });
    expect(created).toEqual([]);
  });

  it("openExternalMedia creates an object URL and revokes the previous one on re-drop", () => {
    const { result } = renderHook(() => useViewer(filesApi, null, LIMITS));
    const file = new File(["x"], "clip.mp4");
    let key = "";
    act(() => {
      key = result.current.openExternalMedia("clip.mp4", file, "video");
    });
    expect(result.current.buffers[key]?.media?.url).toBe("blob:0");

    let again = "";
    act(() => {
      again = result.current.openExternalMedia("clip.mp4", file, "video");
    });
    expect(again).toBe(key);
    expect(revoked).toContain("blob:0");
    expect(result.current.buffers[key]?.media?.url).toBe("blob:1");
  });

  it("openExternalMedia gives same-name files from different folders their own buffers", () => {
    const { result } = renderHook(() => useViewer(filesApi, null, LIMITS));
    let a = "";
    let b = "";
    act(() => {
      a = result.current.openExternalMedia(
        "a.png",
        new File(["x"], "a.png", { lastModified: 1 }),
        "image",
      );
      b = result.current.openExternalMedia(
        "a.png",
        new File(["xy"], "a.png", { lastModified: 2 }),
        "image",
      );
    });
    expect(a).not.toBe(b);
    expect(result.current.buffers[a]?.media?.url).toBe("blob:0");
    expect(result.current.buffers[b]?.media?.url).toBe("blob:1");
    expect(revoked).toEqual([]);
  });

  it("openExternalMedia types a dropped pdf as application/pdf whatever File.type says", () => {
    const { result } = renderHook(() => useViewer(filesApi, null, LIMITS));
    act(() => {
      result.current.openExternalMedia(
        "spec.pdf",
        new File(["%PDF"], "spec.pdf", { type: "" }),
        "pdf",
      );
    });
    expect(createdFrom[0]?.type).toBe("application/pdf");
  });

  it("openExternalMedia types dropped audio by its extension whatever File.type says", () => {
    const { result } = renderHook(() => useViewer(filesApi, null, LIMITS));
    act(() => {
      result.current.openExternalMedia(
        "voice.opus",
        new File(["OggS"], "voice.opus", { type: "" }),
        "audio",
      );
      result.current.openExternalMedia(
        "song.FLAC",
        new File(["fLaC"], "song.FLAC", { type: "" }),
        "audio",
      );
    });
    expect(createdFrom.map((blob) => blob.type)).toEqual([
      "audio/ogg",
      "audio/flac",
    ]);
  });

  it("closeBuffer revokes the object URL of a dropped media buffer", () => {
    const { result } = renderHook(() => useViewer(filesApi, null, LIMITS));
    let key = "";
    act(() => {
      key = result.current.openExternalMedia(
        "a.png",
        new File(["x"], "a.png"),
        "image",
      );
    });
    act(() => {
      result.current.closeBuffer(key);
    });
    expect(revoked).toContain("blob:0");
    expect(result.current.buffers[key]).toBeUndefined();
  });

  it("revokes any remaining object URLs on unmount", () => {
    const { result, unmount } = renderHook(() =>
      useViewer(filesApi, null, LIMITS),
    );
    act(() => {
      result.current.openExternalMedia(
        "a.png",
        new File(["x"], "a.png"),
        "image",
      );
    });
    unmount();
    expect(revoked).toContain("blob:0");
  });
});

describe("useViewer media text", () => {
  it("reads a repo media file as text only when first switched to it", async () => {
    const read = vi.fn<FilesApi["read"]>(() =>
      Promise.resolve(text("\u0000raw")),
    );
    const { result } = renderHook(() =>
      useViewer({ ...filesApi, read }, null, LIMITS),
    );
    let key = "";
    act(() => {
      key = result.current.ensureMediaBuffer("/repo", "a.png", "image");
    });
    expect(read).not.toHaveBeenCalled();
    await act(async () => {
      result.current.togglePreview(key);
    });
    expect(read).toHaveBeenCalledWith("/repo", "a.png", "utf8", {
      signal: expect.anything(),
      knownVersion: undefined,
      limit: MIB,
    });
    expect(result.current.buffers[key]).toMatchObject({
      preview: true,
      status: "ready",
      content: "\u0000raw",
    });
    await act(async () => {
      result.current.togglePreview(key);
      result.current.togglePreview(key);
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("reads a dropped media file as text from the file itself", async () => {
    const read = vi.fn<FilesApi["read"]>();
    const { result } = renderHook(() =>
      useViewer({ ...filesApi, read }, null, LIMITS),
    );
    let key = "";
    act(() => {
      key = result.current.openExternalMedia(
        "a.png",
        new File(["\u0000png"], "a.png"),
        "image",
      );
    });
    await act(async () => {
      result.current.togglePreview(key);
    });
    await vi.waitFor(() =>
      expect(result.current.buffers[key]?.content).toBe("\u0000png"),
    );
    expect(result.current.buffers[key]?.status).toBe("ready");
    expect(read).not.toHaveBeenCalled();
  });

  it("a dropped media file over the read limit shows an error, and toggling back shows the media", async () => {
    const { result } = renderHook(() => useViewer(filesApi, null, LIMITS));
    const big = new File(["x"], "big.mp4");
    Object.defineProperty(big, "size", { value: 3 * 1024 * 1024 });
    let key = "";
    act(() => {
      key = result.current.openExternalMedia("big.mp4", big, "video");
    });
    await act(async () => {
      result.current.togglePreview(key);
    });
    expect(result.current.buffers[key]?.status).toBe("error");
    act(() => {
      result.current.togglePreview(key);
    });
    expect(result.current.buffers[key]).toMatchObject({
      status: "ready",
      preview: false,
    });
  });
});

describe("useViewer encoding", () => {
  it("setEncoding re-reads the file with the encoding, and the polls keep using it", async () => {
    vi.useFakeTimers();
    const read = vi.fn<FilesApi["read"]>((_repo, _file, encoding) =>
      Promise.resolve(text(`as ${encoding}`)),
    );
    const key = viewerKey("/repo", "data.csv");
    const { result } = renderHook(() =>
      useViewer({ ...filesApi, read }, key, LIMITS),
    );
    await act(async () => {
      result.current.ensureBuffer("/repo", "data.csv");
    });
    await act(async () => {
      result.current.setEncoding(key, "shift_jis");
    });
    expect(result.current.buffers[key]).toMatchObject({
      encoding: "shift_jis",
      content: "as shift_jis",
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(read.mock.calls.map((c) => c[2])).toEqual([
      "utf8",
      "shift_jis",
      "shift_jis",
    ]);
    vi.useRealTimers();
  });
});

describe("useViewer encoding switches", () => {
  const key = viewerKey("/repo", "data.csv");

  function deferredReads() {
    const pending: Array<{
      encoding: string;
      settle: (content: string | Error) => void;
    }> = [];
    const read = vi.fn<FilesApi["read"]>(
      (_repo, _file, encoding) =>
        new Promise((resolve, reject) => {
          pending.push({
            encoding,
            settle: (c) => (c instanceof Error ? reject(c) : resolve(text(c))),
          });
        }),
    );
    return { read, pending };
  }

  it("a read started before the switch never overwrites the newer encoding's content", async () => {
    const { read, pending } = deferredReads();
    const { result } = renderHook(() =>
      useViewer({ ...filesApi, read }, null, LIMITS),
    );
    act(() => {
      result.current.ensureBuffer("/repo", "data.csv");
    });
    act(() => {
      result.current.setEncoding(key, "shift_jis");
    });
    await act(async () => {
      pending[1]?.settle("as shift_jis");
      pending[0]?.settle("as utf8");
    });
    expect(result.current.buffers[key]?.content).toBe("as shift_jis");
  });

  it("a failed re-read with the new encoding shows its error instead of the old text", async () => {
    const { read, pending } = deferredReads();
    const { result } = renderHook(() =>
      useViewer({ ...filesApi, read }, null, LIMITS),
    );
    act(() => {
      result.current.ensureBuffer("/repo", "data.csv");
    });
    await act(async () => pending[0]?.settle("as utf8"));
    act(() => {
      result.current.setEncoding(key, "shift_jis");
    });
    await act(async () => pending[1]?.settle(new Error("fs error")));
    expect(result.current.buffers[key]).toMatchObject({
      status: "error",
      error: "fs error",
    });
  });

  it("a poll that supersedes the switch read still reports its failure", async () => {
    vi.useFakeTimers();
    const { read, pending } = deferredReads();
    const { result } = renderHook(() =>
      useViewer({ ...filesApi, read }, key, LIMITS),
    );
    act(() => {
      result.current.ensureBuffer("/repo", "data.csv");
    });
    await act(async () => pending[0]?.settle("as utf8"));
    act(() => {
      result.current.setEncoding(key, "shift_jis");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(pending.map((p) => p.encoding)).toEqual([
      "utf8",
      "shift_jis",
      "shift_jis",
    ]);
    await act(async () => {
      pending[1]?.settle(new Error("superseded"));
      pending[2]?.settle(new Error("fs error"));
    });
    expect(result.current.buffers[key]).toMatchObject({
      status: "error",
      error: "fs error",
    });
    vi.useRealTimers();
  });

  it("ensureBuffer reads a file opened with an encoding (a renamed tab) in it", () => {
    const { read, pending } = deferredReads();
    const { result } = renderHook(() =>
      useViewer({ ...filesApi, read }, null, LIMITS),
    );
    act(() => {
      result.current.ensureBuffer("/repo", "data.csv", "euc_jp");
    });
    expect(pending.map((p) => p.encoding)).toEqual(["euc_jp"]);
    expect(result.current.buffers[key]?.encoding).toBe("euc_jp");
  });
});

describe("useViewer polling", () => {
  const key = viewerKey("/repo", "big.html");

  it("a poll sends the version it has and keeps the content when the file is unchanged", async () => {
    vi.useFakeTimers();
    const read = vi
      .fn<FilesApi["read"]>()
      .mockResolvedValueOnce(text("v1", "tag-1"))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(text("v2", "tag-2"))
      .mockResolvedValue(null);
    const { result } = renderHook(() =>
      useViewer({ ...filesApi, read }, key, LIMITS),
    );
    await act(async () => {
      result.current.ensureBuffer("/repo", "big.html");
    });
    const loaded = result.current.buffers[key];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(result.current.buffers[key]).toBe(loaded);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(result.current.buffers[key]?.content).toBe("v2");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(read.mock.calls.map((c) => c[3]?.knownVersion)).toEqual([
      undefined,
      "tag-1",
      "tag-1",
      "tag-2",
    ]);
    vi.useRealTimers();
  });

  it("a poll while a switched encoding is still loading asks for the content, not for a version check", async () => {
    vi.useFakeTimers();
    const read = vi
      .fn<FilesApi["read"]>()
      .mockResolvedValueOnce(text("v1", "tag-u"))
      .mockReturnValueOnce(new Promise(() => {}))
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValue(text("v1", "tag-u"));
    const { result } = renderHook(() =>
      useViewer({ ...filesApi, read }, key, LIMITS),
    );
    await act(async () => {
      result.current.ensureBuffer("/repo", "big.html");
    });
    act(() => {
      result.current.setEncoding(key, "shift_jis");
      result.current.setEncoding(key, "utf8");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(read.mock.calls[3]?.[3]?.knownVersion).toBeUndefined();
    expect(result.current.buffers[key]).toMatchObject({
      status: "ready",
      content: "v1",
    });
    vi.useRealTimers();
  });

  it("after a failed read the next poll asks for the content again", async () => {
    vi.useFakeTimers();
    const read = vi
      .fn<FilesApi["read"]>()
      .mockResolvedValueOnce(text("v1", "tag-1"))
      .mockResolvedValue(text("v1", "tag-1"));
    const { result } = renderHook(() =>
      useViewer({ ...filesApi, read }, key, LIMITS),
    );
    await act(async () => {
      result.current.ensureBuffer("/repo", "big.html");
    });
    read.mockRejectedValueOnce(new Error("fs error"));
    await act(async () => {
      result.current.setEncoding(key, "shift_jis");
    });
    expect(result.current.buffers[key]?.status).toBe("error");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(read.mock.calls.map((c) => c[3]?.knownVersion)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(result.current.buffers[key]?.status).toBe("ready");
    vi.useRealTimers();
  });
});

describe("useViewer large files", () => {
  const key = viewerKey("/repo", "big.log");

  /** Refuses any read carrying a limit below `size`, like the server; otherwise answers with `onFull`. */
  function sizedReads(
    size: number,
    onFull: () => Promise<{ content: string; version: string | null }>,
  ) {
    return vi.fn<FilesApi["read"]>((_repo, _file, _encoding, options) =>
      options?.limit !== undefined && size > options.limit
        ? Promise.reject(new FileTooLargeError("too large", size))
        : onFull(),
    );
  }

  it("reads a repo file with the confirmation size as its limit and waits when it is over", async () => {
    const read = sizedReads(1.5 * MIB, () => Promise.resolve(text("all")));
    const { result } = renderHook(() =>
      useViewer({ ...filesApi, read }, null, LIMITS),
    );
    await act(async () => {
      result.current.ensureBuffer("/repo", "big.log");
    });
    expect(read.mock.calls[0]?.[3]?.limit).toBe(MIB);
    expect(result.current.buffers[key]).toMatchObject({
      status: "tooLarge",
      tooLarge: { reason: "confirm", size: 1.5 * MIB },
    });
  });

  it("Open anyway re-reads without the limit, and the polls keep reading without it", async () => {
    vi.useFakeTimers();
    const read = sizedReads(1.5 * MIB, () => Promise.resolve(text("all")));
    const { result } = renderHook(() =>
      useViewer({ ...filesApi, read }, key, LIMITS),
    );
    await act(async () => {
      result.current.ensureBuffer("/repo", "big.log");
    });
    await act(async () => {
      result.current.openAnyway(key);
    });
    expect(result.current.buffers[key]).toMatchObject({
      status: "ready",
      content: "all",
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(read.mock.calls.map((c) => c[3]?.limit)).toEqual([
      MIB,
      undefined,
      undefined,
    ]);
    vi.useRealTimers();
  });

  it("a file over the maximum says so, with the maximum, and cannot be opened anyway", async () => {
    const read = sizedReads(3 * MIB, () => Promise.resolve(text("all")));
    const { result } = renderHook(() =>
      useViewer({ ...filesApi, read }, null, LIMITS),
    );
    await act(async () => {
      result.current.ensureBuffer("/repo", "big.log");
    });
    expect(result.current.buffers[key]?.tooLarge).toEqual({
      reason: "overMax",
      size: 3 * MIB,
      maxBytes: 2 * MIB,
    });
    await act(async () => {
      result.current.openAnyway(key);
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("a read opened anyway that times out is reported as too large to open, and is not polled again", async () => {
    vi.useFakeTimers();
    const read = sizedReads(1.5 * MIB, () =>
      Promise.reject(new DOMException("aborted", "AbortError")),
    );
    const { result } = renderHook(() =>
      useViewer({ ...filesApi, read }, key, LIMITS),
    );
    await act(async () => {
      result.current.ensureBuffer("/repo", "big.log");
    });
    await act(async () => {
      result.current.openAnyway(key);
    });
    expect(result.current.buffers[key]).toMatchObject({
      status: "tooLarge",
      tooLarge: { reason: "failedAfterConfirm" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(read).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("a timeout on a file within the confirmation size keeps the usual message", async () => {
    const read = sizedReads(10, () =>
      Promise.reject(new DOMException("aborted", "AbortError")),
    );
    const { result } = renderHook(() =>
      useViewer({ ...filesApi, read }, null, LIMITS),
    );
    await act(async () => {
      result.current.ensureBuffer("/repo", "big.log");
    });
    expect(result.current.buffers[key]).toMatchObject({
      status: "error",
      error: i18n.t("viewer.readTimeout"),
    });
  });
});

describe("useViewer pathOf", () => {
  it("returns the absolute path for a repo buffer", () => {
    const { result } = renderHook(() => useViewer(filesApi, null, LIMITS));
    let key = "";
    act(() => {
      key = result.current.ensureBuffer("/repo", "src/app.ts");
    });
    expect(result.current.pathOf(key)).toBe("/repo/src/app.ts");
  });

  it("returns null for an external buffer (no repo path)", () => {
    const { result } = renderHook(() => useViewer(filesApi, null, LIMITS));
    let key = "";
    act(() => {
      key = result.current.openExternal("README.md", "content");
    });
    expect(result.current.pathOf(key)).toBeNull();
  });
});
