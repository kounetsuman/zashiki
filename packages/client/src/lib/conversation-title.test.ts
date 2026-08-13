import { describe, expect, it } from "vitest";

import {
  CONVERSATION_TITLES_KEY,
  commitTitle,
  effectiveCustomTitle,
  loadConversationTitles,
  resolveTitle,
  saveConversationTitles,
} from "./conversation-title.js";

const SID_A = "0b6cbc45-83a9-4f2e-9c3d-1a2b3c4d5e6f";
const SID_B = "11111111-2222-4333-8444-555566667777";

function memStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    map,
  };
}

describe("loadConversationTitles", () => {
  it("returns empty when storage is null", () => {
    expect(loadConversationTitles(null)).toEqual({});
  });

  it("returns empty when the key is unset", () => {
    expect(loadConversationTitles(memStorage())).toEqual({});
  });

  it("falls back to empty on broken JSON", () => {
    const s = memStorage({ [CONVERSATION_TITLES_KEY]: "{" });
    expect(loadConversationTitles(s)).toEqual({});
  });

  it("keeps only {title,name} for sid (UUID) keys; drops empty titles, missing names, and non-UUID keys", () => {
    const s = memStorage({
      [CONVERSATION_TITLES_KEY]: JSON.stringify({
        [SID_A]: { title: "作業A", name: "repoA" },
        [SID_B]: { title: "", name: "repoB" }, // empty title
        "22222222-3333-4444-8555-666677778888": { title: "x" }, // name missing
        "@1": { title: "旧 windowId キー", name: "repoC" }, // non-UUID key (old format, discarded on migration)
        "not-a-uuid": { title: "y", name: "z" },
        "33333333-4444-4555-8666-777788889999": "旧 string 形式",
      }),
    });
    expect(loadConversationTitles(s)).toEqual({
      [SID_A]: { title: "作業A", name: "repoA" },
    });
  });

  it("discards the entire legacy windowId-key (@N) table on migration (empty)", () => {
    const s = memStorage({
      [CONVERSATION_TITLES_KEY]: JSON.stringify({
        "@1": { title: "作業A", name: "repoA" },
        "@2": { title: "作業B", name: "repoB" },
      }),
    });
    expect(loadConversationTitles(s)).toEqual({});
  });
});

describe("saveConversationTitles", () => {
  it("writes JSON", () => {
    const s = memStorage();
    saveConversationTitles(s, { [SID_A]: { title: "x", name: "r" } });
    expect(s.map.get(CONVERSATION_TITLES_KEY)).toBe(
      JSON.stringify({ [SID_A]: { title: "x", name: "r" } }),
    );
  });

  it("does nothing when storage is null", () => {
    expect(() =>
      saveConversationTitles(null, { [SID_A]: { title: "x", name: "r" } }),
    ).not.toThrow();
  });

  it("swallows errors when setItem throws (full/private mode)", () => {
    const throwing = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("QuotaExceededError");
      },
    };
    expect(() =>
      saveConversationTitles(throwing, { [SID_A]: { title: "x", name: "r" } }),
    ).not.toThrow();
  });
});

describe("commitTitle", () => {
  it("sets the trimmed title as a sid-key / name pair", () => {
    expect(commitTitle({}, SID_A, "repoA", "  作業A  ")).toEqual({
      [SID_A]: { title: "作業A", name: "repoA" },
    });
  });

  it("removes the custom title and reverts to auto when empty or whitespace-only", () => {
    expect(
      commitTitle({ [SID_A]: { title: "旧", name: "r" } }, SID_A, "r", "   "),
    ).toEqual({});
  });

  it("does not change titles of other sids (pure, non-destructive)", () => {
    const prev = {
      [SID_A]: { title: "A", name: "r1" },
      [SID_B]: { title: "B", name: "r2" },
    };
    const next = commitTitle(prev, SID_A, "r1", "A2");
    expect(next).toEqual({
      [SID_A]: { title: "A2", name: "r1" },
      [SID_B]: { title: "B", name: "r2" },
    });
    expect(prev).toEqual({
      [SID_A]: { title: "A", name: "r1" },
      [SID_B]: { title: "B", name: "r2" },
    });
  });

  it("is a no-op when sid is undefined (claude not started / old server)", () => {
    expect(commitTitle({}, undefined, "repoA", "作業A")).toEqual({});
  });

  it('is a no-op when sid is not a UUID (prevents "undefined" bucket pollution)', () => {
    expect(commitTitle({}, "undefined", "repoA", "作業A")).toEqual({});
    expect(commitTitle({}, "", "repoA", "作業A")).toEqual({});
  });

  it("renaming two sid-less windows in a row does not collide or cross wires (both no-ops)", () => {
    const a = commitTitle({}, undefined, "repoA", "AのタイトルX");
    const b = commitTitle(a, undefined, "repoB", "BのタイトルY");
    expect(b).toEqual({});
  });
});

describe("effectiveCustomTitle", () => {
  const titles = { [SID_A]: { title: "手動", name: "repoA" } };

  it("returns the manual title when both sid and name match", () => {
    expect(effectiveCustomTitle(titles, { sid: SID_A, name: "repoA" })).toBe(
      "手動",
    );
  });

  it("does not adopt on name mismatch (sid collision, double resume, etc.) to prevent title possession", () => {
    expect(
      effectiveCustomTitle(titles, { sid: SID_A, name: "repoB" }),
    ).toBeUndefined();
  });

  it("returns undefined when the entry is absent", () => {
    expect(
      effectiveCustomTitle(titles, { sid: SID_B, name: "repoA" }),
    ).toBeUndefined();
  });

  it("returns undefined when sid is undefined (claude not started / old server)", () => {
    expect(
      effectiveCustomTitle(titles, { sid: undefined, name: "repoA" }),
    ).toBeUndefined();
  });

  it('returns undefined when sid is not a UUID (prevents "undefined" key leakage)', () => {
    const leaked = {
      undefined: { title: "漏洩", name: "repoA" },
    } as unknown as typeof titles;
    expect(
      effectiveCustomTitle(leaked, { sid: undefined, name: "repoA" }),
    ).toBeUndefined();
  });

  it("uses distinct titles for the same cwd/name when the sid differs", () => {
    const t = {
      [SID_A]: { title: "AのタイトルX", name: "repo" },
      [SID_B]: { title: "BのタイトルY", name: "repo" },
    };
    expect(effectiveCustomTitle(t, { sid: SID_A, name: "repo" })).toBe(
      "AのタイトルX",
    );
    expect(effectiveCustomTitle(t, { sid: SID_B, name: "repo" })).toBe(
      "BのタイトルY",
    );
  });

  it("re-matches when sid is unchanged even if windowId changes on restore", () => {
    // At assignment: windowId=@1, sid=SID_A. After restore, windowId changes to @7 but sid is unchanged.
    const t = commitTitle({}, SID_A, "repoA", "復元後も残るタイトル");
    const afterRestore = { sid: SID_A, name: "repoA" };
    expect(effectiveCustomTitle(t, afterRestore)).toBe("復元後も残るタイトル");
  });
});

describe("resolveTitle", () => {
  const s = { title: "自動要約", name: "myrepo" };
  it("uses the edited title when present", () => {
    expect(resolveTitle("手動", s)).toBe("手動");
  });
  it("falls back to auto when the edit is an empty string", () => {
    expect(resolveTitle("", s)).toBe("自動要約");
  });
  it("uses the auto title when there is no edit", () => {
    expect(resolveTitle(undefined, s)).toBe("自動要約");
  });
  it("uses name when there is no edit and the auto title is null", () => {
    expect(resolveTitle(undefined, { title: null, name: "myrepo" })).toBe(
      "myrepo",
    );
  });
});
