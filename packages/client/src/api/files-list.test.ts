import { describe, expect, it, vi } from "vitest";

import { createFilesListApi } from "./files-list.js";

const EMPTY = { truncated: false, home: "/home/me", files: [] };

function apiWith() {
  const fetchFn = vi.fn(
    async () =>
      new Response(JSON.stringify(EMPTY), {
        headers: { "content-type": "application/json" },
      }),
  );
  const api = createFilesListApi(
    "http://host",
    "tok",
    fetchFn as unknown as typeof fetch,
  );
  const urlOf = (call: number): string =>
    (fetchFn.mock.calls[call] as unknown as [string])[0];
  return { api, urlOf };
}

describe("createFilesListApi.list", () => {
  it("asks for the active terminal's working directory", async () => {
    const { api, urlOf } = apiWith();
    await api.list({ kind: "workspace", cwd: "/ws/my org/r" });
    expect(urlOf(0)).toBe("http://host/api/files?cwd=%2Fws%2Fmy+org%2Fr");
  });

  it("omits the working directory when there is no active terminal", async () => {
    const { api, urlOf } = apiWith();
    await api.list({ kind: "workspace", cwd: null });
    expect(urlOf(0)).toBe("http://host/api/files");
  });

  it("asks for a path query's directory", async () => {
    const { api, urlOf } = apiWith();
    await api.list({ kind: "path", dir: "~/ws/" });
    expect(urlOf(0)).toBe("http://host/api/files?dir=%7E%2Fws%2F");
  });
});
