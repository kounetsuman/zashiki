import { describe, expect, it } from "vitest";

import {
  buildRgArgs,
  DEFAULT_SEARCH_LIMITS,
  parseRgJson,
  type ScannedRoot,
  searchRequestSchema,
  searchResponseSchema,
} from "./search.js";

describe("buildRgArgs", () => {
  const limits = DEFAULT_SEARCH_LIMITS;

  it("a plain query uses fixed-strings + smart-case", () => {
    const args = buildRgArgs({ query: "foo bar" }, limits);
    expect(args).toContain("--fixed-strings");
    expect(args).toContain("--smart-case");
    expect(args).not.toContain("--case-sensitive");
    expect(args).not.toContain("--word-regexp");
    // query is passed only as the value of --regexp (not mixed in positionally)
    expect(args).toContain("--regexp");
    expect(args[args.indexOf("--regexp") + 1]).toBe("foo bar");
  });

  it("matchCase makes it case-sensitive and drops smart-case", () => {
    const args = buildRgArgs({ query: "x", matchCase: true }, limits);
    expect(args).toContain("--case-sensitive");
    expect(args).not.toContain("--smart-case");
  });

  it("regex drops fixed-strings", () => {
    const args = buildRgArgs({ query: "f.o", regex: true }, limits);
    expect(args).not.toContain("--fixed-strings");
  });

  it("wholeWord adds --word-regexp", () => {
    const args = buildRgArgs({ query: "x", wholeWord: true }, limits);
    expect(args).toContain("--word-regexp");
  });

  it("always includes --json and the limit flags", () => {
    const args = buildRgArgs({ query: "x" }, limits);
    expect(args).toContain("--json");
    expect(args).toContain("--max-count");
    expect(args[args.indexOf("--max-count") + 1]).toBe(
      String(limits.maxPerFile),
    );
  });

  it("a leading - is not mistaken for a flag because it follows --regexp", () => {
    const args = buildRgArgs({ query: "-n" }, limits);
    expect(args[args.indexOf("--regexp") + 1]).toBe("-n");
  });
});

describe("parseRgJson", () => {
  const roots: ScannedRoot[] = [
    { org: "org1", repo: "repo-a", path: "/ws/org1/repo-a" },
    { org: "org1", repo: "repo-b", path: "/ws/org1/repo-b" },
  ];
  const limits = DEFAULT_SEARCH_LIMITS;

  function matchLine(path: string, line: number, text: string): string {
    return JSON.stringify({
      type: "match",
      data: {
        path: { text: path },
        lines: { text },
        line_number: line,
        submatches: [{ start: 0, end: 3 }],
      },
    });
  }

  it("groups match lines per file and attaches org/repo/relative path", () => {
    const out = [
      matchLine("/ws/org1/repo-a/src/a.ts", 3, "foo here\n"),
      matchLine("/ws/org1/repo-a/src/a.ts", 9, "foo again\n"),
      matchLine("/ws/org1/repo-b/b.ts", 1, "foo\n"),
    ].join("\n");
    const res = parseRgJson(out, roots, limits);
    expect(res.truncated).toBe(false);
    expect(res.files).toHaveLength(2);
    const a = res.files[0];
    expect(a?.org).toBe("org1");
    expect(a?.repo).toBe("repo-a");
    expect(a?.relPath).toBe("src/a.ts");
    expect(a?.path).toBe("/ws/org1/repo-a/src/a.ts");
    expect(a?.matches).toEqual([
      { line: 3, text: "foo here", start: 0, end: 3 },
      { line: 9, text: "foo again", start: 0, end: 3 },
    ]);
  });

  it("strips the trailing newline and returns text (including \\r\\n)", () => {
    const out = matchLine("/ws/org1/repo-a/a.ts", 1, "hit\r\n");
    const res = parseRgJson(out, roots, limits);
    expect(res.files[0]?.matches[0]?.text).toBe("hit");
  });

  it("ignores non-match lines such as begin/end/summary", () => {
    const out = [
      JSON.stringify({ type: "begin", data: { path: { text: "/x" } } }),
      matchLine("/ws/org1/repo-a/a.ts", 1, "foo\n"),
      JSON.stringify({ type: "summary", data: {} }),
      "not json",
      "",
    ].join("\n");
    const res = parseRgJson(out, roots, limits);
    expect(res.files).toHaveLength(1);
    expect(res.files[0]?.matches).toHaveLength(1);
  });

  it("discards paths that do not belong to a scanned root", () => {
    const out = matchLine("/elsewhere/x.ts", 1, "foo\n");
    const res = parseRgJson(out, roots, limits);
    expect(res.files).toHaveLength(0);
  });

  it("stops with truncated=true once the total-match limit is exceeded", () => {
    const small = { maxTotal: 2, maxPerFile: 100, maxBytesPerLine: 500 };
    const lines: string[] = [];
    for (let i = 1; i <= 5; i += 1) {
      lines.push(matchLine("/ws/org1/repo-a/a.ts", i, `foo ${i}\n`));
    }
    const res = parseRgJson(lines.join("\n"), roots, small);
    expect(res.truncated).toBe(true);
    const total = res.files.reduce((n, f) => n + f.matches.length, 0);
    expect(total).toBe(2);
  });

  it("truncates text for overly long lines (guards against a huge single line)", () => {
    const long = `${"a".repeat(1000)}\n`;
    const small = { maxTotal: 100, maxPerFile: 100, maxBytesPerLine: 50 };
    const res = parseRgJson(
      matchLine("/ws/org1/repo-a/a.ts", 1, long),
      roots,
      small,
    );
    expect(res.files[0]?.matches[0]?.text.length).toBeLessThanOrEqual(51);
  });
});

describe("zod schemas", () => {
  it("searchRequest requires query and its options are booleans", () => {
    expect(searchRequestSchema.safeParse({ query: "x" }).success).toBe(true);
    expect(
      searchRequestSchema.safeParse({
        query: "x",
        matchCase: true,
        wholeWord: false,
        regex: true,
      }).success,
    ).toBe(true);
    expect(searchRequestSchema.safeParse({}).success).toBe(false);
    expect(searchRequestSchema.safeParse({ query: 1 }).success).toBe(false);
  });

  it("validates a searchResponse", () => {
    const ok = searchResponseSchema.safeParse({
      truncated: false,
      files: [
        {
          org: "o",
          repo: "r",
          path: "/o/r/a.ts",
          relPath: "a.ts",
          matches: [{ line: 1, text: "x", start: 0, end: 1 }],
        },
      ],
    });
    expect(ok.success).toBe(true);
  });
});
