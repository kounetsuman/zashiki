import { FILE_MAX_BYTES } from "@zashiki/shared";

import { type MediaKind, mediaKind } from "./media.js";

export type LocalFileError = "tooLarge" | "readFailed";

/** Media the WebView streams from a URL (a file chosen with Cmd+O), with what identifies its tab. */
export interface StreamedMedia {
  readonly url: string;
  readonly size: number;
  readonly lastModified: number;
}

/**
 * A file from outside the repos (dropped from Finder or chosen with Cmd+O). Media is shown from
 * `media` without reading it into memory; anything else is read as text only once it is opened.
 */
export type LocalFile =
  | {
      readonly name: string;
      readonly size: number;
      readonly media: File | StreamedMedia;
      read(): Promise<File>;
    }
  | { readonly name: string; readonly error: LocalFileError };

export interface LocalFileHandlers {
  onText(name: string, content: string): void;
  onMedia(name: string, media: File | StreamedMedia, kind: MediaKind): void;
  onError(name: string, error: LocalFileError): void;
}

export function localFileOf(file: File): LocalFile {
  return {
    name: file.name,
    size: file.size,
    media: file,
    read: () => Promise.resolve(file),
  };
}

type OpenResult =
  | { readonly text: string }
  | { readonly media: File | StreamedMedia; readonly kind: MediaKind }
  | { readonly error: LocalFileError };

async function resolveLocalFile(file: LocalFile): Promise<OpenResult> {
  if ("error" in file) return { error: file.error };
  const kind = mediaKind(file.name);
  if (kind !== null) return { media: file.media, kind };
  if (file.size > FILE_MAX_BYTES) return { error: "tooLarge" };
  try {
    return { text: await (await file.read()).text() };
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
    const opened = await resolveLocalFile(file);
    if ("error" in opened) handlers.onError(file.name, opened.error);
    else if ("text" in opened) handlers.onText(file.name, opened.text);
    else handlers.onMedia(file.name, opened.media, opened.kind);
  }
}
