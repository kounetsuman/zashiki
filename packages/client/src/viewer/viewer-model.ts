/**
 * The state and transitions of the viewer's open files (pure functions).
 * One buffer per tab (tab-model kind:"viewer"). The key is viewerKey (repoPath joined with
 * the repo-relative path; kept equal to the tab's id). Being read-only, it holds no edit
 * state, only the content last read. Side effects (read) happen on the App/api side; this
 * holds only state transitions. Realtime reflection is driven by polling re-firing bufferLoaded.
 */

export type BufferStatus = "loading" | "ready" | "error";

export interface ViewerBuffer {
  readonly repoPath: string;
  readonly relPath: string;
  readonly status: BufferStatus;
  /** The content last read. null if not yet loaded. */
  readonly content: string | null;
  readonly error?: string;
  /** Whether the Markdown preview is showing (meaningful only for .md; toggle). */
  readonly preview: boolean;
  /** Content was supplied directly (e.g. a file dropped from Finder), not read from a repo. */
  readonly external?: boolean;
}

export type ViewerBuffers = Readonly<Record<string, ViewerBuffer>>;

/** The composite key matching the tab's id (repoPath and repo-relative path joined by a newline). */
export function viewerKey(repoPath: string, relPath: string): string {
  return `${repoPath}\n${relPath}`;
}

/** Inverse of viewerKey: splits a viewer tab id back into its repoPath and repo-relative path. */
export function splitViewerKey(key: string): {
  repoPath: string;
  relPath: string;
} {
  const nl = key.indexOf("\n");
  return nl < 0
    ? { repoPath: key, relPath: "" }
    : { repoPath: key.slice(0, nl), relPath: key.slice(nl + 1) };
}

/** Markdown-family extensions (preview targets). */
export function isMarkdown(relPath: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(relPath);
}

/** Sentinel repoPath for a buffer that belongs to no repo (dropped file). */
export const EXTERNAL_VIEWER_REPO = "";

/** Key for an external (dropped) file, keyed by its name so re-dropping the same name refreshes in place. */
export function externalViewerKey(name: string): string {
  return viewerKey(EXTERNAL_VIEWER_REPO, name);
}

/** Whether the buffer is re-read on the poll interval. External buffers hold no repo path to read from. */
export function shouldPollBuffer(buf: ViewerBuffer): boolean {
  return buf.external !== true;
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
      preview: false,
    },
  };
}

/** Inserts (or refreshes) a ready buffer whose content is supplied directly, bypassing the repo read path. */
export function openExternalBuffer(
  bufs: ViewerBuffers,
  name: string,
  content: string,
): ViewerBuffers {
  const key = externalViewerKey(name);
  const existing = bufs[key];
  if (existing?.status === "ready" && existing.content === content) return bufs;
  return {
    ...bufs,
    [key]: {
      repoPath: EXTERNAL_VIEWER_REPO,
      relPath: name,
      status: "ready",
      content,
      preview: existing?.preview ?? false,
      external: true,
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

export function bufferTogglePreview(
  bufs: ViewerBuffers,
  key: string,
): ViewerBuffers {
  return patch(bufs, key, (b) => ({ ...b, preview: !b.preview }));
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
