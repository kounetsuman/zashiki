/**
 * State and transitions for the diff tabs' open files (pure functions).
 * One buffer per tab (tab-model kind:"diff"). The key is diffKey; it equals the tab's id and
 * encodes the side first so a newline inside relPath cannot shift it. Being read-only, a buffer
 * holds only the two versions last read plus the chosen layout. IO (fetch) happens on the App/api
 * side; realtime reflection is driven by polling re-firing diffLoaded.
 */

import type { GitDiffResponse } from "@zashiki/shared";

export type DiffStatus = "loading" | "ready" | "error";
export type DiffLayout = "unified" | "split";

/** Which pair of versions to diff; also selects the git command server-side. */
export type DiffSide = "staged" | "changed" | "untracked";

export interface DiffBuffer {
  readonly repoPath: string;
  readonly relPath: string;
  readonly side: DiffSide;
  readonly status: DiffStatus;
  /** The versions last read. null until the first load settles. */
  readonly payload: GitDiffResponse | null;
  readonly error?: string;
  readonly layout: DiffLayout;
}

export type DiffBuffers = Readonly<Record<string, DiffBuffer>>;

/** A `??` untracked entry is always on the changed side; a tracked change may be staged or not. */
export function diffSide(staged: boolean, untracked: boolean): DiffSide {
  return untracked ? "untracked" : staged ? "staged" : "changed";
}

export function sideStaged(side: DiffSide): boolean {
  return side === "staged";
}

export function sideUntracked(side: DiffSide): boolean {
  return side === "untracked";
}

const SIDE_CODE: Record<DiffSide, string> = {
  staged: "s",
  changed: "c",
  untracked: "u",
};

/** Composite key = the tab id. Side goes first so a newline inside relPath can't shift the parse. */
export function diffKey(
  repoPath: string,
  relPath: string,
  side: DiffSide,
): string {
  return `${SIDE_CODE[side]}\n${repoPath}\n${relPath}`;
}

function samePayload(a: GitDiffResponse, b: GitDiffResponse): boolean {
  return (
    a.oldText === b.oldText &&
    a.newText === b.newText &&
    a.binary === b.binary &&
    a.tooLarge === b.tooLarge &&
    a.added === b.added &&
    a.removed === b.removed
  );
}

function patch(
  bufs: DiffBuffers,
  key: string,
  next: (b: DiffBuffer) => DiffBuffer,
): DiffBuffers {
  const b = bufs[key];
  if (b === undefined) return bufs;
  const nb = next(b);
  if (nb === b) return bufs;
  return { ...bufs, [key]: nb };
}

/** Opens a diff (adds it in loading state if not open; leaves an existing one unchanged). */
export function openDiffBuffer(
  bufs: DiffBuffers,
  repoPath: string,
  relPath: string,
  side: DiffSide,
): DiffBuffers {
  const key = diffKey(repoPath, relPath, side);
  if (bufs[key] !== undefined) return bufs;
  return {
    ...bufs,
    [key]: {
      repoPath,
      relPath,
      side,
      status: "loading",
      payload: null,
      layout: "unified",
    },
  };
}

/**
 * Load complete. When polling re-fires with identical versions, returns the same reference so the
 * CodeMirror merge view is not torn down and rebuilt (which would lose scroll position).
 */
export function diffLoaded(
  bufs: DiffBuffers,
  key: string,
  payload: GitDiffResponse,
): DiffBuffers {
  return patch(bufs, key, (b) =>
    b.status === "ready" &&
    b.payload !== null &&
    samePayload(b.payload, payload)
      ? b
      : { ...b, status: "ready", payload, error: undefined },
  );
}

export function diffFailed(
  bufs: DiffBuffers,
  key: string,
  error: string,
): DiffBuffers {
  return patch(bufs, key, (b) => ({ ...b, status: "error", error }));
}

export function diffToggleLayout(bufs: DiffBuffers, key: string): DiffBuffers {
  return patch(bufs, key, (b) => ({
    ...b,
    layout: b.layout === "unified" ? "split" : "unified",
  }));
}

export function closeDiffBuffer(bufs: DiffBuffers, key: string): DiffBuffers {
  if (bufs[key] === undefined) return bufs;
  const { [key]: _removed, ...rest } = bufs;
  return rest;
}
