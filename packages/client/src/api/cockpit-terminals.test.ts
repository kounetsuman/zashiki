import { describe, expect, it, vi } from "vitest";

import { createCockpitTerminalsApi } from "./cockpit-terminals.js";

describe("createCockpitTerminalsApi.links", () => {
  it("GETs the terminal's links with the token header", async () => {
    const link = {
      url: "https://example.com/",
      tab: "conversation",
      kind: "other",
      source: "user",
    };
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify({ links: [link] })),
    );
    const api = createCockpitTerminalsApi(
      "http://host",
      "tok",
      fetchFn as unknown as typeof fetch,
    );
    expect(await api.links("@1")).toEqual([link]);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://host/api/cockpit-terminals/links?id=%401");
    expect(init.headers).toEqual({ "x-zashiki-token": "tok" });
  });

  it("asks for GitHub details only when told to", async () => {
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify({ links: [] })),
    );
    const api = createCockpitTerminalsApi("http://host", "t", fetchFn as never);
    await api.links("@1", undefined, { details: true });
    await api.links("@1", undefined, { details: false });
    const urls = fetchFn.mock.calls.map((call) => (call as unknown[])[0]);
    expect(urls).toEqual([
      "http://host/api/cockpit-terminals/links?id=%401&details=1",
      "http://host/api/cockpit-terminals/links?id=%401",
    ]);
  });

  it("rejects on a non-ok response", async () => {
    const fetchFn = vi.fn(async () => new Response("{}", { status: 404 }));
    const api = createCockpitTerminalsApi("http://host", "t", fetchFn as never);
    await expect(api.links("@1")).rejects.toThrow("HTTP 404");
  });
});
