import { describe, expect, it, vi } from "vitest";

import { createFilesApi } from "./files.js";

function call(fetchFn: ReturnType<typeof vi.fn>): [string, RequestInit] {
  return fetchFn.mock.calls[0] as unknown as [string, RequestInit];
}

describe("createFilesApi.read", () => {
  it("returns the streamed text with the version from the ETag", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response("# hello\n", { headers: { ETag: 'W/"8-1-utf8"' } }),
    );
    const api = createFilesApi(
      "http://host",
      "tok",
      fetchFn as unknown as typeof fetch,
    );

    const read = await api.read("/repo", "README.md", "utf8");

    expect(read).toEqual({ content: "# hello\n", version: 'W/"8-1-utf8"' });
    const [url, init] = call(fetchFn);
    expect(url).toBe(
      "http://host/api/file?repoPath=%2Frepo&file=README.md&encoding=utf8",
    );
    expect(init.headers).toEqual({ "x-zashiki-token": "tok" });
  });

  it("keeps a leading BOM as content", async () => {
    const fetchFn = vi.fn(async () => new Response("\uFEFFa"));
    const api = createFilesApi(
      "http://host",
      "tok",
      fetchFn as unknown as typeof fetch,
    );

    expect(await api.read("/repo", "a.txt", "utf8")).toEqual({
      content: "\uFEFFa",
      version: null,
    });
  });

  it("sends the known version and resolves null when the file is unchanged", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 304 }));
    const api = createFilesApi(
      "http://host",
      "tok",
      fetchFn as unknown as typeof fetch,
    );

    const read = await api.read("/repo", "a.txt", "utf8", undefined, 'W/"v"');

    expect(read).toBeNull();
    expect(call(fetchFn)[1].headers).toEqual({
      "x-zashiki-token": "tok",
      "If-None-Match": 'W/"v"',
    });
  });

  it("rejects with the server's error message", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "file not found" }), {
          status: 404,
        }),
    );
    const api = createFilesApi(
      "http://host",
      "tok",
      fetchFn as unknown as typeof fetch,
    );

    await expect(api.read("/repo", "nope.txt", "utf8")).rejects.toThrow(
      "file not found",
    );
  });
});
