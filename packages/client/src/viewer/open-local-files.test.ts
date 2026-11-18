import { FILE_MAX_BYTES } from "@zashiki/shared";
import { describe, expect, it, vi } from "vitest";

import { type LocalFile, openLocalFiles } from "./open-local-files.js";

function localFile(
  name: string,
  over: { size?: number; read?: () => Promise<File> } = {},
): LocalFile {
  const file = new File([`content of ${name}`], name);
  return {
    name,
    size: over.size ?? file.size,
    read: over.read ?? (() => Promise.resolve(file)),
  };
}

function recorder() {
  const events: string[] = [];
  return {
    events,
    handlers: {
      onText: (name: string, content: string) =>
        events.push(`text ${name}=${content}`),
      onMedia: (name: string, _file: File, kind: string) =>
        events.push(`media ${name} ${kind}`),
      onError: (name: string, error: string) =>
        events.push(`error ${name} ${error}`),
    },
  };
}

describe("openLocalFiles", () => {
  it("opens media as media and other files as text, in order", async () => {
    const { events, handlers } = recorder();
    await openLocalFiles(
      [localFile("Hero.aiff"), localFile("a.md"), localFile("clip.mp4")],
      handlers,
    );
    expect(events).toEqual([
      "media Hero.aiff audio",
      "text a.md=content of a.md",
      "media clip.mp4 video",
    ]);
  });

  it("rejects text past the size cap without reading it, but not media", async () => {
    const { events, handlers } = recorder();
    const read = vi.fn(() => Promise.resolve(new File([""], "big.log")));
    await openLocalFiles(
      [
        localFile("big.log", { size: FILE_MAX_BYTES + 1, read }),
        localFile("movie.mov", { size: FILE_MAX_BYTES + 1 }),
      ],
      handlers,
    );
    expect(read).not.toHaveBeenCalled();
    expect(events).toEqual(["error big.log tooLarge", "media movie.mov video"]);
  });

  it("reports readFailed when a file cannot be read, and keeps going", async () => {
    const { events, handlers } = recorder();
    const gone = () => Promise.reject(new Error("io"));
    await openLocalFiles(
      [
        localFile("gone.md", { read: gone }),
        localFile("gone.png", { read: gone }),
        localFile("b.md"),
      ],
      handlers,
    );
    expect(events).toEqual([
      "error gone.md readFailed",
      "error gone.png readFailed",
      "text b.md=content of b.md",
    ]);
  });

  it("opens a text file whose content is an error code as text", async () => {
    const { events, handlers } = recorder();
    await openLocalFiles(
      [
        localFile("note.txt", {
          read: () => Promise.resolve(new File(["tooLarge"], "note.txt")),
        }),
      ],
      handlers,
    );
    expect(events).toEqual(["text note.txt=tooLarge"]);
  });
});
