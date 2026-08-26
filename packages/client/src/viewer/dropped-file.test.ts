import { describe, expect, it } from "vitest";

import { dragCarriesFiles, droppedFiles } from "./dropped-file.js";

function transfer(types: string[], files: unknown[] = []): DataTransfer {
  return { types, files } as unknown as DataTransfer;
}

describe("dragCarriesFiles", () => {
  it("is true only when the drag advertises OS files", () => {
    expect(dragCarriesFiles(transfer(["Files"]))).toBe(true);
    expect(dragCarriesFiles(transfer(["text/plain"]))).toBe(false);
    expect(dragCarriesFiles(null)).toBe(false);
  });
});

describe("droppedFiles", () => {
  it("returns the files of a file drop", () => {
    const file = { name: "a.txt" };
    expect(droppedFiles(transfer(["Files"], [file]))).toEqual([file]);
  });

  it("returns [] for an in-page drag carrying no files", () => {
    expect(droppedFiles(transfer(["text/plain"], []))).toEqual([]);
    expect(droppedFiles(null)).toEqual([]);
  });
});
