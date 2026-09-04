import { describe, expect, it } from "vitest";

import {
  CONVERSATION_TITLES_KEY,
  commitTitle,
  effectiveCustomTitle,
  loadConversationTitles,
  nextDuplicateTitle,
  resolveTitle,
  saveConversationTitles,
  splitDuplicateMarker,
} from "./conversation-title.js";

const WID_A = "0b6cbc45-83a9-4f2e-9c3d-1a2b3c4d5e6f";
const WID_B = "11111111-2222-4333-8444-555566667777";

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

  it("keeps only {title,name} for cockpitTerminalId (UUID) keys; drops empty titles, missing names, and non-UUID keys", () => {
    const s = memStorage({
      [CONVERSATION_TITLES_KEY]: JSON.stringify({
        [WID_A]: { title: "作業A", name: "repoA" },
        [WID_B]: { title: "", name: "repoB" }, // empty title
        "22222222-3333-4444-8555-666677778888": { title: "x" }, // name missing
        "@1": { title: "旧 cockpitTerminalId キー", name: "repoC" }, // non-UUID key (retired format, discarded on migration)
        "shell:0:repoD": { title: "y", name: "z" }, // plain-shell id (non-UUID)
        "33333333-4444-4555-8666-777788889999": "旧 string 形式",
      }),
    });
    expect(loadConversationTitles(s)).toEqual({
      [WID_A]: { title: "作業A", name: "repoA" },
    });
  });

  it("discards the entire retired cockpitTerminalId-key (@N) table on migration (empty)", () => {
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
    saveConversationTitles(s, { [WID_A]: { title: "x", name: "r" } });
    expect(s.map.get(CONVERSATION_TITLES_KEY)).toBe(
      JSON.stringify({ [WID_A]: { title: "x", name: "r" } }),
    );
  });

  it("does nothing when storage is null", () => {
    expect(() =>
      saveConversationTitles(null, { [WID_A]: { title: "x", name: "r" } }),
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
      saveConversationTitles(throwing, { [WID_A]: { title: "x", name: "r" } }),
    ).not.toThrow();
  });
});

describe("commitTitle", () => {
  it("sets the trimmed title as a cockpitTerminalId-key / name pair", () => {
    expect(commitTitle({}, WID_A, "repoA", "  作業A  ")).toEqual({
      [WID_A]: { title: "作業A", name: "repoA" },
    });
  });

  it("removes the custom title and reverts to auto when empty or whitespace-only", () => {
    expect(
      commitTitle({ [WID_A]: { title: "旧", name: "r" } }, WID_A, "r", "   "),
    ).toEqual({});
  });

  it("does not change titles of other cockpitTerminalIds (pure, non-destructive)", () => {
    const prev = {
      [WID_A]: { title: "A", name: "r1" },
      [WID_B]: { title: "B", name: "r2" },
    };
    const next = commitTitle(prev, WID_A, "r1", "A2");
    expect(next).toEqual({
      [WID_A]: { title: "A2", name: "r1" },
      [WID_B]: { title: "B", name: "r2" },
    });
    expect(prev).toEqual({
      [WID_A]: { title: "A", name: "r1" },
      [WID_B]: { title: "B", name: "r2" },
    });
  });

  it("is a no-op when cockpitTerminalId is undefined", () => {
    expect(commitTitle({}, undefined, "repoA", "作業A")).toEqual({});
  });

  it("is a no-op when cockpitTerminalId is not a UUID (unbound/plain-shell window)", () => {
    expect(commitTitle({}, "shell:0:repoA", "repoA", "作業A")).toEqual({});
    expect(commitTitle({}, "", "repoA", "作業A")).toEqual({});
  });

  it("renaming two non-UUID windows in a row does not collide or cross wires (both no-ops)", () => {
    const a = commitTitle({}, undefined, "repoA", "AのタイトルX");
    const b = commitTitle(a, undefined, "repoB", "BのタイトルY");
    expect(b).toEqual({});
  });
});

describe("effectiveCustomTitle", () => {
  const titles = { [WID_A]: { title: "手動", name: "repoA" } };

  it("returns the manual title when both cockpitTerminalId and name match", () => {
    expect(
      effectiveCustomTitle(titles, { cockpitTerminalId: WID_A, name: "repoA" }),
    ).toBe("手動");
  });

  it("does not adopt on name mismatch (cockpitTerminalId reused for a different repo) to prevent title possession", () => {
    expect(
      effectiveCustomTitle(titles, { cockpitTerminalId: WID_A, name: "repoB" }),
    ).toBeUndefined();
  });

  it("returns undefined when the entry is absent", () => {
    expect(
      effectiveCustomTitle(titles, { cockpitTerminalId: WID_B, name: "repoA" }),
    ).toBeUndefined();
  });

  it("returns undefined when cockpitTerminalId is undefined", () => {
    expect(
      effectiveCustomTitle(titles, {
        cockpitTerminalId: undefined,
        name: "repoA",
      }),
    ).toBeUndefined();
  });

  it("returns undefined when cockpitTerminalId is not a UUID (unbound/plain-shell window)", () => {
    const leaked = {
      "shell:0:repoA": { title: "漏洩", name: "repoA" },
    } as unknown as typeof titles;
    expect(
      effectiveCustomTitle(leaked, {
        cockpitTerminalId: "shell:0:repoA",
        name: "repoA",
      }),
    ).toBeUndefined();
  });

  it("uses distinct titles for the same cwd/name when the cockpitTerminalId differs", () => {
    const t = {
      [WID_A]: { title: "AのタイトルX", name: "repo" },
      [WID_B]: { title: "BのタイトルY", name: "repo" },
    };
    expect(
      effectiveCustomTitle(t, { cockpitTerminalId: WID_A, name: "repo" }),
    ).toBe("AのタイトルX");
    expect(
      effectiveCustomTitle(t, { cockpitTerminalId: WID_B, name: "repo" }),
    ).toBe("BのタイトルY");
  });

  it("persists across resume/restore because the owned-mode cockpitTerminalId is preserved", () => {
    // In owned mode, restore rebuilds the session under the same UUID cockpitTerminalId
    // (and relaunches `claude --resume <cockpitTerminalId>`), so the title re-matches.
    const t = commitTitle({}, WID_A, "repoA", "復元後も残るタイトル");
    const afterRestore = { cockpitTerminalId: WID_A, name: "repoA" };
    expect(effectiveCustomTitle(t, afterRestore)).toBe("復元後も残るタイトル");
  });

  it("is renamable/adopted even when claude is not currently detected (state no_claude keeps its cockpitTerminalId)", () => {
    const t = commitTitle({}, WID_A, "repoA", "claude 終了後も残る");
    expect(
      effectiveCustomTitle(t, { cockpitTerminalId: WID_A, name: "repoA" }),
    ).toBe("claude 終了後も残る");
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

describe("splitDuplicateMarker", () => {
  it("treats an unmarked label as the original (number 1)", () => {
    expect(splitDuplicateMarker("hello")).toEqual({ index: 1, base: "hello" });
  });
  it("splits a leading (N) marker off the base", () => {
    expect(splitDuplicateMarker("(2) hello")).toEqual({
      index: 2,
      base: "hello",
    });
    expect(splitDuplicateMarker("(13) hello")).toEqual({
      index: 13,
      base: "hello",
    });
  });
  it("only strips a marker at the very start", () => {
    expect(splitDuplicateMarker("hello (2)")).toEqual({
      index: 1,
      base: "hello (2)",
    });
  });
});

describe("nextDuplicateTitle", () => {
  it("marks the first copy as (2)", () => {
    expect(nextDuplicateTitle("hello", ["hello"])).toBe("(2) hello");
  });
  it("continues the sequence past existing copies", () => {
    expect(
      nextDuplicateTitle("hello", ["hello", "(2) hello", "(3) hello"]),
    ).toBe("(4) hello");
  });
  it("numbers off the base when duplicating a copy (no marker stacking)", () => {
    expect(nextDuplicateTitle("(2) hello", ["hello", "(2) hello"])).toBe(
      "(3) hello",
    );
  });
  it("ignores copies of a different base", () => {
    expect(nextDuplicateTitle("hello", ["hello", "(2) world"])).toBe(
      "(2) hello",
    );
  });
});
