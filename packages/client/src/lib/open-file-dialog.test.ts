import { describe, expect, it, vi } from "vitest";

import { localFileOfPicked } from "./open-file-dialog.js";

describe("localFileOfPicked", () => {
  it("reads the picked bytes from the shell only when opened, keeping name and mtime", async () => {
    const readBytes = vi.fn(() =>
      Promise.resolve(new TextEncoder().encode("hello").buffer),
    );
    const file = localFileOfPicked(
      { id: 4, name: "Hero.aiff", size: 5, lastModified: 1234 },
      readBytes,
    );
    expect(file.size).toBe(5);
    expect(readBytes).not.toHaveBeenCalled();
    const read = await file.read();
    expect(readBytes).toHaveBeenCalledWith(4);
    expect(read.name).toBe("Hero.aiff");
    expect(read.lastModified).toBe(1234);
    expect(await read.text()).toBe("hello");
  });

  it("accepts the bytes as a number array (the IPC postMessage fallback)", async () => {
    const file = localFileOfPicked(
      { id: 1, name: "a.txt", size: 2, lastModified: 0 },
      () => Promise.resolve([104, 105]),
    );
    expect(await (await file.read()).text()).toBe("hi");
  });

  it("turns a file the shell could not resolve into one whose read fails", async () => {
    const readBytes = vi.fn();
    const file = localFileOfPicked(
      { name: "gone.md", error: "readFailed" },
      readBytes,
    );
    await expect(file.read()).rejects.toThrow();
    expect(readBytes).not.toHaveBeenCalled();
  });
});
