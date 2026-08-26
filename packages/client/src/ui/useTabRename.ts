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
  /** Begin editing a viewer tab's filename (commits via onRenameFile, e.g. from the context menu). */
  startFileEdit(
    key: string,
    repoPath: string,
    relPath: string,
    label: string,
  ): void;
  commit(): void;
  cancel(): void;
}

type Editing =
  | { kind: "session"; key: string; cockpitTerminalId: string; name: string }
  | { kind: "viewer"; key: string; repoPath: string; relPath: string };

/**
 * Inline tab rename for both a session's title and a viewer tab's filename. Remembers the target from when
 * editing started so a commit is not applied to a different tab, aborts editing if that tab is pruned, and
 * guards against the unmount blur re-committing a stale draft after an Escape cancel. Non-UUID windows
 * cannot be renamed (commitTitle is a no-op there), so title editing never starts for them.
 */
export function useTabRename(
  tabs: readonly Tab[],
  cockpitTerminals: CockpitTerminalInfo[],
  onRename?: (cockpitTerminalId: string, name: string, title: string) => void,
  onRenameFile?: (repoPath: string, relPath: string, newName: string) => void,
): TabRename {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const doneRef = useRef(false);

  if (editing !== null) {
    const tab = tabs.find((t) => tabKey(t) === editing.key);
    const gone =
      editing.kind === "session"
        ? !(
            tab?.kind === "session" &&
            cockpitTerminals.some((x) => x.cockpitTerminalId === tab.id)
          )
        : tab === undefined;
    if (gone) {
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
      kind: "session",
      key,
      cockpitTerminalId: session.cockpitTerminalId,
      name: session.name,
    });
  };

  const startFileEdit = (
    key: string,
    repoPath: string,
    relPath: string,
    label: string,
  ): void => {
    if (onRenameFile === undefined) return;
    doneRef.current = false;
    setDraft(label);
    setEditing({ kind: "viewer", key, repoPath, relPath });
  };

  const commit = (): void => {
    if (doneRef.current || editing === null) return;
    doneRef.current = true;
    if (editing.kind === "session") {
      onRename?.(editing.cockpitTerminalId, editing.name, draft);
    } else {
      onRenameFile?.(editing.repoPath, editing.relPath, draft);
    }
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
    startFileEdit,
    commit,
    cancel,
  };
}
