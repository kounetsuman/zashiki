import {
  type FsEntry,
  type FsRepo,
  fileIconKind,
  joinRepoRelative,
  resolveOrgColor,
} from "@zashiki/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { FsApi } from "../api/fs.js";
import { PanelHeader } from "./PanelHeader.js";
import { panelClass } from "./panels.js";

/**
 * Key for the expanded set and cache (repoPath and the repo-relative dir joined
 * with NUL). NUL cannot appear in a path, so keys never collide even for paths
 * containing spaces.
 */
function dirKey(repoPath: string, dir: string): string {
  return `${repoPath}\0${dir}`;
}

interface DirData {
  entries: FsEntry[];
  truncated: boolean;
}

export interface ExplorerPanelProps {
  api: FsApi;
  /** org -> display color (explicit color from repos.conf). Unspecified orgs get an auto color. */
  orgColors?: Record<string, string>;
  /**
   * Hook point for file clicks (the editor's connection target).
   * While this is unfinished, selection only is supported and a no-op is passed.
   */
  onOpenFile?(repoPath: string, file: string): void;
  /** Apply a faint overlay when inactive. */
  inactive?: boolean;
}

export function ExplorerPanel({
  api,
  orgColors = {},
  onOpenFile,
  inactive,
}: ExplorerPanelProps) {
  const { t } = useTranslation();
  const [repos, setRepos] = useState<FsRepo[]>([]);
  const [rootError, setRootError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [dirs, setDirs] = useState<ReadonlyMap<string, DirData>>(new Map());
  const [dirErrors, setDirErrors] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  const [selected, setSelected] = useState<string | null>(null);
  // Per-directory generation (discard stale responses from a close-then-reopen).
  const generations = useRef(new Map<string, number>());

  const loadRepos = useCallback(async (): Promise<void> => {
    try {
      const res = await api.repos();
      setRepos(res.repos);
      setRootError(null);
    } catch (err) {
      setRootError(String(err));
    }
  }, [api]);

  useEffect(() => {
    void loadRepos();
  }, [loadRepos]);

  const loadDir = useCallback(
    async (repoPath: string, dir: string): Promise<void> => {
      const key = dirKey(repoPath, dir);
      const gen = (generations.current.get(key) ?? 0) + 1;
      generations.current.set(key, gen);
      try {
        const res = await api.list(repoPath, dir);
        if (generations.current.get(key) !== gen) return;
        setDirs((prev) => {
          const next = new Map(prev);
          next.set(key, { entries: res.entries, truncated: res.truncated });
          return next;
        });
        setDirErrors((prev) => {
          if (!prev.has(key)) return prev;
          const next = new Map(prev);
          next.delete(key);
          return next;
        });
      } catch (err) {
        if (generations.current.get(key) !== gen) return;
        setDirErrors((prev) => {
          const next = new Map(prev);
          next.set(key, String(err));
          return next;
        });
      }
    },
    [api],
  );

  const toggleDir = (repoPath: string, dir: string): void => {
    const key = dirKey(repoPath, dir);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
        // Refetch on every open for entries that were not yet fetched or errored (doubles as refresh).
        void loadDir(repoPath, dir);
      }
      return next;
    });
  };

  const clickFile = (repoPath: string, file: string): void => {
    setSelected(dirKey(repoPath, file));
    onOpenFile?.(repoPath, file);
  };

  const renderEntries = (repoPath: string, dir: string, depth: number) => {
    const key = dirKey(repoPath, dir);
    const data = dirs.get(key);
    const err = dirErrors.get(key);
    if (err !== undefined) {
      return <div className="explorer-error">{err}</div>;
    }
    if (!data) return null;
    return (
      <>
        {data.entries.map((e) => {
          const childDir = joinRepoRelative(dir, e.name);
          const childKey = dirKey(repoPath, childDir);
          if (e.kind === "dir") {
            const exp = expanded.has(childKey);
            return (
              <div key={childKey}>
                <button
                  type="button"
                  className="panel-row panel-row-hover explorer-row explorer-dir"
                  style={{ paddingLeft: `${depth * 12 + 8}px` }}
                  onClick={() => toggleDir(repoPath, childDir)}
                >
                  <span
                    className="panel-arrow material-symbols-outlined"
                    aria-hidden="true"
                  >
                    {exp ? "expand_more" : "chevron_right"}
                  </span>{" "}
                  <span className="explorer-name">{e.name}</span>
                </button>
                {exp && renderEntries(repoPath, childDir, depth + 1)}
              </div>
            );
          }
          return (
            <button
              key={childKey}
              type="button"
              className={
                selected === childKey
                  ? "panel-row panel-row-hover panel-row-selected explorer-row explorer-file"
                  : "panel-row panel-row-hover explorer-row explorer-file"
              }
              style={{ paddingLeft: `${depth * 12 + 20}px` }}
              title={childDir}
              data-icon={fileIconKind(e.name)}
              onClick={() => clickFile(repoPath, childDir)}
            >
              <span className="explorer-name">{e.name}</span>
            </button>
          );
        })}
        {data.truncated && (
          <div
            className="explorer-truncated"
            style={{ paddingLeft: `${depth * 12 + 20}px` }}
          >
            {t("explorer.truncated")}
          </div>
        )}
      </>
    );
  };

  return (
    <section
      className={panelClass("explorer-panel", inactive)}
      data-panel="explorer"
    >
      <PanelHeader title="EXPLORER">
        <button
          type="button"
          aria-label="refresh"
          title={t("common.refresh")}
          onClick={() => void loadRepos()}
        >
          <span className="material-symbols-outlined" aria-hidden="true">
            refresh
          </span>
        </button>
      </PanelHeader>
      {rootError !== null && <div className="explorer-error">{rootError}</div>}
      <div className="panel-tree">
        {repos.map((r) => {
          const rootDir = "";
          const key = dirKey(r.path, rootDir);
          const exp = expanded.has(key);
          return (
            <div key={r.path} className="explorer-repo">
              <button
                type="button"
                className="panel-row panel-row-hover explorer-row explorer-repo-row"
                onClick={() => toggleDir(r.path, rootDir)}
              >
                <span
                  className="panel-arrow material-symbols-outlined"
                  aria-hidden="true"
                >
                  {exp ? "expand_more" : "chevron_right"}
                </span>{" "}
                <span className="explorer-repo-name">{r.repo}</span>{" "}
                <span
                  className="org-dot"
                  role="img"
                  style={{ backgroundColor: resolveOrgColor(r.org, orgColors) }}
                  title={r.org}
                  aria-label={`org: ${r.org}`}
                />
              </button>
              {exp && renderEntries(r.path, rootDir, 1)}
            </div>
          );
        })}
      </div>
    </section>
  );
}
