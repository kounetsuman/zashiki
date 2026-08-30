import { FILE_MAX_BYTES } from "@zashiki/shared";
import { type DragEvent, useCallback } from "react";

import { dragCarriesFiles, droppedFiles } from "../viewer/dropped-file.js";
import { type MediaKind, mediaKind } from "../viewer/media.js";

export type FileDropError = "tooLarge" | "readFailed";

export interface FileDropHandlers {
  onDragOver(e: DragEvent): void;
  onDrop(e: DragEvent): void;
}

/**
 * Opens files dropped from Finder in the Viewer. Images/videos go to `onMedia` (rendered from an
 * object URL, no size cap); other files are read as text via `onFile`. Only acts on drags carrying
 * OS files, so in-page drags (e.g. tab reordering) pass through untouched.
 */
export function useFileDrop(
  onFile: (name: string, content: string) => void,
  onMedia: (name: string, file: File, kind: MediaKind) => void,
  onError: (name: string, error: FileDropError) => void,
): FileDropHandlers {
  const onDragOver = useCallback((e: DragEvent): void => {
    if (dragCarriesFiles(e.dataTransfer)) e.preventDefault();
  }, []);

  const onDrop = useCallback(
    (e: DragEvent): void => {
      const files = droppedFiles(e.dataTransfer);
      if (files.length === 0) return;
      e.preventDefault();
      void (async () => {
        for (const file of files) {
          const kind = mediaKind(file.name);
          if (kind !== null) {
            onMedia(file.name, file, kind);
            continue;
          }
          if (file.size > FILE_MAX_BYTES) {
            onError(file.name, "tooLarge");
            continue;
          }
          try {
            onFile(file.name, await file.text());
          } catch {
            onError(file.name, "readFailed");
          }
        }
      })();
    },
    [onFile, onMedia, onError],
  );

  return { onDragOver, onDrop };
}
