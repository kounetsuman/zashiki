import { isValidCommitMessage, type RepoStatus } from "@zashiki/shared";
import { type KeyboardEvent, useState } from "react";
import type { GitApi } from "../api/git.js";

export interface CommitDraft {
  /** Commit message input value per repo.path. */
  messages: Record<string, string>;
  setMessage(repoPath: string, value: string): void;
  commit(repo: RepoStatus): void;
  onCommitKeyDown(
    repo: RepoStatus,
    e: KeyboardEvent<HTMLTextAreaElement>,
  ): void;
}

/**
 * Per-repo commit message drafts and committing. A commit is a no-op unless the message is valid and
 * something is staged; on success the draft clears and the status refetches. Commits on ⌘/Ctrl+Enter,
 * excluding the Enter that confirms IME composition.
 */
export function useCommitDraft(
  api: GitApi,
  refetch: () => Promise<void>,
  setError: (error: string) => void,
): CommitDraft {
  const [messages, setMessages] = useState<Record<string, string>>({});

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

  const onCommitKeyDown = (
    repo: RepoStatus,
    e: KeyboardEvent<HTMLTextAreaElement>,
  ): void => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    if (!(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    commit(repo);
  };

  return { messages, setMessage, commit, onCommitKeyDown };
}
