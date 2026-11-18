import { type DragEvent, useCallback } from "react";

import { dragCarriesFiles, droppedFiles } from "../viewer/dropped-file.js";
import {
  type LocalFileHandlers,
  localFileOf,
  openLocalFiles,
} from "../viewer/open-local-files.js";

export interface FileDropHandlers {
  onDragOver(e: DragEvent): void;
  onDrop(e: DragEvent): void;
}

/**
 * Opens files dropped from Finder in the Viewer. Only acts on drags carrying OS files, so in-page
 * drags (e.g. tab reordering) pass through untouched.
 */
export function useFileDrop(handlers: LocalFileHandlers): FileDropHandlers {
  const onDragOver = useCallback((e: DragEvent): void => {
    if (dragCarriesFiles(e.dataTransfer)) e.preventDefault();
  }, []);

  const onDrop = useCallback(
    (e: DragEvent): void => {
      const files = droppedFiles(e.dataTransfer);
      if (files.length === 0) return;
      e.preventDefault();
      void openLocalFiles(files.map(localFileOf), handlers);
    },
    [handlers],
  );

  return { onDragOver, onDrop };
}
