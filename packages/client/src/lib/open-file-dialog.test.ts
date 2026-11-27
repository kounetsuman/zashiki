import { beforeEach, describe, expect, it, vi } from "vitest";

import { MEDIA_EXTENSIONS } from "../viewer/media.js";

import {
  openPickedFiles,
  pickAndReadFiles,
  readPickedFile,
  takeOpenedFiles,
} from "./open-file-dialog.js";

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(
    (_cmd: string, _args: unknown): Promise<unknown> => Promise.resolve([]),
  ),
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
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue([]);
  });

  it("read text up to the configured maximum and hold the media extensions as media", async () => {
    await pickAndReadFiles("Open", MAX);
    await takeOpenedFiles(MAX);
    const options = { maxBytes: MAX, mediaExtensions: MEDIA_EXTENSIONS };
    expect(invoke.mock.calls).toEqual([
      ["pick_and_read_files", { title: "Open", ...options }],
      ["take_opened_files", options],
    ]);
  });

  it("fetch each held media file's bytes and hand it back as a File of its kind", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;
    invoke.mockImplementation((cmd: string) =>
      Promise.resolve(
        cmd === "read_picked_media"
          ? png
          : [
              { name: "a.md", content: "A" },
              { name: "shot.png", mediaId: 3, lastModified: 1234 },
              { name: "big.log", error: "tooLarge" },
            ],
      ),
    );
    for (const read of [
      () => pickAndReadFiles("Open", MAX),
      () => takeOpenedFiles(MAX),
    ]) {
      const picked = await read();
      expect(picked[0]).toEqual({ name: "a.md", content: "A" });
      expect(picked[2]).toEqual({ name: "big.log", error: "tooLarge" });
      const media = picked[1];
      if (media === undefined || !("media" in media)) {
        throw new Error("the png is not media");
      }
      expect(media.kind).toBe("image");
      expect(media.media.name).toBe("shot.png");
      expect(media.media.type).toBe("image/png");
      expect(media.media.lastModified).toBe(1234);
      expect(new Uint8Array(await media.media.arrayBuffer())).toEqual(
        new Uint8Array(png),
      );
    }
    expect(invoke).toHaveBeenCalledWith("read_picked_media", { mediaId: 3 });
  });

  it("report a held media file whose bytes cannot be fetched as unreadable", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === "read_picked_media"
        ? Promise.reject(new Error("readFailed"))
        : Promise.resolve([{ name: "shot.png", mediaId: 1, lastModified: 0 }]),
    );
    expect(await pickAndReadFiles("Open", MAX)).toEqual([
      { name: "shot.png", error: "readFailed" },
    ]);
  });
});

describe("media held by the shell", () => {
  beforeEach(() => invoke.mockReset());

  it("is fetched one file at a time, in pick order", async () => {
    const events: string[] = [];
    invoke.mockImplementation((cmd: string, args: unknown) => {
      if (cmd !== "read_picked_media") {
        return Promise.resolve([
          { name: "a.mp4", mediaId: 1, lastModified: 0 },
          { name: "b.mp4", mediaId: 2, lastModified: 0 },
        ]);
      }
      const { mediaId } = args as { mediaId: number };
      events.push(`start ${mediaId}`);
      return Promise.resolve().then(() => {
        events.push(`end ${mediaId}`);
        return new ArrayBuffer(1);
      });
    });
    const picked = await pickAndReadFiles("Open", MAX);
    expect(picked.map((p) => p.name)).toEqual(["a.mp4", "b.mp4"]);
    expect(events).toEqual(["start 1", "end 1", "start 2", "end 2"]);
  });

  it("is still fetched, releasing its id, when the page does not render the name as media", async () => {
    invoke.mockImplementation((cmd: string) =>
      Promise.resolve(
        cmd === "read_picked_media"
          ? new ArrayBuffer(1)
          : [{ name: "odd.bin", mediaId: 5, lastModified: 0 }],
      ),
    );
    expect(await pickAndReadFiles("Open", MAX)).toEqual([
      { name: "odd.bin", error: "readFailed" },
    ]);
    expect(invoke).toHaveBeenCalledWith("read_picked_media", { mediaId: 5 });
  });
});

describe("openPickedFiles", () => {
  it("opens readable files in pick order and reports each unreadable one by name", () => {
    const pngFile = new File([], "shot.png");
    const events: string[] = [];
    openPickedFiles(
      [
        { name: "a.md", content: "A" },
        { name: "big.log", error: "tooLarge" },
        { name: "shot.png", media: pngFile, kind: "image" },
        { name: "b.md", content: "B" },
        { name: "gone.md", error: "readFailed" },
      ],
      (name, content) => events.push(`open ${name}=${content}`),
      (name, file, kind) =>
        events.push(`media ${name} ${kind} ${String(file === pngFile)}`),
      (name, error) => events.push(`fail ${name} ${error}`),
    );
    expect(events).toEqual([
      "open a.md=A",
      "fail big.log tooLarge",
      "media shot.png image true",
      "open b.md=B",
      "fail gone.md readFailed",
    ]);
  });

  it("does nothing for a cancelled pick", () => {
    const onFile = vi.fn();
    const onMedia = vi.fn();
    const onError = vi.fn();
    openPickedFiles([], onFile, onMedia, onError);
    expect(onFile).not.toHaveBeenCalled();
    expect(onMedia).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
