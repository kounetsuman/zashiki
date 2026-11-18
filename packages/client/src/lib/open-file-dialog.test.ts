import { describe, expect, it, vi } from "vitest";

import { localFileOfPicked } from "./open-file-dialog.js";

const picked = {
  id: 4,
  name: "Hero.aiff",
  path: "/System/Library/Sounds/Hero.aiff",
  size: 5,
  lastModified: 1234,
};

describe("localFileOfPicked", () => {
  it("streams media from the shell's URL for the picked path, without reading it", () => {
    const readBytes = vi.fn();
    const file = localFileOfPicked(picked, {
      streamUrl: (path) => `asset://localhost/${encodeURIComponent(path)}`,
      readBytes,
    });
    expect(file).toMatchObject({
      name: "Hero.aiff",
      size: 5,
      media: {
        url: "asset://localhost/%2FSystem%2FLibrary%2FSounds%2FHero.aiff",
        size: 5,
        lastModified: 1234,
      },
    });
    expect(readBytes).not.toHaveBeenCalled();
  });

  it("reads the bytes by id only when read, keeping name and mtime", async () => {
    const readBytes = vi.fn(() =>
      Promise.resolve(new TextEncoder().encode("hello").buffer),
    );
    const file = localFileOfPicked(picked, { streamUrl: String, readBytes });
    if ("error" in file) throw new Error("expected a readable file");
    const read = await file.read();
    expect(readBytes).toHaveBeenCalledWith(4);
    expect(read.name).toBe("Hero.aiff");
    expect(read.lastModified).toBe(1234);
    expect(await read.text()).toBe("hello");
  });

  it("accepts the bytes as a number array (the IPC postMessage fallback)", async () => {
    const file = localFileOfPicked(picked, {
      streamUrl: String,
      readBytes: () => Promise.resolve([104, 105]),
    });
    if ("error" in file) throw new Error("expected a readable file");
    expect(await (await file.read()).text()).toBe("hi");
  });

  it("passes on a file the shell could not resolve as its error", () => {
    expect(
      localFileOfPicked(
        { name: "gone.md", error: "readFailed" },
        { streamUrl: String, readBytes: vi.fn() },
      ),
    ).toEqual({ name: "gone.md", error: "readFailed" });
  });
});
