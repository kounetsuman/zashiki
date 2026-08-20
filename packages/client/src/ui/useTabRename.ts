import { type CockpitTerminalInfo, isUuidSid } from "@zashiki/shared";
import { useEffect, useRef, useState } from "react";
import { type Tab, tabKey } from "../tabs/tab-model.js";

export interface TabRename {
  /** Key of the tab being edited (null when not editing). */
  editingKey: string | null;
  draft: string;
  setDraft(value: string): void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  isRenamable(session: CockpitTerminalInfo): boolean;
  startEdit(key: string, session: CockpitTerminalInfo, label: string): void;
  commit(): void;
  cancel(): void;
}

/**
 * Inline tab rename. Remembers the cockpitTerminalId/name from when editing started so a commit is not applied
 * to a different tab, aborts editing if that tab is pruned, and guards against the unmount blur
 * re-committing a stale draft after an Escape cancel. Non-UUID windows cannot be renamed (commitTitle
 * is a no-op there), so editing never starts for them. Same convention as the conversation header.
 */
export function useTabRename(
  tabs: readonly Tab[],
  cockpitTerminals: CockpitTerminalInfo[],
  onRename?: (cockpitTerminalId: string, name: string, title: string) => void,
): TabRename {
  const [editing, setEditing] = useState<{
    key: string;
    cockpitTerminalId: string;
    name: string;
  } | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const doneRef = useRef(false);

  if (editing !== null) {
    const tab = tabs.find((t) => tabKey(t) === editing.key);
    const s =
      tab?.kind === "session"
        ? cockpitTerminals.find((x) => x.cockpitTerminalId === tab.id)
        : undefined;
    if (s === undefined) {
      doneRef.current = true;
      setEditing(null);
    }
  }

  useEffect(() => {
    if (editing !== null) inputRef.current?.focus();
  }, [editing]);

  const isRenamable = (session: CockpitTerminalInfo): boolean =>
    onRename !== undefined && isUuidSid(session.cockpitTerminalId);

  const startEdit = (
    key: string,
    session: CockpitTerminalInfo,
    label: string,
  ): void => {
    if (!isRenamable(session)) return;
    doneRef.current = false;
    setDraft(label);
    setEditing({
      key,
      cockpitTerminalId: session.cockpitTerminalId,
      name: session.name,
    });
  };

  const commit = (): void => {
    if (doneRef.current || editing === null) return;
    doneRef.current = true;
    onRename?.(editing.cockpitTerminalId, editing.name, draft);
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
