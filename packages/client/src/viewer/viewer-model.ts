/**
 * The state and transitions of the viewer's open files (pure functions).
 * One buffer per tab (tab-model kind:"viewer"). The key is kept equal to the tab's id: viewerKey
 * for a repo file, externalTextKey / externalMediaKey for an external one. Being read-only, it holds no edit
 * state, only the content last read. Side effects (read) happen on the App/api side; this
 * holds only state transitions. Realtime reflection is driven by polling re-firing bufferLoaded.
 */

import type { TextEncoding } from "@zashiki/shared";

import { isDelimitedText } from "./delimited.js";
import type { MediaKind } from "./media.js";

export type BufferStatus = "loading" | "ready" | "error";

export interface MediaSource {
  readonly kind: MediaKind;
  readonly url: string;
}

export interface ViewerBuffer {
  readonly repoPath: string;
  readonly relPath: string;
  readonly status: BufferStatus;
  /** The content last read. null if not yet loaded; a media buffer reads it only once switched to its text. */
  readonly content: string | null;
  readonly error?: string;
  /** Whether the file's alternate rendering is showing (Markdown/HTML preview, the CSV/TSV table, or a media file's text). */
  readonly preview: boolean;
  /** Content was supplied directly (e.g. a file dropped from Finder), not read from a repo. */
  readonly external?: boolean;
  /** Present when the buffer is an image/video/audio/PDF; the Viewer renders it from the URL. */
  readonly media?: MediaSource;
  /** The encoding a repo text file is read with; absent means UTF-8. */
  readonly encoding?: TextEncoding;
}

export type ViewerBuffers = Readonly<Record<string, ViewerBuffer>>;

/** A file addressed by its repo checkout path and repo-relative path. */
export interface RepoFile {
  readonly repoPath: string;
  readonly relPath: string;
}

/** The composite key matching the tab's id (repoPath and repo-relative path joined by a newline). */
export function viewerKey(repoPath: string, relPath: string): string {
  return `${repoPath}\n${relPath}`;
}

/** Inverse of viewerKey: splits a viewer tab id back into its repoPath and repo-relative path. */
function splitViewerKey(key: string): RepoFile {
  const nl = key.indexOf("\n");
  return nl < 0
    ? { repoPath: key, relPath: "" }
    : { repoPath: key.slice(0, nl), relPath: key.slice(nl + 1) };
}

/** Markdown-family extensions (preview targets). */
export function isMarkdown(relPath: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(relPath);
}

/** HTML documents (rendered in a sandboxed iframe preview). */
export function isHtml(relPath: string): boolean {
  return /\.html?$/i.test(relPath);
}

/**
 * Delimited text and HTML open in their alternate rendering, since their raw form is the harder
 * one to read; Markdown opens as code.
 */
function opensInAlternateView(relPath: string): boolean {
  return isDelimitedText(relPath) || isHtml(relPath);
}

/** Sentinel repoPath for a buffer that belongs to no repo (dropped file). */
export const EXTERNAL_VIEWER_REPO = "";

/**
 * External files carry no folder path, so a fingerprint tells same-name files apart. It sits before
 * the name so the tab still reads as the file name.
 */
function externalViewerKey(name: string, fingerprint: string): string {
  return viewerKey(EXTERNAL_VIEWER_REPO, `${fingerprint}/${name}`);
}

/** FNV-1a over the text, plus its length to make a collision between two same-name files even less likely. */
function textFingerprint(content: string): string {
  let h = 2166136261;
  for (let i = 0; i < content.length; i++) {
    h ^= content.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${(h >>> 0).toString(16)}-${content.length}`;
}

/** Key for an external text file: the same name and content reopen its tab, anything else gets a new one. */
export function externalTextKey(name: string, content: string): string {
  return externalViewerKey(name, textFingerprint(content));
}

/** Key for external media, whose bytes are not read: told apart by size and modification time instead. */
export function externalMediaKey(
  name: string,
  file: Pick<File, "size" | "lastModified">,
): string {
  return externalViewerKey(name, `${file.size}-${file.lastModified}`);
}

/** The file name an external viewer key was built from (the fingerprint holds no "/"). */
export function externalNameOfViewerKey(key: string): string {
  const rest = splitViewerKey(key).relPath;
  return rest.slice(rest.indexOf("/") + 1);
}

/**
 * The repo file a viewer key denotes, or null for an external file — which belongs to no
 * repo, so no file action (reveal / copy absolute path / rename) can address it.
 */
export function repoFileOfViewerKey(key: string): RepoFile | null {
  const file = splitViewerKey(key);
  return file.repoPath === EXTERNAL_VIEWER_REPO ? null : file;
}

/**
 * Whether the buffer is re-read on the poll interval. External buffers hold no repo path to read from,
 * and media buffers render from a URL rather than a polled text read.
 */
export function shouldPollBuffer(buf: ViewerBuffer): boolean {
  return buf.external !== true && buf.media === undefined;
}

function patch(
  bufs: ViewerBuffers,
  key: string,
  next: (b: ViewerBuffer) => ViewerBuffer,
): ViewerBuffers {
  const b = bufs[key];
  if (b === undefined) return bufs;
  const nb = next(b);
  if (nb === b) return bufs;
  return { ...bufs, [key]: nb };
}

/** Opens a file (adds it in loading state if not open; leaves an existing one unchanged). */
export function openBuffer(
  bufs: ViewerBuffers,
  repoPath: string,
  relPath: string,
  encoding: TextEncoding = "utf8",
): ViewerBuffers {
  const key = viewerKey(repoPath, relPath);
  if (bufs[key] !== undefined) return bufs;
  return {
    ...bufs,
    [key]: {
      repoPath,
      relPath,
      status: "loading",
      content: null,
      preview: opensInAlternateView(relPath),
      ...(encoding === "utf8" ? {} : { encoding }),
    },
  };
}

/** Inserts a ready buffer whose content is supplied directly, bypassing the repo read path (an open one is left as is). */
export function openExternalBuffer(
  bufs: ViewerBuffers,
  key: string,
  name: string,
  content: string,
): ViewerBuffers {
  if (bufs[key] !== undefined) return bufs;
  return {
    ...bufs,
    [key]: {
      repoPath: EXTERNAL_VIEWER_REPO,
      relPath: name,
      status: "ready",
      content,
      preview: opensInAlternateView(name),
      external: true,
    },
  };
}

/** Opens (or refreshes) a repo file rendered as image/video/audio/PDF, streamed from `url` rather than read as text. */
export function openMediaBuffer(
  bufs: ViewerBuffers,
  repoPath: string,
  relPath: string,
  media: MediaSource,
): ViewerBuffers {
  const key = viewerKey(repoPath, relPath);
  if (bufs[key]?.media?.url === media.url) return bufs;
  return {
    ...bufs,
    [key]: {
      repoPath,
      relPath,
      status: "ready",
      content: null,
      preview: false,
      media,
    },
  };
}

/** Opens a dropped file rendered as image/video/audio/PDF from an object `url` (no repo read). */
export function openExternalMediaBuffer(
  bufs: ViewerBuffers,
  key: string,
  name: string,
  media: MediaSource,
): ViewerBuffers {
  return {
    ...bufs,
    [key]: {
      repoPath: EXTERNAL_VIEWER_REPO,
      relPath: name,
      status: "ready",
      content: null,
      preview: false,
      external: true,
      media,
    },
  };
}

/**
 * Load complete (content = what was read, ready). Even if polling re-fires with the same
 * value, returns the same reference when the content is unchanged (avoids wasteful re-render / CM replacement).
 */
export function bufferLoaded(
  bufs: ViewerBuffers,
  key: string,
  content: string,
): ViewerBuffers {
  return patch(bufs, key, (b) =>
    b.status === "ready" && b.content === content
      ? b
      : { ...b, status: "ready", content, error: undefined },
  );
}

export function bufferFailed(
  bufs: ViewerBuffers,
  key: string,
  error: string,
): ViewerBuffers {
  return patch(bufs, key, (b) => ({ ...b, status: "error", error }));
}

/**
 * Leaves the alternate rendering, the table having no place to point a line number at.
 * Revealing a line (search hit, quick open) needs the text view.
 */
export function bufferShowText(
  bufs: ViewerBuffers,
  key: string,
): ViewerBuffers {
  return patch(bufs, key, (b) => (b.preview ? { ...b, preview: false } : b));
}

/**
 * A media buffer's text is read on its first switch to it (loading). Switching back always shows the
 * media, even when that read failed or has not settled.
 */
export function bufferTogglePreview(
  bufs: ViewerBuffers,
  key: string,
): ViewerBuffers {
  return patch(bufs, key, (b) => {
    if (b.media === undefined) return { ...b, preview: !b.preview };
    if (b.preview)
      return { ...b, preview: false, status: "ready", error: undefined };
    return {
      ...b,
      preview: true,
      status: b.content === null ? "loading" : "ready",
    };
  });
}

/** Back to loading, so a failed re-read with the new encoding shows its error instead of the old text. */
export function bufferSetEncoding(
  bufs: ViewerBuffers,
  key: string,
  encoding: TextEncoding,
): ViewerBuffers {
  return patch(bufs, key, (b) =>
    encodingOf(b) === encoding
      ? b
      : { ...b, encoding, status: "loading", content: null, error: undefined },
  );
}

export function encodingOf(buf: ViewerBuffer): TextEncoding {
  return buf.encoding ?? "utf8";
}

export function closeBuffer(bufs: ViewerBuffers, key: string): ViewerBuffers {
  if (bufs[key] === undefined) return bufs;
  const { [key]: _removed, ...rest } = bufs;
  return rest;
}

/** Whether a buffer's `relPath` is the entry `rel` itself or lives under it (a directory subtree). */
function isRelUnder(relPath: string, rel: string): boolean {
  return relPath === rel || relPath.startsWith(`${rel}/`);
}

/** Keys of the buffers in `repoPath` at `rel` or under it (a file, or a directory and its subtree). */
export function viewerKeysUnderPath(
  bufs: ViewerBuffers,
  repoPath: string,
  rel: string,
): string[] {
  return Object.entries(bufs)
    .filter(([, b]) => b.repoPath === repoPath && isRelUnder(b.relPath, rel))
    .map(([key]) => key);
}

export interface RenamedViewer {
  /** Current key (before the rename). */
  key: string;
  /** repo-relative path after applying the rename. */
  newRelPath: string;
}

/**
 * For a rename of `oldRel` -> `newRel` in `repoPath`, the affected buffers and each one's new
 * repo-relative path (a file matches the exact buffer; a directory remaps its whole subtree).
 */
export function viewersAffectedByRename(
  bufs: ViewerBuffers,
  repoPath: string,
  oldRel: string,
  newRel: string,
): RenamedViewer[] {
  return Object.entries(bufs)
    .filter(([, b]) => b.repoPath === repoPath && isRelUnder(b.relPath, oldRel))
    .map(([key, b]) => ({
      key,
      newRelPath: newRel + b.relPath.slice(oldRel.length),
    }));
}
