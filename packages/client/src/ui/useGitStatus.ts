import {
  type RepoStatus,
  type SkippedRepo,
  stripTrailingSlashes,
} from "@zashiki/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import type { GitApi } from "../api/git.js";

export interface GitStatus {
  repos: RepoStatus[];
  /** Repos dropped by per-repo validation; surfaced as a non-fatal notice. */
  skipped: SkippedRepo[];
  error: string | null;
  /** true only during the initial fetch, so refetches do not flicker the loading UI. */
  loading: boolean;
  refetch(): Promise<void>;
  setError(error: string | null): void;
}

/**
 * Fetches repo status and keeps it fresh on git.dirty. A generation guard drops a stale response that
 * returns late so it cannot roll back a newer fetch's display; one bad repo is surfaced as skipped
 * rather than blanking the view.
 *
 * `active` is whether the source-control panel is shown: status is fetched only when it is active
 * (and refreshed the moment it becomes active), so background tool hooks do not scan git while it is
 * hidden. A git.dirty carrying the originating repo refetches just that repo; without one, the whole
 * set is refetched.
 */
export function useGitStatus(
  api: GitApi,
  onGitDirty: (fn: (cwd?: string) => void) => () => void,
  active: boolean,
): GitStatus {
  const [repos, setRepos] = useState<RepoStatus[]>([]);
  const [skipped, setSkipped] = useState<SkippedRepo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);

  const refetch = useCallback(async (): Promise<void> => {
    generation.current += 1;
    const gen = generation.current;
    try {
      const res = await api.status();
      if (gen !== generation.current) return;
      setRepos(res.repos);
      setSkipped(res.skipped ?? []);
      setError(null);
    } catch (err) {
      if (gen === generation.current) setError(String(err));
    } finally {
      if (gen === generation.current) {
        setLoading(false);
      }
    }
  }, [api]);

  const refetchRepo = useCallback(
    async (repoPath: string): Promise<void> => {
      // Shares the generation counter with refetch so a late scoped response can't roll back a newer
      // fetch (full or scoped): only the most recently issued request is applied.
      generation.current += 1;
      const gen = generation.current;
      try {
        const res = await api.status(repoPath);
        if (gen !== generation.current) return;
        const fresh = res.repos.find((r) => r.path === repoPath);
        if (fresh) {
          setRepos((prev) => upsertRepo(prev, fresh));
          setSkipped((prev) => prev.filter((s) => s.path !== repoPath));
          return;
        }
        const skip = (res.skipped ?? []).find((s) => s.path === repoPath);
        if (skip) {
          setRepos((prev) => prev.filter((r) => r.path !== repoPath));
          setSkipped((prev) => [
            ...prev.filter((s) => s.path !== repoPath),
            skip,
          ]);
        }
        // Neither present means the repo left the scan (removed, or a path form the server can't
        // match); the prior entry is kept and a full refetch reconciles removals.
      } catch {
        // Keep the prior status; the next git.dirty or a panel reopen refreshes it.
      }
    },
    [api],
  );

  const reposRef = useRef(repos);
  reposRef.current = repos;
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    if (active) void refetch();
  }, [active, refetch]);

  useEffect(
    () =>
      onGitDirty((cwd) => {
        if (!activeRef.current) return;
        if (cwd === undefined) {
          void refetch();
          return;
        }
        const repoPath = repoPathForCwd(reposRef.current, cwd);
        if (repoPath) void refetchRepo(repoPath);
      }),
    [onGitDirty, refetch, refetchRepo],
  );

  return { repos, skipped, error, loading, refetch, setError };
}

/** Replaces `fresh`'s entry in place, or appends it when the repo is new to the list. */
function upsertRepo(prev: RepoStatus[], fresh: RepoStatus): RepoStatus[] {
  const idx = prev.findIndex((r) => r.path === fresh.path);
  if (idx === -1) return [...prev, fresh];
  const next = prev.slice();
  next[idx] = fresh;
  return next;
}

/**
 * The registered repo whose worktree contains `cwd` (longest path match), or null if none. Trailing
 * slashes are stripped on both sides to match the same way `orgOfCwd` maps a cwd to its root.
 */
function repoPathForCwd(repos: RepoStatus[], cwd: string): string | null {
  const target = stripTrailingSlashes(cwd);
  let best: string | null = null;
  let bestLen = -1;
  for (const r of repos) {
    const root = stripTrailingSlashes(r.path);
    const contains = target === root || target.startsWith(`${root}/`);
    if (contains && root.length > bestLen) {
      best = r.path;
      bestLen = root.length;
    }
  }
  return best;
}
