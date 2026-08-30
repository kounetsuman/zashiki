import { useCallback, useEffect, useRef, useState } from "react";
import type { FilesApi } from "../api/files.js";
import i18n from "../i18n/index.js";
import type { MediaKind } from "../viewer/media.js";
import {
  bufferFailed,
  bufferLoaded,
  bufferTogglePreview,
  closeBuffer as dropBuffer,
  externalViewerKey,
  openBuffer,
  openExternalBuffer,
  openExternalMediaBuffer,
  openMediaBuffer,
  shouldPollBuffer,
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
  ensureBuffer(repoPath: string, relPath: string): string;
  /** Ensures a repo image/video buffer streamed from the media URL (no text read) and returns its key. */
  ensureMediaBuffer(repoPath: string, relPath: string, kind: MediaKind): string;
  /** Opens a dropped file from content already in hand (no repo read) and returns its key. */
  openExternal(name: string, content: string): string;
  /** Opens a dropped image/video from an object URL created for the file, and returns its key. */
  openExternalMedia(name: string, file: File, kind: MediaKind): string;
  closeBuffer(key: string): void;
  togglePreview(key: string): void;
  /** Absolute path of the buffer at key, or null when it is gone. */
  pathOf(key: string): string | null;
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
  const objectUrlsRef = useRef<Record<string, string>>({});

  const revokeObjectUrl = useCallback((key: string): void => {
    const url = objectUrlsRef.current[key];
    if (url === undefined) return;
    URL.revokeObjectURL(url);
    delete objectUrlsRef.current[key];
  }, []);

  const loadFile = useCallback(
    (key: string, repoPath: string, relPath: string, silent: boolean) => {
      const seq = (readSeqRef.current[key] ?? 0) + 1;
      readSeqRef.current[key] = seq;
      const ctrl = new AbortController();
      const timer = window.setTimeout(() => ctrl.abort(), FILE_READ_TIMEOUT_MS);
      return filesApi
        .read(repoPath, relPath, ctrl.signal)
        .then(
          (content) =>
            setBuffers((cur) =>
              readSeqRef.current[key] === seq
                ? bufferLoaded(cur, key, content)
                : cur,
            ),
          (e: unknown) =>
            setBuffers((cur) => {
              if (readSeqRef.current[key] !== seq) return cur;
              if (silent || cur[key]?.status === "ready") return cur;
              return bufferFailed(cur, key, readErrorMessage(e));
            }),
        )
        .finally(() => window.clearTimeout(timer));
    },
    [filesApi],
  );

  const ensureBuffer = useCallback(
    (repoPath: string, relPath: string): string => {
      const key = viewerKey(repoPath, relPath);
      let shouldLoad = false;
      setBuffers((prev) => {
        if (prev[key] !== undefined) return prev;
        shouldLoad = true;
        return openBuffer(prev, repoPath, relPath);
      });
      if (shouldLoad) void loadFile(key, repoPath, relPath, false);
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
    setBuffers((prev) => openExternalBuffer(prev, name, content));
    return externalViewerKey(name);
  }, []);

  const openExternalMedia = useCallback(
    (name: string, file: File, kind: MediaKind): string => {
      const key = externalViewerKey(name);
      revokeObjectUrl(key);
      const url = URL.createObjectURL(file);
      objectUrlsRef.current[key] = url;
      setBuffers((prev) => openExternalMediaBuffer(prev, name, { kind, url }));
      return key;
    },
    [revokeObjectUrl],
  );

  const closeBuffer = useCallback(
    (key: string): void => {
      revokeObjectUrl(key);
      setBuffers((prev) => dropBuffer(prev, key));
    },
    [revokeObjectUrl],
  );

  const togglePreview = useCallback((key: string): void => {
    setBuffers((prev) => bufferTogglePreview(prev, key));
  }, []);

  const pathOf = useCallback((key: string): string | null => {
    const buf = buffersRef.current[key];
    if (buf === undefined) return null;
    return buf.external ? buf.relPath : `${buf.repoPath}/${buf.relPath}`;
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
      void loadFile(key, buf.repoPath, buf.relPath, true).finally(() => {
        inflight = false;
      });
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
    pathOf,
  };
}
