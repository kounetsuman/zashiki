import { type DragEvent, useState } from "react";
import { dropOutsideWindow, type ScreenPoint } from "../lib/pop-out.js";

export interface TabDrag {
  dragKey: string | null;
  dragOverKey: string | null;
  onDragStart(key: string, e: DragEvent): void;
  markDropTarget(key: string, e: DragEvent): void;
  onDragLeave(key: string): void;
  onDrop(key: string, e: DragEvent): void;
  onDragEnd(key: string, e: DragEvent): void;
}

/**
 * Drag & drop tab reordering, and (with `onDragOut`) letting a tab go outside the window. WebKit
 * (Tauri WKWebView) only fires drop when the default is prevented on both dragenter and dragover, so
 * markDropTarget always suppresses the default and only updates the visual highlight/dropEffect for
 * other tabs.
 */
export function useTabDrag(
  onReorder?: (fromKey: string, toKey: string) => void,
  onDragOut?: (key: string, at: ScreenPoint) => void,
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

  const onDragEnd = (key: string, e: DragEvent): void => {
    endDrag();
    if (onDragOut === undefined) return;
    const at = dropOutsideWindow(
      {
        dropEffect: e.dataTransfer?.dropEffect ?? "none",
        clientX: e.clientX,
        clientY: e.clientY,
        screenX: e.screenX,
        screenY: e.screenY,
      },
      { width: window.innerWidth, height: window.innerHeight },
    );
    if (at !== null) onDragOut(key, at);
  };

  return {
    dragKey,
    dragOverKey,
    onDragStart,
    markDropTarget,
    onDragLeave,
    onDrop,
    onDragEnd,
  };
}
