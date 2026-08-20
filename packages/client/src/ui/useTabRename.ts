import { isUuidSid, type SessionInfo } from "@zashiki/shared";
import { useEffect, useRef, useState } from "react";
import { type Tab, tabKey } from "../tabs/tab-model.js";

export interface TabRename {
  /** Key of the tab being edited (null when not editing). */
  editingKey: string | null;
  draft: string;
  setDraft(value: string): void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  isRenamable(session: SessionInfo): boolean;
  startEdit(key: string, session: SessionInfo, label: string): void;
  commit(): void;
  cancel(): void;
}

/**
 * Inline tab rename. Remembers the windowId/name from when editing started so a commit is not applied
 * to a different tab, aborts editing if that tab is pruned, and guards against the unmount blur
 * re-committing a stale draft after an Escape cancel. Non-UUID windows cannot be renamed (commitTitle
 * is a no-op there), so editing never starts for them. Same convention as the conversation header.
 */
export function useTabRename(
  tabs: readonly Tab[],
  sessions: SessionInfo[],
  onRename?: (windowId: string, name: string, title: string) => void,
): TabRename {
  const [editing, setEditing] = useState<{
    key: string;
    windowId: string;
    name: string;
  } | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const doneRef = useRef(false);

  if (editing !== null) {
    const tab = tabs.find((t) => tabKey(t) === editing.key);
    const s =
      tab?.kind === "session"
        ? sessions.find((x) => x.windowId === tab.id)
        : undefined;
    if (s === undefined) {
      doneRef.current = true;
      setEditing(null);
    }
  }

  useEffect(() => {
    if (editing !== null) inputRef.current?.focus();
  }, [editing]);

  const isRenamable = (session: SessionInfo): boolean =>
    onRename !== undefined && isUuidSid(session.windowId);

  const startEdit = (
    key: string,
    session: SessionInfo,
    label: string,
  ): void => {
    if (!isRenamable(session)) return;
    doneRef.current = false;
    setDraft(label);
    setEditing({ key, windowId: session.windowId, name: session.name });
  };

  const commit = (): void => {
    if (doneRef.current || editing === null) return;
    doneRef.current = true;
    onRename?.(editing.windowId, editing.name, draft);
    setEditing(null);
  };

  const cancel = (): void => {
    doneRef.current = true;
    setEditing(null);
  };

  return {
    editingKey: editing?.key ?? null,
    draft,
    setDraft,
    inputRef,
    isRenamable,
    startEdit,
    commit,
    cancel,
  };
}
