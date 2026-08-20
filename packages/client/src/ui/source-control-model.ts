import type { RepoStatus } from "@zashiki/shared";

/** Color convention: A green / M yellow / D red / R cyan / ?? blue. */
const CODE_CLASS: Record<string, string> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  "??": "untracked",
};

export function codeClass(code: string): string {
  return `git-code git-code-${CODE_CLASS[code] ?? "other"}`;
}

/** Stable key for a file row: repo + staged/changed side + code + path. */
export function fileRowKey(
  repoPath: string,
  staged: boolean,
  code: string,
  filePath: string,
): string {
  return `${repoPath}:${staged ? "s" : "c"}:${code}:${filePath}`;
}

export interface OrgGroup {
  org: string;
  repos: RepoStatus[];
}

export function groupByOrg(repos: RepoStatus[]): OrgGroup[] {
  const groups: OrgGroup[] = [];
  const byOrg = new Map<string, OrgGroup>();
  for (const r of repos) {
    let g = byOrg.get(r.org);
    if (!g) {
      g = { org: r.org, repos: [] };
      byOrg.set(r.org, g);
      groups.push(g);
    }
    g.repos.push(r);
  }
  return groups;
}

/** An org whose root is itself a single repo is flattened, showing the repo row directly. */
export function isFlatOrg(g: OrgGroup): boolean {
  return g.repos.length === 1 && g.repos[0]?.repo === g.org;
}
