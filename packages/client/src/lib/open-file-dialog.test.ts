import { FILE_MAX_BYTES } from "@zashiki/shared";
import { describe, expect, it } from "vitest";

import { readPickedFile } from "./open-file-dialog.js";

function fakeFile(over: Partial<File> & { size: number }): File {
  return {
    name: "note.txt",
    text: () => Promise.resolve("hello"),
    ...over,
  } as unknown as File;
}

describe("readPickedFile", () => {
  it("returns the name and text for a file within the limit", async () => {
    const picked = await readPickedFile(fakeFile({ size: 5, name: "a.md" }));
    expect(picked).toEqual({ name: "a.md", content: "hello" });
  });

  it("rejects with tooLarge past the size limit", async () => {
    await expect(
      readPickedFile(fakeFile({ size: FILE_MAX_BYTES + 1 })),
    ).rejects.toThrow("tooLarge");
  });

  it("rejects with readFailed when the read throws", async () => {
    await expect(
      readPickedFile(
        fakeFile({ size: 5, text: () => Promise.reject(new Error("io")) }),
      ),
    ).rejects.toThrow("readFailed");
  });
});
