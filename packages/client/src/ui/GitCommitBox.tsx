import { isValidCommitMessage, type RepoStatus } from "@zashiki/shared";
import type { KeyboardEvent } from "react";

export interface GitCommitBoxProps {
  repo: RepoStatus;
  message: string;
  onChange(value: string): void;
  onCommit(): void;
  onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void;
}

/** Commit message input + commit button for one repo (enabled only with a valid message and staged files). */
export function GitCommitBox({
  repo,
  message,
  onChange,
  onCommit,
  onKeyDown,
}: GitCommitBoxProps) {
  const canCommit = isValidCommitMessage(message) && repo.staged.length > 0;
  return (
    <div className="git-commit-box">
      <textarea
        className="git-commit-message"
        aria-label={`commit message ${repo.repo}`}
        placeholder={`Message (⌘Enter to commit on "${repo.branch}")`}
        rows={1}
        value={message}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <button
        type="button"
        className="git-commit-button"
        aria-label={`commit ${repo.repo}`}
        disabled={!canCommit}
        onClick={onCommit}
      >
        <span className="material-symbols-outlined" aria-hidden="true">
          check
        </span>{" "}
        Commit
      </button>
    </div>
  );
}
