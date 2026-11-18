import { FILE_MAX_BYTES } from "@zashiki/shared";

import { type MediaKind, mediaKind } from "./media.js";

export type LocalFileError = "tooLarge" | "readFailed";

/** A file from outside the repos (dropped from Finder or chosen with Cmd+O), read only once it is opened. */
export interface LocalFile {
  readonly name: string;
  readonly size: number;
  read(): Promise<File>;
}

export interface LocalFileHandlers {
  onText(name: string, content: string): void;
  onMedia(name: string, file: File, kind: MediaKind): void;
  onError(name: string, error: LocalFileError): void;
}

export function localFileOf(file: File): LocalFile {
  return {
    name: file.name,
    size: file.size,
    read: () => Promise.resolve(file),
  };
}

type ReadResult =
  | { readonly text: string }
  | { readonly media: File; readonly kind: MediaKind }
  | { readonly error: LocalFileError };

async function readLocalFile(file: LocalFile): Promise<ReadResult> {
  const kind = mediaKind(file.name);
  if (kind === null && file.size > FILE_MAX_BYTES) return { error: "tooLarge" };
  try {
    const read = await file.read();
    return kind === null ? { text: await read.text() } : { media: read, kind };
  } catch {
    return { error: "readFailed" };
  }
}

/**
 * Opens files in order (so the last one ends up in front): images, videos, audio and PDFs as media
 * with no size cap, anything else as text up to FILE_MAX_BYTES.
 */
export async function openLocalFiles(
  files: readonly LocalFile[],
  handlers: LocalFileHandlers,
): Promise<void> {
  for (const file of files) {
    const read = await readLocalFile(file);
    if ("error" in read) handlers.onError(file.name, read.error);
    else if ("text" in read) handlers.onText(file.name, read.text);
    else handlers.onMedia(file.name, read.media, read.kind);
  }
}
