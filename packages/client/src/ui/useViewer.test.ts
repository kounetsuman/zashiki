// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FilesApi } from "../api/files.js";
import { externalViewerKey, viewerKey } from "../viewer/viewer-model.js";
import { useViewer } from "./useViewer.js";

const filesApi: FilesApi = {
  read: () => Promise.resolve(""),
  mediaUrl: (repoPath, file) => `/api/media?repoPath=${repoPath}&file=${file}`,
};

let created: string[];
let revoked: string[];

beforeEach(() => {
  created = [];
  revoked = [];
  let n = 0;
  vi.stubGlobal("URL", {
    createObjectURL: () => {
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
    act(() => {
      result.current.openExternalMedia("clip.mp4", file, "video");
    });
    const key = externalViewerKey("clip.mp4");
    expect(result.current.buffers[key]?.media?.url).toBe("blob:0");

    act(() => {
      result.current.openExternalMedia("clip.mp4", file, "video");
    });
    expect(revoked).toContain("blob:0");
    expect(result.current.buffers[key]?.media?.url).toBe("blob:1");
  });

  it("closeBuffer revokes the object URL of a dropped media buffer", () => {
    const { result } = renderHook(() => useViewer(filesApi, null));
    act(() => {
      result.current.openExternalMedia(
        "a.png",
        new File(["x"], "a.png"),
        "image",
      );
    });
    const key = externalViewerKey("a.png");
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
