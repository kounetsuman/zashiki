import { describe, expect, it } from "vitest";
import {
  loadSeenIds,
  NOTIFICATIONS_SEEN_KEY,
  saveSeenIds,
} from "./notifications-seen.js";

function memoryStorage(initial?: string): Pick<Storage, "getItem" | "setItem"> {
  let value = initial ?? null;
  return {
    getItem: (key) => (key === NOTIFICATIONS_SEEN_KEY ? value : null),
    setItem: (key, next) => {
      if (key === NOTIFICATIONS_SEEN_KEY) value = next;
    },
  };
}

describe("loadSeenIds", () => {
  it("returns an empty list when storage is null", () => {
    expect(loadSeenIds(null)).toEqual([]);
  });

  it("returns an empty list when nothing is stored", () => {
    expect(loadSeenIds(memoryStorage())).toEqual([]);
  });

  it("reads back stored string ids", () => {
    expect(loadSeenIds(memoryStorage(JSON.stringify(["a", "b"])))).toEqual([
      "a",
      "b",
    ]);
  });

  it("drops non-string entries", () => {
    expect(loadSeenIds(memoryStorage(JSON.stringify(["a", 1, null])))).toEqual([
      "a",
    ]);
  });

  it("returns an empty list for a non-array payload", () => {
    expect(loadSeenIds(memoryStorage(JSON.stringify({ a: 1 })))).toEqual([]);
  });

  it("returns an empty list for corrupt json", () => {
    expect(loadSeenIds(memoryStorage("{not json"))).toEqual([]);
  });
});

describe("saveSeenIds", () => {
  it("round-trips through storage", () => {
    const storage = memoryStorage();
    saveSeenIds(storage, ["x", "y"]);
    expect(loadSeenIds(storage)).toEqual(["x", "y"]);
  });

  it("is a no-op when storage is null", () => {
    expect(() => saveSeenIds(null, ["x"])).not.toThrow();
  });
});
