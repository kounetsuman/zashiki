/**
 * The state and transitions of the viewer's open files (pure functions).
 * One buffer per tab (tab-model kind:"editor"). The key is editorKey (repoPath joined with
 * the repo-relative path; kept equal to the tab's id). Being read-only, it holds no edit
 * state, only the content last read. Side effects (read) happen on the App/api side; this
 * holds only state transitions. Realtime reflection is driven by polling re-firing bufferLoaded.
 */

export type BufferStatus = "loading" | "ready" | "error";

export interface EditorBuffer {
  readonly repoPath: string;
  readonly relPath: string;
  readonly status: BufferStatus;
  /** The content last read. null if not yet loaded. */
  readonly content: string | null;
  readonly error?: string;
  /** Whether the Markdown preview is showing (meaningful only for .md; toggle). */
  readonly preview: boolean;
}

export type EditorBuffers = Readonly<Record<string, EditorBuffer>>;

/** The composite key matching the tab's id (repoPath and repo-relative path joined by a newline). */
export function editorKey(repoPath: string, relPath: string): string {
  return `${repoPath}\n${relPath}`;
}

/** Markdown-family extensions (preview targets). */
export function isMarkdown(relPath: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(relPath);
}

function patch(
  bufs: EditorBuffers,
  key: string,
  next: (b: EditorBuffer) => EditorBuffer,
): EditorBuffers {
  const b = bufs[key];
  if (b === undefined) return bufs;
  const nb = next(b);
  if (nb === b) return bufs;
  return { ...bufs, [key]: nb };
}

/** Opens a file (adds it in loading state if not open; leaves an existing one unchanged). */
export function openBuffer(
  bufs: EditorBuffers,
  repoPath: string,
  relPath: string,
): EditorBuffers {
  const key = editorKey(repoPath, relPath);
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

/**
 * Load complete (content = what was read, ready). Even if polling re-fires with the same
 * value, returns the same reference when the content is unchanged (avoids wasteful re-render / CM replacement).
 */
export function bufferLoaded(
  bufs: EditorBuffers,
  key: string,
  content: string,
): EditorBuffers {
  return patch(bufs, key, (b) =>
    b.status === "ready" && b.content === content
      ? b
      : { ...b, status: "ready", content, error: undefined },
  );
}

export function bufferFailed(
  bufs: EditorBuffers,
  key: string,
  error: string,
): EditorBuffers {
  return patch(bufs, key, (b) => ({ ...b, status: "error", error }));
}

export function bufferTogglePreview(
  bufs: EditorBuffers,
  key: string,
): EditorBuffers {
  return patch(bufs, key, (b) => ({ ...b, preview: !b.preview }));
}

export function closeBuffer(bufs: EditorBuffers, key: string): EditorBuffers {
  if (bufs[key] === undefined) return bufs;
  const { [key]: _removed, ...rest } = bufs;
  return rest;
}
