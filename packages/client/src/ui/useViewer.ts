import type { TextEncoding } from "@zashiki/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FilesApi } from "../api/files.js";
import i18n from "../i18n/index.js";
import { readPickedFile } from "../lib/open-file-dialog.js";
import { audioContentType, type MediaKind } from "../viewer/media.js";
import {
  bufferFailed,
  bufferLoaded,
  bufferSetEncoding,
  bufferShowText,
  bufferTogglePreview,
  closeBuffer as dropBuffer,
  encodingOf,
  externalMediaKey,
  externalTextKey,
  openBuffer,
  openExternalBuffer,
  openExternalMediaBuffer,
  openMediaBuffer,
  shouldPollBuffer,
  type ViewerBuffer,
  type ViewerBuffers,
  viewerKey,
} from "../viewer/viewer-model.js";

/** Interval for re-reading the file open in the viewer (realtime reflection). */
const FILE_POLL_INTERVAL_MS = 2000;

/** Timeout for a file read (always settles the Promise even if it hangs). */
const FILE_READ_TIMEOUT_MS = 8000;

function readErrorMessage(e: unknown): string {
  if (e instanceof DOMException && e.name === "AbortError") {
    return i18n.t("viewer.readTimeout");
  }
  return e instanceof Error ? e.message : String(e);
}

export interface Viewer {
  buffers: ViewerBuffers;
  /** Ensures a buffer for the file (firing a read only when new) and returns its key. */
  ensureBuffer(
    repoPath: string,
    relPath: string,
    encoding?: TextEncoding,
  ): string;
  /** Ensures a repo image/video/audio/font/PDF buffer streamed from the media URL (no text read) and returns its key. */
  ensureMediaBuffer(repoPath: string, relPath: string, kind: MediaKind): string;
  /** Opens a dropped file from content already in hand (no repo read) and returns its key. */
  openExternal(name: string, content: string): string;
  /** Opens a dropped image/video/audio/font/PDF from an object URL created for the file, and returns its key. */
  openExternalMedia(name: string, file: File, kind: MediaKind): string;
  closeBuffer(key: string): void;
  togglePreview(key: string): void;
  /** Re-reads a repo text file decoded with `encoding`, which later polls keep using. */
  setEncoding(key: string, encoding: TextEncoding): void;
  /** Leaves the alternate rendering, so a line can be revealed in the text view. */
  showText(key: string): void;
  /** Absolute path of the buffer at key, or null when it is gone or external (no repo path). */
  pathOf(key: string): string | null;
}

/** The dropped file retyped where the webview needs the content type to play or render a blob URL. */
function typedMedia(name: string, file: File, kind: MediaKind): Blob {
  if (kind === "pdf") return new Blob([file], { type: "application/pdf" });
  const audioType = kind === "audio" ? audioContentType(name) : undefined;
  return audioType === undefined ? file : new Blob([file], { type: audioType });
}

/**
 * Owns the viewer buffers and their file IO. Reads always apply a timeout so the Promise settles
 * even if the read hangs, and a per-key generation guard keeps a slow response from overwriting newer
 * content. The active buffer is re-read on an interval so external edits (from the claude code side)
 * are reflected; when the content is unchanged the buffer keeps its reference and does not re-render.
 */
export function useViewer(
  filesApi: FilesApi,
  activeViewerKey: string | null,
): Viewer {
  const [buffers, setBuffers] = useState<ViewerBuffers>({});
  const buffersRef = useRef(buffers);
  buffersRef.current = buffers;
  const readSeqRef = useRef<Record<string, number>>({});
  // The version each ready buffer's content was read at, so a poll of an unchanged file transfers nothing.
  const versionsRef = useRef<Record<string, string>>({});
  // Keys whose latest non-silent read has not settled yet: a poll superseding it reports its error instead.
  const awaitingVisibleReadRef = useRef<Set<string>>(new Set());
  const objectUrlsRef = useRef<Record<string, string>>({});
  const droppedFilesRef = useRef<Record<string, File>>({});

  const revokeObjectUrl = useCallback((key: string): void => {
    const url = objectUrlsRef.current[key];
    if (url === undefined) return;
    URL.revokeObjectURL(url);
    delete objectUrlsRef.current[key];
  }, []);

  const loadFile = useCallback(
    (
      key: string,
      repoPath: string,
      relPath: string,
      encoding: TextEncoding,
      silent: boolean,
    ) => {
      const seq = (readSeqRef.current[key] ?? 0) + 1;
      readSeqRef.current[key] = seq;
      if (!silent) awaitingVisibleReadRef.current.add(key);
      const ctrl = new AbortController();
      const timer = window.setTimeout(() => ctrl.abort(), FILE_READ_TIMEOUT_MS);
      const showsContent = buffersRef.current[key]?.status === "ready";
      const knownVersion =
        silent && showsContent ? versionsRef.current[key] : undefined;
      return filesApi
        .read(repoPath, relPath, encoding, ctrl.signal, knownVersion)
        .then(
          (read) => {
            if (readSeqRef.current[key] !== seq) return;
            awaitingVisibleReadRef.current.delete(key);
            if (read === null) return;
            if (read.version === null) delete versionsRef.current[key];
            else versionsRef.current[key] = read.version;
            setBuffers((cur) => bufferLoaded(cur, key, read.content));
          },
          (e: unknown) => {
            if (readSeqRef.current[key] !== seq) return;
            const visible = awaitingVisibleReadRef.current.delete(key);
            if (visible) delete versionsRef.current[key];
            setBuffers((cur) => {
              if (!visible || cur[key]?.status === "ready") return cur;
              return bufferFailed(cur, key, readErrorMessage(e));
            });
          },
        )
        .finally(() => window.clearTimeout(timer));
    },
    [filesApi],
  );

  const ensureBuffer = useCallback(
    (
      repoPath: string,
      relPath: string,
      encoding: TextEncoding = "utf8",
    ): string => {
      const key = viewerKey(repoPath, relPath);
      let shouldLoad = false;
      setBuffers((prev) => {
        if (prev[key] !== undefined) return prev;
        shouldLoad = true;
        return openBuffer(prev, repoPath, relPath, encoding);
      });
      if (shouldLoad) void loadFile(key, repoPath, relPath, encoding, false);
      return key;
    },
    [loadFile],
  );

  const ensureMediaBuffer = useCallback(
    (repoPath: string, relPath: string, kind: MediaKind): string => {
      const url = filesApi.mediaUrl(repoPath, relPath);
      setBuffers((prev) =>
        openMediaBuffer(prev, repoPath, relPath, { kind, url }),
      );
      return viewerKey(repoPath, relPath);
    },
    [filesApi],
  );

  const openExternal = useCallback((name: string, content: string): string => {
    const key = externalTextKey(name, content);
    setBuffers((prev) => openExternalBuffer(prev, key, name, content));
    return key;
  }, []);

  const openExternalMedia = useCallback(
    (name: string, file: File, kind: MediaKind): string => {
      const key = externalMediaKey(name, file);
      revokeObjectUrl(key);
      const url = URL.createObjectURL(typedMedia(name, file, kind));
      objectUrlsRef.current[key] = url;
      droppedFilesRef.current[key] = file;
      setBuffers((prev) =>
        openExternalMediaBuffer(prev, key, name, { kind, url }),
      );
      return key;
    },
    [revokeObjectUrl],
  );

  const closeBuffer = useCallback(
    (key: string): void => {
      revokeObjectUrl(key);
      delete droppedFilesRef.current[key];
      delete versionsRef.current[key];
      setBuffers((prev) => dropBuffer(prev, key));
    },
    [revokeObjectUrl],
  );

  const loadDroppedMediaText = useCallback(
    (key: string, buf: ViewerBuffer): void => {
      const settle = (next: (cur: ViewerBuffers) => ViewerBuffers): void =>
        setBuffers((cur) => {
          const b = cur[key];
          return b?.status === "loading" && b.media?.url === buf.media?.url
            ? next(cur)
            : cur;
        });
      const readFailed = (): void =>
        settle((cur) =>
          bufferFailed(
            cur,
            key,
            i18n.t("viewer.dropReadFailed", { name: buf.relPath }),
          ),
        );
      const file = droppedFilesRef.current[key];
      if (file === undefined) {
        readFailed();
        return;
      }
      void readPickedFile(file).then((picked) => {
        if ("content" in picked) {
          settle((cur) => bufferLoaded(cur, key, picked.content));
        } else if (picked.error === "tooLarge") {
          const error = i18n.t("viewer.dropTooLarge", { name: buf.relPath });
          settle((cur) => bufferFailed(cur, key, error));
        } else {
          readFailed();
        }
      });
    },
    [],
  );

  const togglePreview = useCallback(
    (key: string): void => {
      const toggled = bufferTogglePreview(buffersRef.current, key);
      buffersRef.current = toggled;
      setBuffers((prev) => bufferTogglePreview(prev, key));
      const buf = toggled[key];
      if (buf?.media === undefined || buf.status !== "loading") return;
      if (buf.external === true) loadDroppedMediaText(key, buf);
      else void loadFile(key, buf.repoPath, buf.relPath, "utf8", false);
    },
    [loadFile, loadDroppedMediaText],
  );

  const setEncoding = useCallback(
    (key: string, encoding: TextEncoding): void => {
      const buf = buffersRef.current[key];
      if (buf === undefined || !shouldPollBuffer(buf)) return;
      // Updated ahead of the render so a poll firing in between already reads with the new encoding.
      buffersRef.current = bufferSetEncoding(buffersRef.current, key, encoding);
      setBuffers((prev) => bufferSetEncoding(prev, key, encoding));
      void loadFile(key, buf.repoPath, buf.relPath, encoding, false);
    },
    [loadFile],
  );

  const showText = useCallback((key: string): void => {
    setBuffers((prev) => bufferShowText(prev, key));
  }, []);

  const pathOf = useCallback((key: string): string | null => {
    const buf = buffersRef.current[key];
    if (buf === undefined || buf.external === true) return null;
    return `${buf.repoPath}/${buf.relPath}`;
  }, []);

  useEffect(() => {
    if (activeViewerKey === null) return;
    const key = activeViewerKey;
    let inflight = false;
    const tick = (): void => {
      if (inflight) return;
      const buf = buffersRef.current[key];
      if (buf === undefined || !shouldPollBuffer(buf)) return;
      inflight = true;
      const encoding = encodingOf(buf);
      void loadFile(key, buf.repoPath, buf.relPath, encoding, true).finally(
        () => {
          inflight = false;
        },
      );
    };
    const id = window.setInterval(tick, FILE_POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [activeViewerKey, loadFile]);

  useEffect(() => {
    const urls = objectUrlsRef.current;
    return () => {
      for (const url of Object.values(urls)) URL.revokeObjectURL(url);
    };
  }, []);

  return {
    buffers,
    ensureBuffer,
    ensureMediaBuffer,
    openExternal,
    openExternalMedia,
    closeBuffer,
    togglePreview,
    setEncoding,
    showText,
    pathOf,
  };
}
