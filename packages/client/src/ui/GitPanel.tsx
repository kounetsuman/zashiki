import {
  type GitFileEntry,
  isValidCommitMessage,
  type RepoStatus,
  resolveOrgColor,
} from "@zashiki/shared";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import type { GitApi } from "../api/git.js";
import { Loading } from "./Loading.js";
import { PanelEmpty } from "./PanelEmpty.js";
import { PanelHeader } from "./PanelHeader.js";
import { panelClass } from "./panels.js";
import { RefreshButton, type RefreshState } from "./RefreshButton.js";

/** Color convention: A green / M yellow / D red / R cyan / ?? blue. */
const CODE_CLASS: Record<string, string> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  "??": "untracked",
};

function codeClass(code: string): string {
  return `git-code git-code-${CODE_CLASS[code] ?? "other"}`;
}

interface OrgGroup {
  org: string;
  repos: RepoStatus[];
}

function groupByOrg(repos: RepoStatus[]): OrgGroup[] {
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
function isFlatOrg(g: OrgGroup): boolean {
  return g.repos.length === 1 && g.repos[0]?.repo === g.org;
}

export interface GitPanelProps {
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

export function GitPanel({
  api,
  onGitDirty,
  orgColors = {},
  copyText,
  inactive,
}: GitPanelProps) {
  const { t } = useTranslation();
  const [repos, setRepos] = useState<RepoStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  // true only while the initial status fetch is in progress. It becomes true
  // only as the initial value, so refetches do not flicker the loading UI.
  const [loading, setLoading] = useState(true);
  // in-flight flag for the header icon, set on every refetch (initial, manual, git.dirty, post-action).
  const [refreshing, setRefreshing] = useState(true);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // The value of the commit message input per repo.path.
  const [messages, setMessages] = useState<Record<string, string>>({});
  // The target row (row key) for the "copied!" popup that signals a successful copy. null hides it.
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Generation number to avoid rolling back the display with a stale status response that returns late.
  const generation = useRef(0);

  const refetch = useCallback(async (): Promise<void> => {
    generation.current += 1;
    const gen = generation.current;
    setRefreshing(true);
    try {
      const res = await api.status();
      if (gen !== generation.current) return;
      setRepos(res.repos);
      setError(null);
    } catch (err) {
      if (gen === generation.current) setError(String(err));
    } finally {
      // Once the latest generation's fetch settles (success or failure), lower
      // loading/refreshing. loading matters only on the first fetch, while
      // refreshing makes the header icon react every time. Require the gen to
      // match so a stale fetch does not clear these across a generation swap.
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

  // On a successful copy, briefly show "copied!" on the target row. On rapid clicks, keep only the latest row.
  const copy = (text: string, rowKey: string): void => {
    const fn = copyText ?? ((t: string) => navigator.clipboard.writeText(t));
    void fn(text).then(
      () => {
        setCopiedKey(rowKey);
        if (copyTimer.current !== null) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopiedKey(null), 1200);
      },
      (err: unknown) => setError(String(err)),
    );
  };

  useEffect(
    () => () => {
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    },
    [],
  );

  const setMessage = (repoPath: string, value: string): void => {
    setMessages((prev) => ({ ...prev, [repoPath]: value }));
  };

  const commit = (repo: RepoStatus): void => {
    const message = messages[repo.path] ?? "";
    if (!isValidCommitMessage(message) || repo.staged.length === 0) return;
    void api.commit(repo.path, message).then(
      () => {
        setMessage(repo.path, "");
        void refetch();
      },
      (err: unknown) => setError(String(err)),
    );
  };

  // Commit on ⌘Enter / Ctrl+Enter. Exclude the Enter that confirms IME composition.
  const onCommitKeyDown = (
    repo: RepoStatus,
    e: KeyboardEvent<HTMLTextAreaElement>,
  ): void => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    if (!(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    commit(repo);
  };

  const fileRow = (repo: RepoStatus, staged: boolean, file: GitFileEntry) => {
    const rowKey = `${repo.path}:${staged ? "s" : "c"}:${file.code}:${file.path}`;
    return (
      <div className="git-file-row" key={rowKey}>
        <span className={codeClass(file.code)}>{file.code}</span>
        <button
          type="button"
          className="panel-row git-file-name"
          title={file.path}
          onClick={() => run(api.open(repo.path, file.path))}
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
  };

  const commitBox = (repo: RepoStatus) => {
    const message = messages[repo.path] ?? "";
    const canCommit = isValidCommitMessage(message) && repo.staged.length > 0;
    return (
      <div className="git-commit-box">
        <textarea
          className="git-commit-message"
          aria-label={`commit message ${repo.repo}`}
          placeholder={`Message (⌘Enter to commit on "${repo.branch}")`}
          rows={1}
          value={message}
          onChange={(e) => setMessage(repo.path, e.target.value)}
          onKeyDown={(e) => onCommitKeyDown(repo, e)}
        />
        <button
          type="button"
          className="git-commit-button"
          aria-label={`commit ${repo.repo}`}
          disabled={!canCommit}
          onClick={() => commit(repo)}
        >
          <span className="material-symbols-outlined" aria-hidden="true">
            check
          </span>{" "}
          Commit
        </button>
      </div>
    );
  };

  const repoBlock = (repo: RepoStatus, indented: boolean) => {
    const exp = expanded.has(repo.path);
    return (
      <div
        key={repo.path}
        className={indented ? "git-repo git-indent" : "git-repo"}
      >
        <div className="git-repo-line">
          <button
            type="button"
            className="panel-row git-row git-repo-row"
            onClick={() => toggle(repo.path)}
          >
            <span
              className="panel-arrow material-symbols-outlined"
              aria-hidden="true"
            >
              {exp ? "expand_more" : "chevron_right"}
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
          </span>
        </div>
        {exp && commitBox(repo)}
        {exp && repo.staged.length > 0 && (
          <div className="git-section">
            <div className="git-section-header git-section-staged">STAGED</div>
            {repo.staged.map((f) => fileRow(repo, true, f))}
          </div>
        )}
        {exp && repo.changed.length > 0 && (
          <div className="git-section">
            <div className="git-section-header git-section-changed">
              CHANGED
            </div>
            {repo.changed.map((f) => fileRow(repo, false, f))}
          </div>
        )}
      </div>
    );
  };

  const orgBlock = (g: OrgGroup) => {
    if (isFlatOrg(g)) {
      const only = g.repos[0];
      return only ? repoBlock(only, false) : null;
    }
    const key = `org:${g.org}`;
    const exp = expanded.has(key);
    return (
      <div key={key} className="git-org">
        <button
          type="button"
          className="panel-row panel-row-hover git-row git-org-row"
          onClick={() => toggle(key)}
        >
          <span
            className="panel-arrow material-symbols-outlined"
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
        {exp && g.repos.map((r) => repoBlock(r, true))}
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
    <section className={panelClass("git-panel", inactive)} data-panel="git">
      <PanelHeader title="SOURCE CONTROL">
        <RefreshButton
          state={refreshState}
          label="refresh"
          error={error}
          onClick={() => void refetch()}
        />
      </PanelHeader>
      {error !== null && <div className="git-error">{error}</div>}
      {error === null && loading && <Loading />}
      {error === null && !loading && repos.length === 0 && (
        <PanelEmpty>{t("git.noChanges")}</PanelEmpty>
      )}
      {error === null && !loading && repos.length > 0 && (
        <div className="panel-tree">{groupByOrg(repos).map(orgBlock)}</div>
      )}
    </section>
  );
}
