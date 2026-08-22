import type { GitFileEntry, RepoStatus } from "@zashiki/shared";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { GitApi } from "../api/git.js";
import { codeClass, fileRowKey } from "./source-control-model.js";

/** Delay a single click by this much so a double-click (open diff) can cancel the open-in-editor. */
const SINGLE_CLICK_DELAY_MS = 250;

export interface GitFileRowProps {
  api: GitApi;
  repo: RepoStatus;
  staged: boolean;
  file: GitFileEntry;
  copiedKey: string | null;
  run(action: Promise<void>): void;
  copy(text: string, rowKey: string): void;
  onOpenDiff?(
    repoPath: string,
    file: string,
    staged: boolean,
    untracked: boolean,
  ): void;
}

/**
 * One changed/staged file: status code, path, copy path, and stage/unstage. A single click opens the
 * file in the external editor; a double click opens its diff. The single click is deferred so a
 * double click cancels it (an untracked directory has no file to diff, so it opens immediately).
 */
export function GitFileRow({
  api,
  repo,
  staged,
  file,
  copiedKey,
  run,
  copy,
  onOpenDiff,
}: GitFileRowProps) {
  const { t } = useTranslation();
  const rowKey = fileRowKey(repo.path, staged, file.code, file.path);
  const untracked = file.code === "??";
  const diffable =
    onOpenDiff !== undefined && !(untracked && file.path.endsWith("/"));

  const clickTimer = useRef<number | null>(null);
  const cancelClick = (): void => {
    if (clickTimer.current !== null) {
      window.clearTimeout(clickTimer.current);
      clickTimer.current = null;
    }
  };
  useEffect(
    () => () => {
      if (clickTimer.current !== null) window.clearTimeout(clickTimer.current);
    },
    [],
  );

  const openInEditor = (): void => run(api.open(repo.path, file.path));
  const handleClick = (): void => {
    if (!diffable) {
      openInEditor();
      return;
    }
    cancelClick();
    clickTimer.current = window.setTimeout(() => {
      clickTimer.current = null;
      openInEditor();
    }, SINGLE_CLICK_DELAY_MS);
  };
  const handleDoubleClick = (): void => {
    cancelClick();
    onOpenDiff?.(repo.path, file.path, staged, untracked);
  };

  return (
    <div className="git-file-row">
      <span className={codeClass(file.code)}>{file.code}</span>
      <button
        type="button"
        className="view-row git-file-name"
        title={file.path}
        onClick={handleClick}
        onDoubleClick={diffable ? handleDoubleClick : undefined}
      >
        {file.path}
      </button>
      <span className="git-row-actions">
        <button
          type="button"
          aria-label={`copy ${file.path}`}
          title={t("common.copyAbsPath")}
          onClick={() => copy(`${repo.path}/${file.path}`, rowKey)}
        >
          <span className="material-symbols-outlined" aria-hidden="true">
            content_copy
          </span>
        </button>
        {staged ? (
          <button
            type="button"
            aria-label={`unstage ${file.path}`}
            title="Unstage"
            onClick={() => run(api.unstage(repo.path, file.path))}
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              remove
            </span>
          </button>
        ) : (
          <button
            type="button"
            aria-label={`stage ${file.path}`}
            title="Stage"
            onClick={() => run(api.stage(repo.path, file.path))}
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              add
            </span>
          </button>
        )}
        {copiedKey === rowKey && (
          <span className="git-copied-popup" role="status">
            copied!
          </span>
        )}
      </span>
    </div>
  );
}
