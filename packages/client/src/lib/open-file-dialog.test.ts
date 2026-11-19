import { describe, expect, it, vi } from "vitest";

import {
  openPickedFiles,
  pickAndReadFiles,
  readPickedFile,
  takeOpenedFiles,
} from "./open-file-dialog.js";

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn((_cmd: string, _args: unknown) => Promise.resolve([])),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke }));

/** A configured maximum, so the tests show the limit comes from the caller. */
const MAX = 5 * 1024 * 1024;

function fakeFile(over: Partial<File> & { size: number }): File {
  return {
    name: "note.txt",
    text: () => Promise.resolve("hello"),
    ...over,
  } as unknown as File;
}

describe("readPickedFile", () => {
  it("returns the name and text for a file within the limit", async () => {
    const picked = await readPickedFile(
      fakeFile({ size: MAX, name: "a.md" }),
      MAX,
    );
    expect(picked).toEqual({ name: "a.md", content: "hello" });
  });

  it("reports tooLarge with the name past the size limit", async () => {
    const picked = await readPickedFile(
      fakeFile({ size: MAX + 1, name: "big.log" }),
      MAX,
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
      MAX,
    );
    expect(picked).toEqual({ name: "gone.md", error: "readFailed" });
  });
});

describe("the Tauri open dialog and Open With", () => {
  it("read up to the configured maximum", async () => {
    await pickAndReadFiles("Open", MAX);
    await takeOpenedFiles(MAX);
    expect(invoke.mock.calls).toEqual([
      ["pick_and_read_files", { title: "Open", maxBytes: MAX }],
      ["take_opened_files", { maxBytes: MAX }],
    ]);
  });
});

describe("openPickedFiles", () => {
  it("opens readable files in pick order and reports each unreadable one by name", () => {
    const events: string[] = [];
    openPickedFiles(
      [
        { name: "a.md", content: "A" },
        { name: "big.log", error: "tooLarge" },
        { name: "b.md", content: "B" },
        { name: "gone.md", error: "readFailed" },
      ],
      (name, content) => events.push(`open ${name}=${content}`),
      (name, error) => events.push(`fail ${name} ${error}`),
    );
    expect(events).toEqual([
      "open a.md=A",
      "fail big.log tooLarge",
      "open b.md=B",
      "fail gone.md readFailed",
    ]);
  });

  it("does nothing for a cancelled pick", () => {
    const onFile = vi.fn();
    const onError = vi.fn();
    openPickedFiles([], onFile, onError);
    expect(onFile).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
