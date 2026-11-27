import { invoke, isTauri } from "@tauri-apps/api/core";

import type { FileDropError } from "../ui/useFileDrop.js";
import {
  MEDIA_EXTENSIONS,
  type MediaKind,
  mediaKind,
} from "../viewer/media.js";

/** A file read as text: its content, or why it could not be read. */
export type PickedText =
  | { name: string; content: string }
  | { name: string; error: FileDropError };

/** One file chosen in the picker: its text, a media file to render, or why it could not be read. */
export type PickedFile =
  | PickedText
  | { name: string; media: File; kind: MediaKind };

/** What the desktop shell returns per file: a media file comes back as an id to fetch its bytes by. */
type ShellPickedFile = PickedText | { name: string; mediaId: number };

/** Size-checks a picked File against `maxBytes` and reads it as text (shared by the browser fallback and tests). */
export async function readPickedFile(
  file: File,
  maxBytes: number,
): Promise<PickedText> {
  if (file.size > maxBytes) {
    return { name: file.name, error: "tooLarge" };
  }
  try {
    return { name: file.name, content: await file.text() };
  } catch {
    return { name: file.name, error: "readFailed" };
  }
}

/** A picked File as media when its extension renders as media (no size cap, like a drop), else as text. */
function pickedFromBrowser(file: File, maxBytes: number): Promise<PickedFile> {
  const kind = mediaKind(file.name);
  if (kind !== null)
    return Promise.resolve({ name: file.name, media: file, kind });
  return readPickedFile(file, maxBytes);
}

/** Opens the readable files in pick order (so the last one ends up in front) and reports the rest. */
export function openPickedFiles(
  picked: readonly PickedFile[],
  onFile: (name: string, content: string) => void,
  onMedia: (name: string, file: File, kind: MediaKind) => void,
  onError: (name: string, error: FileDropError) => void,
): void {
  for (const file of picked) {
    if ("content" in file) onFile(file.name, file.content);
    else if ("media" in file) onMedia(file.name, file.media, file.kind);
    else onError(file.name, file.error);
  }
}

function pickViaInput(maxBytes: number): Promise<PickedFile[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.style.display = "none";
    document.body.appendChild(input);
    const cleanup = (): void => input.remove();
    // 'change' never fires on cancel; the 'cancel' event settles the promise and removes the input.
    input.addEventListener("cancel", () => {
      cleanup();
      resolve([]);
    });
    input.addEventListener("change", () => {
      const files = Array.from(input.files ?? []);
      const reads = files.map((file) => pickedFromBrowser(file, maxBytes));
      void Promise.all(reads).then((picked) => {
        cleanup();
        resolve(picked);
      });
    });
    input.click();
  });
}

async function fetchShellMedia(
  name: string,
  mediaId: number,
): Promise<PickedFile> {
  const kind = mediaKind(name);
  if (kind === null) return { name, error: "readFailed" };
  try {
    const bytes = await invoke<ArrayBuffer>("read_picked_media", { mediaId });
    return { name, media: new File([bytes], name), kind };
  } catch {
    return { name, error: "readFailed" };
  }
}

function fromShell(picked: readonly ShellPickedFile[]): Promise<PickedFile[]> {
  return Promise.all(
    picked.map((file) =>
      "mediaId" in file
        ? fetchShellMedia(file.name, file.mediaId)
        : Promise.resolve(file),
    ),
  );
}

/**
 * Cmd+O: opens the native file picker (several files may be chosen) and returns each chosen file in
 * order, or an empty list if the user cancels. Under Tauri a Rust command sets the localized dialog
 * title; in a browser it falls back to a hidden file input (the title is not settable there).
 */
export async function pickAndReadFiles(
  title: string,
  maxBytes: number,
): Promise<PickedFile[]> {
  if (isTauri()) {
    return fromShell(
      await invoke<ShellPickedFile[]>("pick_and_read_files", {
        title,
        maxBytes,
        mediaExtensions: MEDIA_EXTENSIONS,
      }),
    );
  }
  return pickViaInput(maxBytes);
}

/** Reads the files macOS has handed to the app since the last call (Tauri only). */
export async function takeOpenedFiles(maxBytes: number): Promise<PickedFile[]> {
  return fromShell(
    await invoke<ShellPickedFile[]>("take_opened_files", {
      maxBytes,
      mediaExtensions: MEDIA_EXTENSIONS,
    }),
  );
}
