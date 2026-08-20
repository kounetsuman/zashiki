import { type CockpitTerminalInfo, isUuidSid } from "@zashiki/shared";
import { useEffect, useRef, useState } from "react";
import {
  effectiveCustomTitle,
  resolveTitle,
  type TitleMap,
} from "../lib/conversation-title.js";

export interface RowRename {
  renaming: { cockpitTerminalId: string; name: string } | null;
  renameDraft: string;
  setRenameDraft(value: string): void;
  renameInputRef: React.RefObject<HTMLInputElement | null>;
  isRenamable(s: CockpitTerminalInfo): boolean;
  startRename(s: CockpitTerminalInfo): void;
  commitRename(): void;
  cancelRename(): void;
}

/**
 * Inline row rename. Remembers the cockpitTerminalId/name from when editing started so a commit is not
 * mis-applied to a different window, aborts editing if that row is pruned, and guards against the
 * unmount blur re-committing a stale draft after an Escape cancel. Non-UUID windows cannot be renamed
 * (commitTitle is a no-op there), so editing never starts for them. Same convention as tab renaming.
 */
export function useRowRename(
  cockpitTerminals: CockpitTerminalInfo[],
  conversationTitles: TitleMap,
  onRename?: (cockpitTerminalId: string, name: string, title: string) => void,
): RowRename {
  const [renaming, setRenaming] = useState<{
    cockpitTerminalId: string;
    name: string;
  } | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const renameDoneRef = useRef(false);

  useEffect(() => {
    if (renaming !== null) renameInputRef.current?.focus();
  }, [renaming]);

  if (renaming !== null) {
    const s = cockpitTerminals.find(
      (x) => x.cockpitTerminalId === renaming.cockpitTerminalId,
    );
    if (s === undefined) {
      renameDoneRef.current = true;
      setRenaming(null);
    }
  }

  const isRenamable = (s: CockpitTerminalInfo): boolean =>
    onRename !== undefined && isUuidSid(s.cockpitTerminalId);

  const startRename = (s: CockpitTerminalInfo): void => {
    if (!isRenamable(s)) return;
    renameDoneRef.current = false;
    setRenameDraft(
      resolveTitle(effectiveCustomTitle(conversationTitles, s), s),
    );
    setRenaming({ cockpitTerminalId: s.cockpitTerminalId, name: s.name });
  };

  const commitRename = (): void => {
    if (renameDoneRef.current || renaming === null) return;
    renameDoneRef.current = true;
    onRename?.(renaming.cockpitTerminalId, renaming.name, renameDraft);
    setRenaming(null);
  };

  const cancelRename = (): void => {
    renameDoneRef.current = true;
    setRenaming(null);
  };

  return {
    renaming,
    renameDraft,
    setRenameDraft,
    renameInputRef,
    isRenamable,
    startRename,
    commitRename,
    cancelRename,
  };
}
