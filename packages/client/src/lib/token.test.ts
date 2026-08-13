import { describe, expect, it } from "vitest";

import {
  authHeaders,
  resolveToken,
  stripTokenFromSearch,
  TOKEN_STORAGE_KEY,
} from "./token.js";

function memoryStore(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    dump: () => Object.fromEntries(map),
  };
}

describe("resolveToken", () => {
  it("saves ?token= to sessionStorage and returns it", () => {
    const store = memoryStore();
    expect(resolveToken("?token=abc123", store)).toBe("abc123");
    expect(store.dump()).toEqual({ [TOKEN_STORAGE_KEY]: "abc123" });
  });

  it("reads from storage when not in the URL (reload / in-tab navigation)", () => {
    const store = memoryStore({ [TOKEN_STORAGE_KEY]: "stored" });
    expect(resolveToken("", store)).toBe("stored");
    expect(resolveToken("?x=1", store)).toBe("stored");
  });

  it("prefers the URL token over storage and overwrites it", () => {
    const store = memoryStore({ [TOKEN_STORAGE_KEY]: "old" });
    expect(resolveToken("?token=new", store)).toBe("new");
    expect(store.dump()).toEqual({ [TOKEN_STORAGE_KEY]: "new" });
  });

  it("returns null when absent everywhere", () => {
    expect(resolveToken("?x=1", memoryStore())).toBeNull();
  });
});

describe("stripTokenFromSearch", () => {
  it("removes only the token parameter from the URL", () => {
    expect(stripTokenFromSearch("?token=abc")).toBe("");
    expect(stripTokenFromSearch("?a=1&token=abc&b=2")).toBe("?a=1&b=2");
    expect(stripTokenFromSearch("")).toBe("");
  });
});

describe("authHeaders", () => {
  it("returns the x-zashiki-token header for REST (does not use cookies)", () => {
    expect(authHeaders("t0ken")).toEqual({ "x-zashiki-token": "t0ken" });
  });
});
