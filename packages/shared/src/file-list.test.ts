import { describe, expect, it } from "vitest";

import {
  type FileEntry,
  fileListResponseSchema,
  filterFiles,
  parseQuickOpenQuery,
} from "./file-list.js";

function entry(org: string, relPath: string): FileEntry {
  return { org, repo: "r", path: `/root/${org}/${relPath}`, relPath };
}

describe("parseQuickOpenQuery", () => {
  it("returns the name unchanged when there is no colon", () => {
    expect(parseQuickOpenQuery("App.tsx")).toEqual({
      name: "App.tsx",
      line: null,
    });
  });

  it("splits a trailing :line into name and 1-based line", () => {
    expect(parseQuickOpenQuery("src/App.tsx:42")).toEqual({
      name: "src/App.tsx",
      line: 42,
    });
  });

  it("drops a trailing colon with no digits and reports no line", () => {
    expect(parseQuickOpenQuery("App.tsx:")).toEqual({
      name: "App.tsx",
      line: null,
    });
  });

  it("treats a non-numeric suffix as part of the name", () => {
    expect(parseQuickOpenQuery("a:b")).toEqual({ name: "a:b", line: null });
  });

  it("treats a leading colon as a plain name (no empty-name match-all)", () => {
    expect(parseQuickOpenQuery(":42")).toEqual({ name: ":42", line: null });
  });

  it("trims surrounding whitespace", () => {
    expect(parseQuickOpenQuery("  App.tsx:3  ")).toEqual({
      name: "App.tsx",
      line: 3,
    });
  });
});

describe("filterFiles", () => {
  const files = [
    entry("alpha", "src/App.tsx"),
    entry("alpha", "src/app-store.ts"),
    entry("beta", "src/App.tsx"),
    entry("beta", "docs/readme.md"),
  ];

  it("returns everything on an empty query, active org first then by path", () => {
    const got = filterFiles(files, "", "beta", 10).map(
      (s) => `${s.file.org}:${s.file.relPath}`,
    );
    expect(got).toEqual([
      "beta:docs/readme.md",
      "beta:src/App.tsx",
      "alpha:src/App.tsx",
      "alpha:src/app-store.ts",
    ]);
  });

  it("keeps only fuzzy subsequence matches", () => {
    const got = filterFiles(files, "app", null, 10).map((s) => s.file.relPath);
    expect(got).toContain("src/App.tsx");
    expect(got).toContain("src/app-store.ts");
    expect(got).not.toContain("docs/readme.md");
  });

  it("ranks the active org above an otherwise identical match", () => {
    const [first] = filterFiles(files, "App.tsx", "beta", 10);
    expect(first?.file.org).toBe("beta");
  });

  it("reports matched indices into relPath for highlighting", () => {
    const [top] = filterFiles([entry("o", "src/App.tsx")], "App", null, 10);
    expect(top?.matches).toEqual([4, 5, 6]);
  });

  it("respects the limit", () => {
    expect(filterFiles(files, "", null, 2)).toHaveLength(2);
  });
});

describe("fileListResponseSchema", () => {
  it("accepts a well-formed response", () => {
    const ok = fileListResponseSchema.safeParse({
      truncated: false,
      files: [{ org: "o", repo: "r", path: "/a/b.ts", relPath: "b.ts" }],
    });
    expect(ok.success).toBe(true);
  });
});
