import { type DragEvent, useState } from "react";

export interface TabDrag {
  dragKey: string | null;
  dragOverKey: string | null;
  onDragStart(key: string, e: DragEvent): void;
  markDropTarget(key: string, e: DragEvent): void;
  onDragLeave(key: string): void;
  onDrop(key: string, e: DragEvent): void;
  endDrag(): void;
}

/**
 * Drag & drop tab reordering. WebKit (Tauri WKWebView) only fires drop when the default is prevented
 * on both dragenter and dragover, so markDropTarget always suppresses the default and only updates the
 * visual highlight/dropEffect for other tabs.
 */
export function useTabDrag(
  onReorder?: (fromKey: string, toKey: string) => void,
): TabDrag {
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);

  const endDrag = (): void => {
    setDragKey(null);
    setDragOverKey(null);
  };

  const onDragStart = (key: string, e: DragEvent): void => {
    setDragKey(key);
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", key);
    }
  };

  const markDropTarget = (key: string, e: DragEvent): void => {
    e.preventDefault();
    if (dragKey === null || dragKey === key) return;
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    setDragOverKey(key);
  };

  const onDragLeave = (key: string): void => {
    if (dragOverKey === key) setDragOverKey(null);
  };

  const onDrop = (key: string, e: DragEvent): void => {
    e.preventDefault();
    if (dragKey !== null && dragKey !== key) onReorder?.(dragKey, key);
    endDrag();
  };

  return {
    dragKey,
    dragOverKey,
    onDragStart,
    markDropTarget,
    onDragLeave,
    onDrop,
    endDrag,
  };
}
