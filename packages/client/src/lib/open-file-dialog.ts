import { invoke, isTauri } from "@tauri-apps/api/core";

import { type LocalFile, localFileOf } from "../viewer/open-local-files.js";

/** One file chosen in the native picker, as described by the desktop shell before it is read. */
type PickedFile =
  | { id: number; name: string; size: number; lastModified: number }
  | { name: string; error: "readFailed" };

/** Reads a picked file's bytes back from the shell only when it is opened (the text cap needs no read). */
export function localFileOfPicked(
  picked: PickedFile,
  readBytes: (id: number) => Promise<ArrayBuffer | number[]>,
): LocalFile {
  if ("error" in picked) {
    return {
      name: picked.name,
      size: 0,
      read: () => Promise.reject(new Error(picked.error)),
    };
  }
  return {
    name: picked.name,
    size: picked.size,
    read: async () =>
      // Tauri's postMessage fallback delivers raw bytes as a number array instead of an ArrayBuffer.
      new File([new Uint8Array(await readBytes(picked.id))], picked.name, {
        lastModified: picked.lastModified,
      }),
  };
}

function pickViaInput(): Promise<LocalFile[]> {
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
      cleanup();
      resolve(files.map(localFileOf));
    });
    input.click();
  });
}

/**
 * Cmd+O: opens the native file picker (several files may be chosen) and returns each chosen file in
 * order, or an empty list if the user cancels. Under Tauri a Rust command sets the localized dialog
 * title; in a browser it falls back to a hidden file input (the title is not settable there).
 */
export async function pickFiles(title: string): Promise<LocalFile[]> {
  if (isTauri()) {
    const picked = await invoke<PickedFile[]>("pick_files", { title });
    return picked.map((file) =>
      localFileOfPicked(file, (id) =>
        invoke<ArrayBuffer | number[]>("read_picked_file", { id }),
      ),
    );
  }
  return pickViaInput();
}
