import { describe, expect, it, vi } from "vitest";

import { createReposApi } from "./repos.js";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("createReposApi.add", () => {
  it("POSTs the path (and color when given) and returns the parsed org", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ org: "myorg" }));
    const api = createReposApi(
      "http://host",
      "tok",
      fetchFn as unknown as typeof fetch,
    );

    const res = await api.add("/ws/myorg", "#7aa2f7");

    expect(res).toEqual({ org: "myorg" });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://host/api/repos/add");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      path: "/ws/myorg",
      color: "#7aa2f7",
    });
  });

  it("omits color from the body when not provided", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ org: "x" }));
    const api = createReposApi(
      "http://host",
      "tok",
      fetchFn as unknown as typeof fetch,
    );
    await api.add("/ws/x");
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ path: "/ws/x" });
  });

  it("throws with the server error message on a non-ok response", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(
        { error: "this path is already registered" },
        { status: 409 },
      ),
    );
    const api = createReposApi(
      "http://host",
      "tok",
      fetchFn as unknown as typeof fetch,
    );
    await expect(api.add("/ws/dup")).rejects.toThrow(
      "this path is already registered",
    );
  });
});

describe("createReposApi.validate", () => {
  it("GETs the encoded path and parses the status", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ status: "ok", org: "myorg" }),
    );
    const api = createReposApi(
      "http://host",
      "tok",
      fetchFn as unknown as typeof fetch,
    );
    const res = await api.validate("/ws/my org");
    expect(res).toEqual({ status: "ok", org: "myorg" });
    const [url] = fetchFn.mock.calls[0] as unknown as [string];
    expect(url).toBe("http://host/api/fs/validate?path=%2Fws%2Fmy%20org");
  });
});

describe("createReposApi.browse", () => {
  it("GETs the encoded path and parses the dir entries", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        entries: [{ name: "workshop", kind: "dir" }],
        truncated: false,
      }),
    );
    const api = createReposApi(
      "http://host",
      "tok",
      fetchFn as unknown as typeof fetch,
    );
    const res = await api.browse("/ws/wo");
    expect(res.entries).toEqual([{ name: "workshop", kind: "dir" }]);
    const [url] = fetchFn.mock.calls[0] as unknown as [string];
    expect(url).toBe("http://host/api/fs/browse?path=%2Fws%2Fwo");
  });
});

describe("createReposApi.list", () => {
  it("GETs /api/repos/list and parses the org roots", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ orgs: [{ org: "myorg", path: "/ws/myorg" }] }),
    );
    const api = createReposApi(
      "http://host",
      "tok",
      fetchFn as unknown as typeof fetch,
    );
    const res = await api.list();
    expect(res.orgs).toEqual([{ org: "myorg", path: "/ws/myorg" }]);
    const [url] = fetchFn.mock.calls[0] as unknown as [string];
    expect(url).toBe("http://host/api/repos/list");
  });
});
