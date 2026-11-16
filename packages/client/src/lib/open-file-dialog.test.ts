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

  it("reports tooLarge with the name past the size limit", async () => {
    const picked = await readPickedFile(
      fakeFile({ size: FILE_MAX_BYTES + 1, name: "big.log" }),
    );
    expect(picked).toEqual({ name: "big.log", error: "tooLarge" });
  });

  it("reports readFailed with the name when the read throws", async () => {
    const picked = await readPickedFile(
      fakeFile({
        size: 5,
        name: "gone.md",
        text: () => Promise.reject(new Error("io")),
      }),
    );
    expect(picked).toEqual({ name: "gone.md", error: "readFailed" });
  });
});
