import type { RepoStatus, SkippedRepo } from "@zashiki/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import type { GitApi } from "../api/git.js";

export interface GitStatus {
  repos: RepoStatus[];
  /** Repos dropped by per-repo validation; surfaced as a non-fatal notice. */
  skipped: SkippedRepo[];
  error: string | null;
  /** true only during the initial fetch, so refetches do not flicker the loading UI. */
  loading: boolean;
  /** in-flight flag for the header icon, set on every refetch. */
  refreshing: boolean;
  refetch(): Promise<void>;
  setError(error: string | null): void;
}

/**
 * Fetches repo status and keeps it fresh on git.dirty. A generation guard drops a stale response that
 * returns late so it cannot roll back a newer fetch's display; one bad repo is surfaced as skipped
 * rather than blanking the panel.
 */
export function useGitStatus(
  api: GitApi,
  onGitDirty: (fn: () => void) => () => void,
): GitStatus {
  const [repos, setRepos] = useState<RepoStatus[]>([]);
  const [skipped, setSkipped] = useState<SkippedRepo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(true);
  const generation = useRef(0);

  const refetch = useCallback(async (): Promise<void> => {
    generation.current += 1;
    const gen = generation.current;
    setRefreshing(true);
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
        setRefreshing(false);
      }
    }
  }, [api]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  useEffect(() => onGitDirty(() => void refetch()), [onGitDirty, refetch]);

  return { repos, skipped, error, loading, refreshing, refetch, setError };
}
