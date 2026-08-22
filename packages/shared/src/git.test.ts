import { describe, expect, it } from "vitest";

import {
  isSafeRepoRelativePath,
  isValidCommitMessage,
  parseGitStatus,
  parseGitStatusResponse,
  type RepoStatus,
} from "./git.js";

describe("parseGitStatus (porcelain v1 -> staged/changed classification)", () => {
  it("empty input yields an empty result", () => {
    expect(parseGitStatus("")).toEqual({ staged: [], changed: [] });
    expect(parseGitStatus("\n\n")).toEqual({ staged: [], changed: [] });
  });

  const cases: {
    name: string;
    input: string;
    staged: { code: string; path: string }[];
    changed: { code: string; path: string }[];
  }[] = [
    {
      name: "staged only (A)",
      input: "A  new.ts\n",
      staged: [{ code: "A", path: "new.ts" }],
      changed: [],
    },
    {
      name: "changed only (M)",
      input: " M lib/app.ts\n",
      staged: [],
      changed: [{ code: "M", path: "lib/app.ts" }],
    },
    {
      name: "both sides non-empty (MM) appears in both staged and changed",
      input: "MM both.ts\n",
      staged: [{ code: "M", path: "both.ts" }],
      changed: [{ code: "M", path: "both.ts" }],
    },
    {
      name: "untracked (??) appears as one entry on the changed side",
      input: "?? mem.md\n",
      staged: [],
      changed: [{ code: "??", path: "mem.md" }],
    },
    {
      name: "untracked directory (trailing slash)",
      input: "?? newdir/\n",
      staged: [],
      changed: [{ code: "??", path: "newdir/" }],
    },
    {
      name: "rename (R old -> new) takes the new path",
      input: "R  old.ts -> new.ts\n",
      staged: [{ code: "R", path: "new.ts" }],
      changed: [],
    },
    {
      name: "rename + worktree change (RM)",
      input: "RM src/a.ts -> src/b.ts\n",
      staged: [{ code: "R", path: "src/b.ts" }],
      changed: [{ code: "M", path: "src/b.ts" }],
    },
    {
      name: "deletion (D staged / D changed)",
      input: "D  gone.ts\n D also.ts\n",
      staged: [{ code: "D", path: "gone.ts" }],
      changed: [{ code: "D", path: "also.ts" }],
    },
    {
      name: "submodule (treated the same as a regular path)",
      input: " M vendor/submodule\n",
      staged: [],
      changed: [{ code: "M", path: "vendor/submodule" }],
    },
    {
      name: "conflict (UU) appears on both sides",
      input: "UU conflict.ts\n",
      staged: [{ code: "U", path: "conflict.ts" }],
      changed: [{ code: "U", path: "conflict.ts" }],
    },
    {
      name: "path containing a space (unquoted when core.quotepath=false)",
      input: " M my file.txt\n",
      staged: [],
      changed: [{ code: "M", path: "my file.txt" }],
    },
    {
      name: "Japanese path (raw UTF-8 when core.quotepath=false)",
      input: "?? メモ/日誌.md\n",
      staged: [],
      changed: [{ code: "??", path: "メモ/日誌.md" }],
    },
    {
      name: "quoted path (containing double quotes) is C-unquoted",
      input: '?? "we \\"quoted\\".txt"\n',
      staged: [],
      changed: [{ code: "??", path: 'we "quoted".txt' }],
    },
    {
      name: "quoted path (newline/tab escapes)",
      input: '?? "line\\nbreak\\tta.txt"\n',
      staged: [],
      changed: [{ code: "??", path: "line\nbreak\tta.txt" }],
    },
    {
      name: "quoted path (octal escapes are restored as UTF-8)",
      input: '?? "\\343\\203\\241\\343\\203\\242.md"\n',
      staged: [],
      changed: [{ code: "??", path: "メモ.md" }],
    },
    {
      name: "quoted rename (both sides quoted) takes the new path",
      input: 'R  "old name.ts" -> "new name.ts"\n',
      staged: [{ code: "R", path: "new name.ts" }],
      changed: [],
    },
    {
      name: "does not mis-split when a quoted old path contains ' -> '",
      input: 'R  "a -> b.ts" -> plain.ts\n',
      staged: [{ code: "R", path: "plain.ts" }],
      changed: [],
    },
    {
      name: "mixed multiple lines",
      input: "A  a.ts\n M b.ts\n?? c.ts\nD  d.ts\n",
      staged: [
        { code: "A", path: "a.ts" },
        { code: "D", path: "d.ts" },
      ],
      changed: [
        { code: "M", path: "b.ts" },
        { code: "??", path: "c.ts" },
      ],
    },
    {
      name: "ignores broken short lines",
      input: "M\n\nA  ok.ts\n",
      staged: [{ code: "A", path: "ok.ts" }],
      changed: [],
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(parseGitStatus(c.input)).toEqual({
        staged: c.staged,
        changed: c.changed,
      });
    });
  }
});

describe("isSafeRepoRelativePath (pure function guarding against path traversal)", () => {
  const ok = [
    "a.ts",
    "dir/sub/a.ts",
    "newdir/",
    "日本語/ファイル.md",
    "-starts-with-dash.txt",
    "has space.txt",
    'we "quoted".txt',
    "line\nbreak.txt",
  ];
  const ng = [
    "",
    "/abs/path.ts",
    "../escape.ts",
    "dir/../../escape.ts",
    "dir/..",
    "..",
    ".",
    "./a.ts",
    "dir//double.ts",
    "nul\0byte.ts",
    "C:\\windows\\path",
  ];
  for (const p of ok) {
    it(`allow: ${JSON.stringify(p)}`, () => {
      expect(isSafeRepoRelativePath(p)).toBe(true);
    });
  }
  for (const p of ng) {
    it(`reject: ${JSON.stringify(p)}`, () => {
      expect(isSafeRepoRelativePath(p)).toBe(false);
    });
  }
});

describe("isValidCommitMessage (rejects empty commit messages)", () => {
  it("a non-empty message is valid", () => {
    expect(isValidCommitMessage("fix: bug")).toBe(true);
    expect(isValidCommitMessage("日本語のコミット")).toBe(true);
    expect(isValidCommitMessage("  前後空白あり  ")).toBe(true);
  });
  it("empty or whitespace-only is invalid", () => {
    expect(isValidCommitMessage("")).toBe(false);
    expect(isValidCommitMessage("   ")).toBe(false);
    expect(isValidCommitMessage("\n\t ")).toBe(false);
  });
});

describe("parseGitStatusResponse (per-repo fault isolation)", () => {
  const good = (over: Partial<RepoStatus> = {}): RepoStatus => ({
    org: "org1",
    repo: "repo-a",
    path: "/ws/org1/repo-a",
    branch: "main",
    staged: [],
    changed: [],
    ...over,
  });

  it("keeps every repo and reports no skips when all are valid", () => {
    const result = parseGitStatusResponse({
      repos: [good({ repo: "a" }), good({ repo: "b" })],
    });
    expect(result.repos.map((r) => r.repo)).toEqual(["a", "b"]);
    expect(result.skipped).toEqual([]);
  });

  it("drops only the malformed repo (empty branch) and keeps the rest", () => {
    const result = parseGitStatusResponse({
      repos: [
        good({ repo: "a" }),
        { ...good({ repo: "bad", path: "/ws/org1/bad" }), branch: "" },
        good({ repo: "c" }),
      ],
    });
    expect(result.repos.map((r) => r.repo)).toEqual(["a", "c"]);
    expect(result.skipped).toEqual([
      { index: 1, repo: "bad", path: "/ws/org1/bad" },
    ]);
  });

  it("still identifies a skipped repo by any string repo/path it happens to carry", () => {
    const result = parseGitStatusResponse({
      repos: [{ repo: "half", path: "/ws/half" }],
    });
    expect(result.repos).toEqual([]);
    expect(result.skipped).toEqual([
      { index: 0, repo: "half", path: "/ws/half" },
    ]);
  });

  it("records the index even when the skipped entry carries no usable identity", () => {
    const result = parseGitStatusResponse({ repos: [42] });
    expect(result.repos).toEqual([]);
    expect(result.skipped).toEqual([{ index: 0 }]);
  });

  it("throws only when the envelope itself is not { repos: [...] }", () => {
    expect(() => parseGitStatusResponse({})).toThrow();
    expect(() => parseGitStatusResponse({ repos: "nope" })).toThrow();
    expect(() => parseGitStatusResponse(null)).toThrow();
  });

  it("keeps a repo whose optional isWorktree/lastCommit are absent (no whole-repo drop on skew)", () => {
    const result = parseGitStatusResponse({ repos: [good({ repo: "a" })] });
    expect(result.repos.map((r) => r.repo)).toEqual(["a"]);
    expect(result.skipped).toEqual([]);
  });

  it("carries isWorktree and lastCommit through when present", () => {
    const result = parseGitStatusResponse({
      repos: [
        good({
          repo: "wt",
          isWorktree: true,
          lastCommit: "2026-08-22T16:21:44+09:00",
        }),
      ],
    });
    expect(result.repos[0]?.isWorktree).toBe(true);
    expect(result.repos[0]?.lastCommit).toBe("2026-08-22T16:21:44+09:00");
  });
});
