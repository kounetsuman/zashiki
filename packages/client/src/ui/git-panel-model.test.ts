import type { RepoStatus } from "@zashiki/shared";
import { describe, expect, it } from "vitest";
import {
  codeClass,
  fileRowKey,
  groupByOrg,
  isFlatOrg,
} from "./git-panel-model.js";

function repo(org: string, name: string): RepoStatus {
  return {
    org,
    repo: name,
    path: `/w/${org}/${name}`,
    branch: "main",
    staged: [],
    changed: [],
  } as RepoStatus;
}

describe("codeClass", () => {
  it("maps known status codes to their color class", () => {
    expect(codeClass("A")).toBe("git-code git-code-added");
    expect(codeClass("M")).toBe("git-code git-code-modified");
    expect(codeClass("D")).toBe("git-code git-code-deleted");
    expect(codeClass("R")).toBe("git-code git-code-renamed");
    expect(codeClass("??")).toBe("git-code git-code-untracked");
  });

  it("falls back to other for an unknown code", () => {
    expect(codeClass("X")).toBe("git-code git-code-other");
  });
});

describe("fileRowKey", () => {
  it("encodes side, code, and path uniquely", () => {
    expect(fileRowKey("/w/a/r", true, "M", "src/x.ts")).toBe(
      "/w/a/r:s:M:src/x.ts",
    );
    expect(fileRowKey("/w/a/r", false, "M", "src/x.ts")).toBe(
      "/w/a/r:c:M:src/x.ts",
    );
  });
});

describe("groupByOrg", () => {
  it("groups repos by org, preserving first-seen org order", () => {
    const groups = groupByOrg([
      repo("z", "r1"),
      repo("a", "r2"),
      repo("z", "r3"),
    ]);
    expect(groups.map((g) => g.org)).toEqual(["z", "a"]);
    expect(groups[0]?.repos.map((r) => r.repo)).toEqual(["r1", "r3"]);
    expect(groups[1]?.repos.map((r) => r.repo)).toEqual(["r2"]);
  });
});

describe("isFlatOrg", () => {
  it("is flat when the org's only repo is named after the org", () => {
    expect(isFlatOrg({ org: "a", repos: [repo("a", "a")] })).toBe(true);
  });

  it("is not flat with multiple repos", () => {
    expect(
      isFlatOrg({ org: "a", repos: [repo("a", "a"), repo("a", "b")] }),
    ).toBe(false);
  });

  it("is not flat when the single repo differs from the org name", () => {
    expect(isFlatOrg({ org: "a", repos: [repo("a", "b")] })).toBe(false);
  });
});
