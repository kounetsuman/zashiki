import type { RepoStatus } from "@zashiki/shared";
import { useEffect, useState } from "react";

export interface ConfirmDelete {
  /** repo path awaiting inline delete confirmation (null when none). */
  confirmingDelete: string | null;
  requestDelete(path: string): void;
  confirmDelete(path: string): void;
  cancelDelete(): void;
}

/** Inline worktree-delete confirmation (window.confirm is unresponsive in the Tauri WKWebView). */
export function useConfirmDelete(
  repos: RepoStatus[],
  onDelete: (path: string) => void,
): ConfirmDelete {
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  useEffect(() => {
    if (confirmingDelete === null) return;
    if (!repos.some((r) => r.path === confirmingDelete))
      setConfirmingDelete(null);
  }, [repos, confirmingDelete]);

  return {
    confirmingDelete,
    requestDelete: (path: string) => setConfirmingDelete(path),
    confirmDelete: (path: string) => {
      setConfirmingDelete(null);
      onDelete(path);
    },
    cancelDelete: () => setConfirmingDelete(null),
  };
}
