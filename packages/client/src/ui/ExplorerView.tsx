import {
  type FsEntry,
  type FsEntryKind,
  type FsRepo,
  fileIconKind,
  groupReposByRepository,
  isSinglePathSegment,
  joinRepoRelative,
  parentRelDir,
  resolveOrgColor,
  resolveOrgName,
} from "@zashiki/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { FsApi } from "../api/fs.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { ExplorerContextMenu } from "./ExplorerContextMenu.js";
import {
  type ExplorerMenuTarget,
  useExplorerContextMenu,
} from "./useExplorerContextMenu.js";
import { ViewHeader } from "./ViewHeader.js";

/** Material Symbol glyph per `fileIconKind` result; color is applied in CSS via `data-icon`. */
const FILE_ICON_GLYPH: Record<string, string> = {
  ts: "code",
  js: "javascript",
  json: "data_object",
  md: "description",
  readme: "article",
  css: "css",
  html: "html",
  rust: "code",
  toml: "settings",
  yaml: "settings",
  shell: "terminal",
  git: "commit",
  docker: "deployed_code",
  npm: "deployed_code",
  image: "image",
  file: "draft",
};

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

export interface ExplorerViewProps {
  api: FsApi;
  /** org -> display color (explicit color from repos.conf). Unspecified orgs get an auto color. */
  orgColors?: Record<string, string>;
  /** org -> display alias (from repos.conf). Unspecified orgs are shown by their identity. */
  orgAliases?: Record<string, string>;
  /**
   * Hook point for file clicks (the viewer's connection target).
   * While this is unfinished, selection only is supported and a no-op is passed.
   */
  onOpenFile?(repoPath: string, file: string): void;
  /** Copy text to the clipboard and flash a toast (path copies from the context menu). */
  onCopyText?(text: string): void;
  /** Surface a filesystem-operation failure (reveal/rename/delete) to the user. */
  onFsError?(message: string): void;
  /** An entry was renamed; lets the app retarget any open viewer tab/buffer. */
  onPathRenamed?(
    repoPath: string,
    oldRel: string,
    newRel: string,
    kind: FsEntryKind,
  ): void;
  /** An entry was moved to the trash; lets the app close any open viewer tab/buffer. */
  onPathDeleted?(repoPath: string, rel: string, kind: FsEntryKind): void;
}

export function ExplorerView({
  api,
  orgColors = {},
  orgAliases = {},
  onOpenFile,
  onCopyText,
  onFsError,
  onPathRenamed,
  onPathDeleted,
}: ExplorerViewProps) {
  const { t } = useTranslation();
  const contextMenu = useExplorerContextMenu();
  const [renaming, setRenaming] = useState<ExplorerMenuTarget | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  // Guards the unmount blur from re-committing (or double-firing) after Enter/Escape.
  const renameDoneRef = useRef(false);
  const [deleteTarget, setDeleteTarget] = useState<ExplorerMenuTarget | null>(
    null,
  );
  const [repos, setRepos] = useState<FsRepo[]>([]);
  const [rootError, setRootError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [dirs, setDirs] = useState<ReadonlyMap<string, DirData>>(new Map());
  const [dirErrors, setDirErrors] = useState<ReadonlyMap<string, string>>(
    new Map(),
  );
  const [selected, setSelected] = useState<string | null>(null);
  // Repository groups start expanded; only explicit collapses are tracked (by group key).
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(
    new Set(),
  );
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

  const toggleGroup = (groupKey: string): void => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  };

  const clickFile = (repoPath: string, file: string): void => {
    setSelected(dirKey(repoPath, file));
    onOpenFile?.(repoPath, file);
  };

  const reveal = (target: ExplorerMenuTarget): void => {
    void api
      .reveal(target.repoPath, target.relPath)
      .catch((err: unknown) => onFsError?.(String(err)));
  };

  const copyPath = (target: ExplorerMenuTarget): void => {
    onCopyText?.(`${target.repoPath}/${target.relPath}`);
  };

  const copyRelativePath = (target: ExplorerMenuTarget): void => {
    onCopyText?.(target.relPath);
  };

  const startRename = (target: ExplorerMenuTarget): void => {
    renameDoneRef.current = false;
    setRenaming(target);
    setRenameDraft(target.name);
  };

  const cancelRename = (): void => {
    renameDoneRef.current = true;
    setRenaming(null);
  };

  const commitRename = useCallback(async (): Promise<void> => {
    const target = renaming;
    if (renameDoneRef.current || target === null) return;
    renameDoneRef.current = true;
    setRenaming(null);
    const next = renameDraft.trim();
    if (next === "" || next === target.name || !isSinglePathSegment(next)) {
      return;
    }
    try {
      const newRel = await api.rename(target.repoPath, target.relPath, next);
      await loadDir(target.repoPath, parentRelDir(target.relPath));
      setSelected((cur) =>
        cur === dirKey(target.repoPath, target.relPath)
          ? dirKey(target.repoPath, newRel)
          : cur,
      );
      onPathRenamed?.(target.repoPath, target.relPath, newRel, target.kind);
    } catch (err) {
      onFsError?.(String(err));
    }
  }, [renaming, renameDraft, api, loadDir, onPathRenamed, onFsError]);

  const confirmDelete = useCallback(async (): Promise<void> => {
    const target = deleteTarget;
    if (target === null) return;
    setDeleteTarget(null);
    try {
      await api.delete(target.repoPath, target.relPath);
      await loadDir(target.repoPath, parentRelDir(target.relPath));
      onPathDeleted?.(target.repoPath, target.relPath, target.kind);
    } catch (err) {
      onFsError?.(String(err));
    }
  }, [deleteTarget, api, loadDir, onPathDeleted, onFsError]);

  const renameInputFor = (depth: number) => (
    <div
      className="view-row explorer-row explorer-rename-row"
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
    >
      <span className="explorer-arrow-spacer" aria-hidden="true" />
      <input
        // biome-ignore lint/a11y/noAutofocus: the rename input opens on an explicit menu action and should take focus
        autoFocus
        className="explorer-rename-input"
        aria-label={t("explorer.rename")}
        maxLength={255}
        value={renameDraft}
        onChange={(e) => setRenameDraft(e.target.value)}
        onBlur={() => void commitRename()}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void commitRename();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancelRename();
          }
        }}
      />
    </div>
  );

  const isRenaming = (repoPath: string, rel: string): boolean =>
    renaming !== null &&
    renaming.repoPath === repoPath &&
    renaming.relPath === rel;

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
          const openEntryMenu = contextMenu.openMenu({
            repoPath,
            relPath: childDir,
            kind: e.kind,
            name: e.name,
          });
          if (e.kind === "dir") {
            const exp = expanded.has(childKey);
            return (
              <div key={childKey}>
                {isRenaming(repoPath, childDir) ? (
                  renameInputFor(depth)
                ) : (
                  <button
                    type="button"
                    className="view-row view-row-hover explorer-row explorer-dir"
                    style={{ paddingLeft: `${depth * 12 + 8}px` }}
                    onClick={() => toggleDir(repoPath, childDir)}
                    onContextMenu={openEntryMenu}
                  >
                    <span
                      className="view-arrow material-symbols-outlined"
                      aria-hidden="true"
                    >
                      {exp ? "expand_more" : "chevron_right"}
                    </span>{" "}
                    <span
                      className="explorer-icon material-symbols-outlined"
                      aria-hidden="true"
                    >
                      {exp ? "folder_open" : "folder"}
                    </span>{" "}
                    <span className="explorer-name">{e.name}</span>
                  </button>
                )}
                {exp && renderEntries(repoPath, childDir, depth + 1)}
              </div>
            );
          }
          if (isRenaming(repoPath, childDir)) {
            return <div key={childKey}>{renameInputFor(depth)}</div>;
          }
          return (
            <button
              key={childKey}
              type="button"
              className={
                selected === childKey
                  ? "view-row view-row-hover view-row-selected explorer-row explorer-file"
                  : "view-row view-row-hover explorer-row explorer-file"
              }
              style={{ paddingLeft: `${depth * 12 + 8}px` }}
              title={childDir}
              data-icon={fileIconKind(e.name)}
              onClick={() => clickFile(repoPath, childDir)}
              onContextMenu={openEntryMenu}
            >
              <span className="explorer-arrow-spacer" aria-hidden="true" />{" "}
              <span
                className="explorer-icon explorer-file-icon material-symbols-outlined"
                aria-hidden="true"
              >
                {FILE_ICON_GLYPH[fileIconKind(e.name)] ?? "draft"}
              </span>{" "}
              <span className="explorer-name">{e.name}</span>
            </button>
          );
        })}
        {data.truncated && (
          <div
            className="explorer-truncated"
            style={{ paddingLeft: `${depth * 12 + 8}px` }}
          >
            {t("explorer.truncated")}
          </div>
        )}
      </>
    );
  };

  const renderRepoNode = (
    r: FsRepo,
    depth: number,
    { showOrgDot, taggable }: { showOrgDot: boolean; taggable: boolean },
  ) => {
    const key = dirKey(r.path, "");
    const exp = expanded.has(key);
    return (
      <div key={r.path} className="explorer-repo">
        <button
          type="button"
          className="view-row view-row-hover explorer-row explorer-repo-row"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
          onClick={() => toggleDir(r.path, "")}
        >
          <span
            className="view-arrow material-symbols-outlined"
            aria-hidden="true"
          >
            {exp ? "expand_more" : "chevron_right"}
          </span>{" "}
          <span
            className="explorer-icon material-symbols-outlined"
            aria-hidden="true"
          >
            {r.isWorktree ? "account_tree" : "folder"}
          </span>{" "}
          <span className="explorer-repo-name">{r.repo}</span>
          {taggable && !r.isWorktree && (
            <span className="explorer-repo-tag">{t("explorer.mainTree")}</span>
          )}
          {showOrgDot && (
            <span
              className="org-dot"
              role="img"
              style={{ backgroundColor: resolveOrgColor(r.org, orgColors) }}
              title={resolveOrgName(r.org, orgAliases)}
              aria-label={`org: ${resolveOrgName(r.org, orgAliases)}`}
            />
          )}
        </button>
        {exp && renderEntries(r.path, "", depth + 1)}
      </div>
    );
  };

  return (
    <section className="explorer-view" data-view="explorer">
      <ViewHeader title="EXPLORER">
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
      </ViewHeader>
      {rootError !== null && <div className="explorer-error">{rootError}</div>}
      <div className="view-tree">
        {groupReposByRepository(repos).map((g) => {
          const [first, ...worktrees] = g.repos;
          if (first && worktrees.length === 0) {
            return renderRepoNode(first, 0, {
              showOrgDot: true,
              taggable: false,
            });
          }
          const collapsed = collapsedGroups.has(g.key);
          return (
            <div key={g.key} className="explorer-repo-group">
              <button
                type="button"
                className="view-row view-row-hover explorer-row explorer-group-row"
                onClick={() => toggleGroup(g.key)}
              >
                <span
                  className="view-arrow material-symbols-outlined"
                  aria-hidden="true"
                >
                  {collapsed ? "chevron_right" : "expand_more"}
                </span>{" "}
                <span className="explorer-group-name">{g.label}</span>{" "}
                <span
                  className="org-dot"
                  role="img"
                  style={{ backgroundColor: resolveOrgColor(g.org, orgColors) }}
                  title={resolveOrgName(g.org, orgAliases)}
                  aria-label={`org: ${resolveOrgName(g.org, orgAliases)}`}
                />
              </button>
              {!collapsed &&
                g.repos.map((r) =>
                  renderRepoNode(r, 1, { showOrgDot: false, taggable: true }),
                )}
            </div>
          );
        })}
      </div>
      {contextMenu.menu !== null && (
        <ExplorerContextMenu
          menu={contextMenu.menu}
          closeMenu={contextMenu.closeMenu}
          onReveal={reveal}
          onCopyPath={copyPath}
          onCopyRelativePath={copyRelativePath}
          onRename={startRename}
          onDelete={setDeleteTarget}
        />
      )}
      {deleteTarget !== null && (
        <ConfirmDialog
          title={t("explorer.deleteConfirmTitle")}
          message={t("explorer.deleteConfirmBody", { name: deleteTarget.name })}
          confirmLabel={t("common.moveToTrash")}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </section>
  );
}
