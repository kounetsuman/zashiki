import { useCallback, useEffect, useRef, useState } from "react";
import type { GitApi } from "../api/git.js";
import {
  type DiffBuffers,
  type DiffSide,
  diffFailed,
  diffKey,
  diffLoaded,
  diffToggleLayout,
  closeDiffBuffer as dropDiff,
  openDiffBuffer,
  sideStaged,
  sideUntracked,
} from "../diff/diff-model.js";
import i18n from "../i18n/index.js";

/** Interval for re-fetching the active diff so stage/edit/delete on the file converge in the tab. */
const DIFF_POLL_INTERVAL_MS = 2000;

/** Timeout for a diff fetch (always settles the Promise even if it hangs). */
const DIFF_FETCH_TIMEOUT_MS = 8000;

function fetchErrorMessage(e: unknown): string {
  if (e instanceof DOMException && e.name === "AbortError") {
    return i18n.t("diff.fetchTimeout");
  }
  return e instanceof Error ? e.message : String(e);
}

export interface Diff {
  buffers: DiffBuffers;
  /** Ensures a diff buffer for the file+side (firing a fetch only when new) and returns its key. */
  ensureDiff(repoPath: string, relPath: string, side: DiffSide): string;
  closeDiff(key: string): void;
  toggleLayout(key: string): void;
}

/**
 * Owns the diff buffers and their git IO. Mirrors useViewer: fetches always apply a timeout so the
 * Promise settles even if the fetch hangs, a per-key generation guard keeps a slow response from
 * overwriting newer content, and the active buffer is re-fetched on an interval so staging or editing
 * the file is reflected; identical versions keep the buffer reference so the merge view is not rebuilt.
 */
export function useDiff(gitApi: GitApi, activeDiffKey: string | null): Diff {
  const [buffers, setBuffers] = useState<DiffBuffers>({});
  const buffersRef = useRef(buffers);
  buffersRef.current = buffers;
  const fetchSeqRef = useRef<Record<string, number>>({});

  const loadDiff = useCallback(
    (
      key: string,
      repoPath: string,
      relPath: string,
      side: DiffSide,
      silent: boolean,
    ) => {
      const seq = (fetchSeqRef.current[key] ?? 0) + 1;
      fetchSeqRef.current[key] = seq;
      const ctrl = new AbortController();
      const timer = window.setTimeout(
        () => ctrl.abort(),
        DIFF_FETCH_TIMEOUT_MS,
      );
      return gitApi
        .diff(
          repoPath,
          relPath,
          sideStaged(side),
          sideUntracked(side),
          ctrl.signal,
        )
        .then(
          (payload) =>
            setBuffers((cur) =>
              fetchSeqRef.current[key] === seq
                ? diffLoaded(cur, key, payload)
                : cur,
            ),
          (e: unknown) =>
            setBuffers((cur) => {
              if (fetchSeqRef.current[key] !== seq) return cur;
              if (silent || cur[key]?.status === "ready") return cur;
              return diffFailed(cur, key, fetchErrorMessage(e));
            }),
        )
        .finally(() => window.clearTimeout(timer));
    },
    [gitApi],
  );

  const ensureDiff = useCallback(
    (repoPath: string, relPath: string, side: DiffSide): string => {
      const key = diffKey(repoPath, relPath, side);
      let shouldLoad = false;
      setBuffers((prev) => {
        if (prev[key] !== undefined) return prev;
        shouldLoad = true;
        return openDiffBuffer(prev, repoPath, relPath, side);
      });
      if (shouldLoad) void loadDiff(key, repoPath, relPath, side, false);
      return key;
    },
    [loadDiff],
  );

  const closeDiff = useCallback((key: string): void => {
    setBuffers((prev) => dropDiff(prev, key));
  }, []);

  const toggleLayout = useCallback((key: string): void => {
    setBuffers((prev) => diffToggleLayout(prev, key));
  }, []);

  useEffect(() => {
    if (activeDiffKey === null) return;
    const key = activeDiffKey;
    let inflight = false;
    const tick = (): void => {
      if (inflight) return;
      const buf = buffersRef.current[key];
      if (buf === undefined) return;
      inflight = true;
      void loadDiff(key, buf.repoPath, buf.relPath, buf.side, true).finally(
        () => {
          inflight = false;
        },
      );
    };
    const id = window.setInterval(tick, DIFF_POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [activeDiffKey, loadDiff]);

  return { buffers, ensureDiff, closeDiff, toggleLayout };
}
