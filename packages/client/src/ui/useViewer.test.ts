// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FilesApi } from "../api/files.js";
import { viewerKey } from "../viewer/viewer-model.js";
import { useViewer } from "./useViewer.js";

const filesApi: FilesApi = {
  read: () => Promise.resolve(""),
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
    const { result } = renderHook(() => useViewer(filesApi, null));
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
    const { result } = renderHook(() => useViewer(filesApi, null));
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
    const { result } = renderHook(() => useViewer(filesApi, null));
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
    const { result } = renderHook(() => useViewer(filesApi, null));
    act(() => {
      result.current.openExternalMedia(
        "spec.pdf",
        new File(["%PDF"], "spec.pdf", { type: "" }),
        "pdf",
      );
    });
    expect(createdFrom[0]?.type).toBe("application/pdf");
  });

  it("closeBuffer revokes the object URL of a dropped media buffer", () => {
    const { result } = renderHook(() => useViewer(filesApi, null));
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
    const { result, unmount } = renderHook(() => useViewer(filesApi, null));
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

describe("useViewer encoding", () => {
  it("setEncoding re-reads the file with the encoding, and the polls keep using it", async () => {
    vi.useFakeTimers();
    const read = vi.fn<FilesApi["read"]>((_repo, _file, encoding) =>
      Promise.resolve(`as ${encoding}`),
    );
    const key = viewerKey("/repo", "data.csv");
    const { result } = renderHook(() => useViewer({ ...filesApi, read }, key));
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

describe("useViewer pathOf", () => {
  it("returns the absolute path for a repo buffer", () => {
    const { result } = renderHook(() => useViewer(filesApi, null));
    let key = "";
    act(() => {
      key = result.current.ensureBuffer("/repo", "src/app.ts");
    });
    expect(result.current.pathOf(key)).toBe("/repo/src/app.ts");
  });

  it("returns null for an external buffer (no repo path)", () => {
    const { result } = renderHook(() => useViewer(filesApi, null));
    let key = "";
    act(() => {
      key = result.current.openExternal("README.md", "content");
    });
    expect(result.current.pathOf(key)).toBeNull();
  });
});
