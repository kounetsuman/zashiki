import { resolveOrgColor, resolveOrgName } from "@zashiki/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { GitApi } from "../api/git.js";
import { GitRepoBlock, type GitTreeHandlers } from "./GitRepoBlock.js";
import { Loading } from "./Loading.js";
import {
  groupByOrg,
  isFlatOrg,
  type OrgGroup,
} from "./source-control-model.js";
import { useCommitDraft } from "./useCommitDraft.js";
import { useConfirmDelete } from "./useConfirmDelete.js";
import { useGitCopyFeedback } from "./useGitCopyFeedback.js";
import { useGitStatus } from "./useGitStatus.js";
import { ViewEmpty } from "./ViewEmpty.js";
import { ViewHeader } from "./ViewHeader.js";
import { viewClass } from "./views.js";

export interface SourceControlViewProps {
  api: GitApi;
  /** Subscribe to git.dirty on the control WS (returns an unsubscribe). Triggers refetch. */
  onGitDirty(fn: () => void): () => void;
  /** org -> display color (explicit color from repos.conf). Unspecified orgs get an auto color. */
  orgColors?: Record<string, string>;
  /** org -> display alias (from repos.conf). Unspecified orgs are shown by their identity. */
  orgAliases?: Record<string, string>;
  /** The actual path-copy implementation. Defaults to navigator.clipboard. For test injection. */
  copyText?(text: string): Promise<void>;
  /** Double-clicking a file row opens its diff (staged/untracked select which versions to compare). */
  onOpenDiff?(
    repoPath: string,
    file: string,
    staged: boolean,
    untracked: boolean,
  ): void;
  /** Apply a faint overlay when inactive. */
  inactive?: boolean;
}

export function SourceControlView({
  api,
  onGitDirty,
  orgColors = {},
  orgAliases = {},
  copyText,
  onOpenDiff,
  inactive,
}: SourceControlViewProps) {
  const { t } = useTranslation();
  const { repos, skipped, error, loading, refetch, setError } = useGitStatus(
    api,
    onGitDirty,
  );
  const { copiedKey, copy } = useGitCopyFeedback(setError, copyText);
  const { messages, setMessage, commit, onCommitKeyDown } = useCommitDraft(
    api,
    refetch,
    setError,
  );
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const toggle = (key: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const run = (action: Promise<void>): void => {
    void action.then(
      () => refetch(),
      (err: unknown) => setError(String(err)),
    );
  };

  const { confirmingDelete, requestDelete, confirmDelete, cancelDelete } =
    useConfirmDelete(repos, (path) => run(api.removeWorktree(path)));

  const handlers: GitTreeHandlers = {
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
    onOpenDiff,
  };

  const orgBlock = (g: OrgGroup) => {
    if (isFlatOrg(g)) {
      const only = g.repos[0];
      return only ? (
        <GitRepoBlock
          key={only.path}
          repo={only}
          indented={false}
          handlers={handlers}
        />
      ) : null;
    }
    const key = `org:${g.org}`;
    const exp = expanded.has(key);
    return (
      <div key={key} className="git-org">
        <button
          type="button"
          className="view-row view-row-hover git-row git-org-row"
          onClick={() => toggle(key)}
        >
          <span
            className="view-arrow material-symbols-outlined"
            aria-hidden="true"
          >
            {exp ? "expand_more" : "chevron_right"}
          </span>{" "}
          <span
            className="git-org-name"
            style={{ color: resolveOrgColor(g.org, orgColors) }}
          >
            {resolveOrgName(g.org, orgAliases)}
          </span>{" "}
          ({g.repos.length})
        </button>
        {exp &&
          g.repos.map((r) => (
            <GitRepoBlock key={r.path} repo={r} indented handlers={handlers} />
          ))}
      </div>
    );
  };

  return (
    <section
      className={viewClass("git-view", inactive)}
      data-view="sourceControl"
    >
      <ViewHeader title="SOURCE CONTROL" />
      {error !== null && <div className="git-error">{error}</div>}
      {error === null && loading && <Loading />}
      {error === null && !loading && skipped.length > 0 && (
        <div className="git-warning" role="status">
          {t("git.skipped", { count: skipped.length })}
        </div>
      )}
      {error === null &&
        !loading &&
        repos.length === 0 &&
        skipped.length === 0 && <ViewEmpty>{t("git.noChanges")}</ViewEmpty>}
      {error === null && !loading && repos.length > 0 && (
        <div className="view-tree">{groupByOrg(repos).map(orgBlock)}</div>
      )}
    </section>
  );
}
