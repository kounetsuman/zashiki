import { invoke, isTauri } from "@tauri-apps/api/core";
import { FILE_MAX_BYTES } from "@zashiki/shared";

export interface PickedFile {
  name: string;
  content: string;
}

/** Thrown when the chosen file exceeds the read limit or cannot be read. */
export type PickFileError = "tooLarge" | "readFailed";

/** Size-checks a picked File and reads it as text (shared by the browser fallback and tests). */
export async function readPickedFile(file: File): Promise<PickedFile> {
  if (file.size > FILE_MAX_BYTES) {
    throw new Error("tooLarge" satisfies PickFileError);
  }
  try {
    return { name: file.name, content: await file.text() };
  } catch {
    throw new Error("readFailed" satisfies PickFileError);
  }
}

function pickViaInput(): Promise<PickedFile | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.style.display = "none";
    document.body.appendChild(input);
    const cleanup = (): void => input.remove();
    // 'change' never fires on cancel; the 'cancel' event settles the promise and removes the input.
    input.addEventListener("cancel", () => {
      cleanup();
      resolve(null);
    });
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file === undefined) {
        cleanup();
        resolve(null);
        return;
      }
      readPickedFile(file).then(
        (picked) => {
          cleanup();
          resolve(picked);
        },
        (err) => {
          cleanup();
          reject(err);
        },
      );
    });
    input.click();
  });
}

/**
 * Cmd+O: opens the native file picker and returns the chosen file's name and content, or null if the
 * user cancels. Under Tauri a Rust command sets the localized dialog title; in a browser it falls back
 * to a hidden file input (the title is not settable there). Rejects with a `PickFileError` message.
 */
export async function pickAndReadFile(
  title: string,
): Promise<PickedFile | null> {
  if (isTauri()) {
    return (
      (await invoke<PickedFile | null>("pick_and_read_file", {
        title,
        maxBytes: FILE_MAX_BYTES,
      })) ?? null
    );
  }
  return pickViaInput();
}
