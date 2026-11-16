import { invoke, isTauri } from "@tauri-apps/api/core";
import { FILE_MAX_BYTES } from "@zashiki/shared";

/** Why a picked file could not be opened. */
export type PickFileError = "tooLarge" | "readFailed";

/** One file chosen in the picker: its text, or why it could not be read. */
export type PickedFile =
  | { name: string; content: string }
  | { name: string; error: PickFileError };

/** Size-checks a picked File and reads it as text (shared by the browser fallback and tests). */
export async function readPickedFile(file: File): Promise<PickedFile> {
  if (file.size > FILE_MAX_BYTES) {
    return { name: file.name, error: "tooLarge" };
  }
  try {
    return { name: file.name, content: await file.text() };
  } catch {
    return { name: file.name, error: "readFailed" };
  }
}

function pickViaInput(): Promise<PickedFile[]> {
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
      void Promise.all(files.map(readPickedFile)).then((picked) => {
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
export async function pickAndReadFiles(title: string): Promise<PickedFile[]> {
  if (isTauri()) {
    return invoke<PickedFile[]>("pick_and_read_files", {
      title,
      maxBytes: FILE_MAX_BYTES,
    });
  }
  return pickViaInput();
}
