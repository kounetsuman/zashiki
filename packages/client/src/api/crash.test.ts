import { describe, expect, it, vi } from "vitest";

import { buildIssueUrl, createCrashApi } from "./crash.js";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("createCrashApi.last", () => {
  it("GETs /api/last-crash with the token header and returns the log", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ log: "boom" }));
    const api = createCrashApi(
      "http://host",
      "tok",
      fetchFn as unknown as typeof fetch,
    );
    expect(await api.last()).toBe("boom");
    const [url, init] = fetchFn.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://host/api/last-crash");
    expect(init.headers).toEqual({ "x-zashiki-token": "tok" });
  });

  it("returns null when the last run was clean", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ log: null }));
    const api = createCrashApi("http://host", "t", fetchFn as never);
    expect(await api.last()).toBeNull();
  });

  it("returns null on a non-ok response", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({}, { status: 401 }));
    const api = createCrashApi("http://host", "t", fetchFn as never);
    expect(await api.last()).toBeNull();
  });
});

describe("createCrashApi.ack", () => {
  it("POSTs /api/last-crash/ack", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 204 }));
    const api = createCrashApi("http://host", "t", fetchFn as never);
    await api.ack();
    const [url, init] = fetchFn.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://host/api/last-crash/ack");
    expect(init.method).toBe("POST");
  });
});

describe("buildIssueUrl", () => {
  it("targets the zashiki new-issue form with the log fenced in the body", () => {
    const url = buildIssueUrl("panic line");
    expect(
      url.startsWith("https://github.com/kounetsuman/zashiki/issues/new?body="),
    ).toBe(true);
    const body = decodeURIComponent(url.split("?body=")[1] as string);
    expect(body).toContain("panic line");
    expect(body.startsWith("```")).toBe(true);
    expect(body.trimEnd().endsWith("```")).toBe(true);
  });

  it("keeps the URL under the cap even for a huge multibyte, backtick-heavy log", () => {
    const url = buildIssueUrl("`あ".repeat(20000));
    expect(url.length).toBeLessThanOrEqual(6000);
    const body = decodeURIComponent(url.split("?body=")[1] as string);
    expect(body.trimEnd().endsWith("```")).toBe(true);
  });
});
