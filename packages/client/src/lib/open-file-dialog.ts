import { invoke, isTauri } from "@tauri-apps/api/core";

import type { FileDropError } from "../ui/useFileDrop.js";

/** One file chosen in the picker: its text, or why it could not be read. */
export type PickedFile =
  | { name: string; content: string }
  | { name: string; error: FileDropError };

/** Size-checks a picked File against `maxBytes` and reads it as text (shared by the browser fallback and tests). */
export async function readPickedFile(
  file: File,
  maxBytes: number,
): Promise<PickedFile> {
  if (file.size > maxBytes) {
    return { name: file.name, error: "tooLarge" };
  }
  try {
    return { name: file.name, content: await file.text() };
  } catch {
    return { name: file.name, error: "readFailed" };
  }
}

/** Opens the readable files in pick order (so the last one ends up in front) and reports the rest. */
export function openPickedFiles(
  picked: readonly PickedFile[],
  onFile: (name: string, content: string) => void,
  onError: (name: string, error: FileDropError) => void,
): void {
  for (const file of picked) {
    if ("content" in file) onFile(file.name, file.content);
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
      const reads = files.map((file) => readPickedFile(file, maxBytes));
      void Promise.all(reads).then((picked) => {
        cleanup();
        resolve(picked);
      });
    });
    input.click();
  });
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
    return invoke<PickedFile[]>("pick_and_read_files", { title, maxBytes });
  }
  return pickViaInput(maxBytes);
}

/** Reads the files macOS has handed to the app since the last call (Tauri only). */
export function takeOpenedFiles(maxBytes: number): Promise<PickedFile[]> {
  return invoke<PickedFile[]>("take_opened_files", { maxBytes });
}
