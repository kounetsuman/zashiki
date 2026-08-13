import { describe, expect, it } from "vitest";

import {
  type FsEntry,
  fileIconKind,
  fsListRequestSchema,
  fsListResponseSchema,
  joinRepoRelative,
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
