import type { RepoStatus } from "@zashiki/shared";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { GitApi } from "../api/git.js";
import { GitCommitBox } from "./GitCommitBox.js";
import { GitFileRow } from "./GitFileRow.js";
import {
  fileRowKey,
  formatLastCommit,
  iconForRepo,
  worktreeDeletable,
} from "./source-control-model.js";

/** Shared wiring for the git tree, threaded from SourceControlView down through each repo block. */
export interface GitTreeHandlers {
  api: GitApi;
  run(action: Promise<void>): void;
  copy(text: string, rowKey: string): void;
  copiedKey: string | null;
  expanded: ReadonlySet<string>;
  toggle(key: string): void;
  messages: Record<string, string>;
  setMessage(repoPath: string, value: string): void;
  commit(repo: RepoStatus): void;
  onCommitKeyDown(
    repo: RepoStatus,
    e: KeyboardEvent<HTMLTextAreaElement>,
  ): void;
  confirmingDelete: string | null;
  requestDelete(path: string): void;
  confirmDelete(path: string): void;
  cancelDelete(): void;
}

export interface GitRepoBlockProps {
  repo: RepoStatus;
  indented: boolean;
  handlers: GitTreeHandlers;
}

/** A repo row (branch + staged/changed counts, stage-all/unstage-all) with its commit box and file lists. */
export function GitRepoBlock({ repo, indented, handlers }: GitRepoBlockProps) {
  const { t } = useTranslation();
  const {
    api,
    run,
    copy,
    copiedKey,
    expanded,
    toggle,
    messages,
    setMessage,
    commit,
    onCommitKeyDown,
    confirmingDelete,
    requestDelete,
    confirmDelete,
    cancelDelete,
  } = handlers;
  const exp = expanded.has(repo.path);
  const lastCommit = formatLastCommit(repo.lastCommit);
  const typeLabel = t(repo.isWorktree ? "git.worktree" : "git.repository");
  const rowTitle = lastCommit
    ? `${typeLabel} · ${t("git.lastCommit", { date: lastCommit })}`
    : typeLabel;
  const deletable = worktreeDeletable(repo);
  const confirming = confirmingDelete === repo.path;
  return (
    <div className={indented ? "git-repo git-indent" : "git-repo"}>
      <div className="git-repo-line">
        <button
          type="button"
          className="view-row git-row git-repo-row"
          title={rowTitle}
          onClick={() => toggle(repo.path)}
        >
          <span
            className="view-arrow material-symbols-outlined"
            aria-hidden="true"
          >
            {exp ? "expand_more" : "chevron_right"}
          </span>{" "}
          <span
            className="git-repo-icon material-symbols-outlined"
            aria-hidden="true"
          >
            {iconForRepo(repo)}
          </span>{" "}
          <span className="git-repo-name">{repo.repo}</span>{" "}
          <span className="git-branch">{repo.branch}</span>{" "}
          {repo.staged.length > 0 && (
            <span className="git-count-staged">●{repo.staged.length}</span>
          )}
          {repo.changed.length > 0 && (
            <span className="git-count-changed">+{repo.changed.length}</span>
          )}
        </button>
        <span className="git-row-actions">
          <button
            type="button"
            aria-label={`stage-all ${repo.repo}`}
            title={t("git.stageAll")}
            onClick={() => run(api.stageAll(repo.path))}
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              add
            </span>
          </button>
          <button
            type="button"
            aria-label={`unstage-all ${repo.repo}`}
            title={t("git.unstageAll")}
            onClick={() => run(api.unstageAll(repo.path))}
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              remove
            </span>
          </button>
          {deletable && !confirming && (
            <button
              type="button"
              className="git-delete"
              aria-label={t("git.deleteWorktree", { repo: repo.repo })}
              title={t("git.deleteWorktree", { repo: repo.repo })}
              onClick={() => requestDelete(repo.path)}
            >
              <span className="material-symbols-outlined" aria-hidden="true">
                delete
              </span>
            </button>
          )}
          {deletable && confirming && (
            <span className="git-delete-confirm">
              <button
                type="button"
                className="git-delete-ok"
                aria-label={t("git.deleteWorktreeConfirm", { repo: repo.repo })}
                title={t("common.delete")}
                onClick={() => confirmDelete(repo.path)}
              >
                {t("common.delete")}
              </button>
              <button
                type="button"
                className="git-delete-cancel"
                aria-label={t("git.deleteWorktreeCancel", { repo: repo.repo })}
                title={t("common.cancel")}
                onClick={cancelDelete}
              >
                {t("common.cancel")}
              </button>
            </span>
          )}
        </span>
      </div>
      {exp && (
        <GitCommitBox
          repo={repo}
          message={messages[repo.path] ?? ""}
          onChange={(value) => setMessage(repo.path, value)}
          onCommit={() => commit(repo)}
          onKeyDown={(e) => onCommitKeyDown(repo, e)}
        />
      )}
      {exp && repo.staged.length > 0 && (
        <div className="git-section">
          <div className="git-section-header git-section-staged">STAGED</div>
          {repo.staged.map((f) => (
            <GitFileRow
              key={fileRowKey(repo.path, true, f.code, f.path)}
              api={api}
              repo={repo}
              staged
              file={f}
              copiedKey={copiedKey}
              run={run}
              copy={copy}
            />
          ))}
        </div>
      )}
      {exp && repo.changed.length > 0 && (
        <div className="git-section">
          <div className="git-section-header git-section-changed">CHANGED</div>
          {repo.changed.map((f) => (
            <GitFileRow
              key={fileRowKey(repo.path, false, f.code, f.path)}
              api={api}
              repo={repo}
              staged={false}
              file={f}
              copiedKey={copiedKey}
              run={run}
              copy={copy}
            />
          ))}
        </div>
      )}
    </div>
  );
}
