import { describe, expect, it } from "vitest";

import {
  type FileEntry,
  fileListResponseSchema,
  fileListScope,
  filterFiles,
  isPathQuery,
  parseQuickOpenQuery,
} from "./file-list.js";

function entry(org: string, relPath: string, repo = "r"): FileEntry {
  return { org, repo, path: `/root/${org}/${repo}/${relPath}`, relPath };
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

describe("isPathQuery", () => {
  it("treats a query starting with / or ~/ as a path", () => {
    expect(isPathQuery("/ws/o/r/a.ts")).toBe(true);
    expect(isPathQuery("~/ws/o")).toBe(true);
  });

  it("treats anything else as a name", () => {
    expect(isPathQuery("src/App.tsx")).toBe(false);
    expect(isPathQuery("~")).toBe(false);
    expect(isPathQuery("a~/b")).toBe(false);
    expect(isPathQuery("")).toBe(false);
  });
});

describe("fileListScope", () => {
  it("lists the active terminal's workspace for a name query", () => {
    expect(fileListScope("App", "/root/o/r/packages/client")).toEqual({
      kind: "workspace",
      cwd: "/root/o/r/packages/client",
    });
    expect(fileListScope("App", null)).toEqual({
      kind: "workspace",
      cwd: null,
    });
  });

  it("lists the typed directory for a path query, ignoring the active terminal", () => {
    expect(fileListScope("/ws/o/r/src/Ap", "/elsewhere")).toEqual({
      kind: "path",
      dir: "/ws/o/r/src/",
    });
    expect(fileListScope("~/ws/o", null)).toEqual({
      kind: "path",
      dir: "~/ws/",
    });
  });
});

describe("filterFiles", () => {
  const files = [
    entry("alpha", "src/App.tsx"),
    entry("alpha", "src/app-store.ts"),
    entry("alpha", "src/App.tsx", "r-worktree"),
    entry("alpha", "docs/readme.md", "r-worktree"),
  ];
  const opts = (activeCwd: string | null, limit = 10) => ({
    activeCwd,
    home: "/home/me",
    limit,
  });

  it("returns everything on an empty query, active repo first then by path", () => {
    const got = filterFiles(files, "", opts("/root/alpha/r-worktree")).map(
      (s) => `${s.file.repo}:${s.file.relPath}`,
    );
    expect(got).toEqual([
      "r-worktree:docs/readme.md",
      "r-worktree:src/App.tsx",
      "r:src/App.tsx",
      "r:src/app-store.ts",
    ]);
  });

  it("keeps only fuzzy subsequence matches", () => {
    const got = filterFiles(files, "app", opts(null)).map(
      (s) => s.file.relPath,
    );
    expect(got).toContain("src/App.tsx");
    expect(got).toContain("src/app-store.ts");
    expect(got).not.toContain("docs/readme.md");
  });

  it("ranks the repo the terminal is inside above the same file in another worktree", () => {
    const [first] = filterFiles(
      files,
      "App.tsx",
      opts("/root/alpha/r-worktree/src"),
    );
    expect(first?.file.repo).toBe("r-worktree");
  });

  it("does not boost a repo whose path merely shares the terminal's prefix", () => {
    const [first] = filterFiles(files, "App.tsx", opts("/root/alpha/r-work"));
    expect(first?.score).toBe(
      filterFiles(files, "App.tsx", opts(null))[0]?.score,
    );
  });

  it("boosts only the innermost repo when repos are nested", () => {
    const nested = [
      { org: "o", repo: "outer", path: "/w/outer/App.tsx", relPath: "App.tsx" },
      {
        org: "o",
        repo: "inner",
        path: "/w/outer/inner/App.tsx",
        relPath: "App.tsx",
      },
    ];
    const [first] = filterFiles(nested, "App.tsx", opts("/w/outer/inner"));
    expect(first?.file.repo).toBe("inner");
    const [fromOuter] = filterFiles(nested, "App.tsx", opts("/w/outer/lib"));
    expect(fromOuter?.file.repo).toBe("outer");
  });

  it("reports matched indices into relPath for highlighting", () => {
    const [top] = filterFiles([entry("o", "src/App.tsx")], "App", opts(null));
    expect(top?.matches).toEqual([4, 5, 6]);
  });

  it("respects the limit", () => {
    expect(filterFiles(files, "", opts(null, 2))).toHaveLength(2);
  });

  describe("with a path query", () => {
    const across = [
      entry("alpha", "src/App.tsx"),
      entry("beta", "src/App.tsx"),
      {
        org: "home",
        repo: "r",
        path: "/home/me/r/src/App.tsx",
        relPath: "src/App.tsx",
      },
    ];

    it("matches the full path, so the typed org wins over the active one", () => {
      const got = filterFiles(
        across,
        "/root/beta/r/src/App.tsx",
        opts("/root/alpha/r"),
      );
      expect(got.map((s) => s.file.org)).toEqual(["beta"]);
    });

    it("expands a leading ~/ to the home directory, with or without its trailing slash", () => {
      expect(filterFiles(across, "~/r/src/App", opts(null))[0]?.file.org).toBe(
        "home",
      );
      expect(
        filterFiles(across, "~/r/src/App", {
          ...opts(null),
          home: "/home/me/",
        }).map((s) => s.file.org),
      ).toEqual(["home"]);
    });

    it("resolves . and .. segments and repeated slashes the way the server does", () => {
      for (const typed of [
        "/root/beta/../beta/r/src/App",
        "/root/beta/./r//src/App",
      ]) {
        expect(
          filterFiles(across, typed, opts(null)).map((s) => s.file.org),
        ).toEqual(["beta"]);
      }
    });

    it("highlights only the part of the match inside relPath", () => {
      const [top] = filterFiles(
        [entry("o", "src/App.tsx")],
        "/root/o/r/src/App",
        opts(null),
      );
      expect(top?.matches).toEqual([0, 1, 2, 3, 4, 5, 6]);
    });
  });
});

describe("fileListResponseSchema", () => {
  it("accepts a response without home (older servers)", () => {
    const ok = fileListResponseSchema.safeParse({
      truncated: false,
      files: [],
    });
    expect(ok.success).toBe(true);
  });

  it("accepts a well-formed response", () => {
    const ok = fileListResponseSchema.safeParse({
      truncated: false,
      home: "/home/me",
      files: [{ org: "o", repo: "r", path: "/a/b.ts", relPath: "b.ts" }],
    });
    expect(ok.success).toBe(true);
  });
});
