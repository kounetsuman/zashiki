import { resolveOrgColor } from "@zashiki/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { GitApi } from "../api/git.js";
import { GitRepoBlock, type GitTreeHandlers } from "./GitRepoBlock.js";
import { Loading } from "./Loading.js";
import { RefreshButton, type RefreshState } from "./RefreshButton.js";
import {
  groupByOrg,
  isFlatOrg,
  type OrgGroup,
} from "./source-control-model.js";
import { useCommitDraft } from "./useCommitDraft.js";
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
  /** The actual path-copy implementation. Defaults to navigator.clipboard. For test injection. */
  copyText?(text: string): Promise<void>;
  /** Apply a faint overlay when inactive. */
  inactive?: boolean;
}

export function SourceControlView({
  api,
  onGitDirty,
  orgColors = {},
  copyText,
  inactive,
}: SourceControlViewProps) {
  const { t } = useTranslation();
  const { repos, skipped, error, loading, refreshing, refetch, setError } =
    useGitStatus(api, onGitDirty);
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
            {g.org}
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

  // Prioritize the spinner while fetching; show the warning icon if an error remains after settling.
  const refreshState: RefreshState = refreshing
    ? "loading"
    : error !== null
      ? "error"
      : "idle";

  return (
    <section
      className={viewClass("git-view", inactive)}
      data-view="sourceControl"
    >
      <ViewHeader title="SOURCE CONTROL">
        <RefreshButton
          state={refreshState}
          label="refresh"
          error={error}
          onClick={() => void refetch()}
        />
      </ViewHeader>
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
