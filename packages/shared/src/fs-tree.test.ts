import { describe, expect, it } from "vitest";

import {
  type FsEntry,
  type FsRepo,
  fileIconKind,
  fsListRequestSchema,
  fsListResponseSchema,
  fsRenameRequestSchema,
  groupReposByRepository,
  isSinglePathSegment,
  joinRepoRelative,
  parentRelDir,
  sortFsEntries,
} from "./fs-tree.js";

describe("sortFsEntries (explorer display order)", () => {
  it("empty input yields an empty array", () => {
    expect(sortFsEntries([])).toEqual([]);
  });

  it("orders directories first and files after", () => {
    const input: FsEntry[] = [
      { name: "readme.md", kind: "file" },
      { name: "src", kind: "dir" },
      { name: "package.json", kind: "file" },
      { name: "docs", kind: "dir" },
    ];
    expect(sortFsEntries(input).map((e) => e.name)).toEqual([
      "docs",
      "src",
      "package.json",
      "readme.md",
    ]);
  });

  it("within the same kind, orders case-insensitively and numerically", () => {
    const input: FsEntry[] = [
      { name: "b.ts", kind: "file" },
      { name: "A.ts", kind: "file" },
      { name: "item10.ts", kind: "file" },
      { name: "item2.ts", kind: "file" },
    ];
    expect(sortFsEntries(input).map((e) => e.name)).toEqual([
      "A.ts",
      "b.ts",
      "item2.ts",
      "item10.ts",
    ]);
  });

  it("sorts dotfiles in the same group as regular files (does not exclude them)", () => {
    const input: FsEntry[] = [
      { name: "src", kind: "dir" },
      { name: ".gitignore", kind: "file" },
      { name: ".github", kind: "dir" },
    ];
    expect(sortFsEntries(input).map((e) => e.name)).toEqual([
      ".github",
      "src",
      ".gitignore",
    ]);
  });

  it("does not mutate the input array", () => {
    const input: FsEntry[] = [
      { name: "b", kind: "file" },
      { name: "a", kind: "dir" },
    ];
    const copy = [...input];
    sortFsEntries(input);
    expect(input).toEqual(copy);
  });
});

describe("joinRepoRelative", () => {
  it("returns just the name at the repo root (dir='')", () => {
    expect(joinRepoRelative("", "src")).toBe("src");
  });
  it("joins nested paths with /", () => {
    expect(joinRepoRelative("src", "app.ts")).toBe("src/app.ts");
    expect(joinRepoRelative("src/ui", "App.tsx")).toBe("src/ui/App.tsx");
  });
  it("drops extra leading/trailing slashes", () => {
    expect(joinRepoRelative("/src/", "app.ts")).toBe("src/app.ts");
  });
});

describe("fileIconKind (extension/name -> icon kind)", () => {
  it("classifies by extension", () => {
    expect(fileIconKind("app.ts")).toBe("ts");
    expect(fileIconKind("main.tsx")).toBe("ts");
    expect(fileIconKind("styles.css")).toBe("css");
    expect(fileIconKind("lib.rs")).toBe("rust");
    expect(fileIconKind("logo.PNG")).toBe("image");
  });
  it("classifies special filenames by name (taking precedence over extension)", () => {
    expect(fileIconKind("package.json")).toBe("npm");
    expect(fileIconKind("tsconfig.json")).toBe("ts");
    expect(fileIconKind(".gitignore")).toBe("git");
    expect(fileIconKind("Dockerfile")).toBe("docker");
    expect(fileIconKind("README.md")).toBe("readme");
  });
  it("no extension or unknown extension is file", () => {
    expect(fileIconKind("LICENSE")).toBe("file");
    expect(fileIconKind("data.xyz")).toBe("file");
  });
});

describe("groupReposByRepository", () => {
  const repo = (
    over: Partial<FsRepo> & Pick<FsRepo, "repo" | "path">,
  ): FsRepo => ({
    org: "kounetsuman",
    ...over,
  });

  it("collects worktrees under the main working tree they share (via mainPath)", () => {
    const main = repo({ repo: "zashiki", path: "/ws/kounetsuman/zashiki" });
    const wtA = repo({
      repo: "zashiki-163-notes",
      path: "/ws/kounetsuman/zashiki-163-notes",
      isWorktree: true,
      mainPath: "/ws/kounetsuman/zashiki",
    });
    const wtB = repo({
      repo: "zashiki-release-0.9.0",
      path: "/ws/kounetsuman/zashiki-release-0.9.0",
      isWorktree: true,
      mainPath: "/ws/kounetsuman/zashiki",
    });
    const groups = groupReposByRepository([wtB, main, wtA]);
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.key).toBe("/ws/kounetsuman/zashiki");
    expect(g.label).toBe("zashiki");
    expect(g.org).toBe("kounetsuman");
    expect(g.repos.map((r) => r.repo)).toEqual([
      "zashiki",
      "zashiki-163-notes",
      "zashiki-release-0.9.0",
    ]);
  });

  it("keeps a repo with no worktrees as its own single-member group", () => {
    const a = repo({ repo: "alpha", path: "/ws/kounetsuman/alpha" });
    const b = repo({ repo: "beta", path: "/ws/kounetsuman/beta" });
    const groups = groupReposByRepository([b, a]);
    expect(groups.map((g) => g.label)).toEqual(["alpha", "beta"]);
    expect(groups.every((g) => g.repos.length === 1)).toBe(true);
  });

  it("groups worktrees even when their main working tree is not in the set", () => {
    const wt = repo({
      repo: "zashiki-163-notes",
      path: "/ws/kounetsuman/zashiki-163-notes",
      isWorktree: true,
      mainPath: "/elsewhere/zashiki",
    });
    const groups = groupReposByRepository([wt]);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("/elsewhere/zashiki");
    expect(groups[0].label).toBe("zashiki");
    expect(groups[0].repos).toEqual([wt]);
  });

  it("falls back to grouping on the repo's own path when mainPath is absent (version skew)", () => {
    const a = repo({ repo: "zashiki", path: "/ws/kounetsuman/zashiki" });
    const b = repo({
      repo: "zashiki-163-notes",
      path: "/ws/kounetsuman/zashiki-163-notes",
    });
    const groups = groupReposByRepository([a, b]);
    expect(groups.map((g) => g.repos.length)).toEqual([1, 1]);
  });
});

describe("fs-tree zod schema", () => {
  it("request: repoPath required / dir allows empty string", () => {
    expect(
      fsListRequestSchema.safeParse({ repoPath: "/x", dir: "" }).success,
    ).toBe(true);
    expect(
      fsListRequestSchema.safeParse({ repoPath: "", dir: "" }).success,
    ).toBe(false);
  });
  it("response: entries and truncated", () => {
    const ok = fsListResponseSchema.safeParse({
      entries: [{ name: "a", kind: "dir" }],
      truncated: false,
    });
    expect(ok.success).toBe(true);
    const bad = fsListResponseSchema.safeParse({
      entries: [{ name: "a", kind: "socket" }],
      truncated: false,
    });
    expect(bad.success).toBe(false);
  });
});

describe("isSinglePathSegment", () => {
  it("accepts a plain name", () => {
    expect(isSinglePathSegment("readme.md")).toBe(true);
    expect(isSinglePathSegment("a file with spaces.txt")).toBe(true);
    expect(isSinglePathSegment(".gitignore")).toBe(true);
  });

  it("rejects empty, dot, and dot-dot", () => {
    expect(isSinglePathSegment("")).toBe(false);
    expect(isSinglePathSegment(".")).toBe(false);
    expect(isSinglePathSegment("..")).toBe(false);
  });

  it("rejects path separators and control characters", () => {
    expect(isSinglePathSegment("a/b")).toBe(false);
    expect(isSinglePathSegment("a\\b")).toBe(false);
    expect(isSinglePathSegment("../escape")).toBe(false);
    expect(isSinglePathSegment("with\nnewline")).toBe(false);
  });
});

describe("parentRelDir", () => {
  it("drops the last segment", () => {
    expect(parentRelDir("a/b/c")).toBe("a/b");
    expect(parentRelDir("a/b")).toBe("a");
  });
  it("returns root for a top-level entry", () => {
    expect(parentRelDir("a")).toBe("");
  });
  it("ignores a trailing slash", () => {
    expect(parentRelDir("a/b/")).toBe("a");
  });
});

describe("fsRenameRequestSchema", () => {
  it("rejects a newName that is not a single segment", () => {
    expect(
      fsRenameRequestSchema.safeParse({
        repoPath: "/repo",
        path: "a/b.txt",
        newName: "../c.txt",
      }).success,
    ).toBe(false);
  });
  it("accepts a valid rename request", () => {
    expect(
      fsRenameRequestSchema.safeParse({
        repoPath: "/repo",
        path: "a/b.txt",
        newName: "c.txt",
      }).success,
    ).toBe(true);
  });
});
