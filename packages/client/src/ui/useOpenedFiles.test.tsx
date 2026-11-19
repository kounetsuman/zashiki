// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { FILE_MAX_BYTES } from "@zashiki/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PickedFile } from "../lib/open-file-dialog.js";
import { useOpenedFiles } from "./useOpenedFiles.js";

const { isTauri, invoke } = vi.hoisted(() => ({
  isTauri: vi.fn(() => true),
  invoke: vi.fn((_cmd: string, _args: unknown) =>
    Promise.resolve<PickedFile[]>([]),
  ),
}));
const { listen, unlisten } = vi.hoisted(() => {
  const unlisten = vi.fn();
  return {
    unlisten,
    listen: vi.fn((_event: string, _handler: () => void) =>
      Promise.resolve(unlisten),
    ),
  };
});

vi.mock("@tauri-apps/api/core", () => ({ isTauri, invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

function Probe(props: {
  onPicked: (picked: PickedFile[]) => void;
  onFailed?: () => void;
}) {
  useOpenedFiles(props.onPicked, props.onFailed ?? vi.fn());
  return null;
}

const signal = (): void => {
  const handler = listen.mock.calls[0]?.[1];
  if (handler === undefined) throw new Error("not subscribed");
  handler();
};

beforeEach(() => {
  isTauri.mockReturnValue(true);
  invoke.mockReset();
  invoke.mockResolvedValue([]);
  listen.mockClear();
  unlisten.mockClear();
});
afterEach(cleanup);

describe("useOpenedFiles", () => {
  it("takes the files handed over before the page loaded, after it starts listening", async () => {
    const order: string[] = [];
    listen.mockImplementationOnce((event) => {
      order.push(`listen ${event}`);
      return Promise.resolve(unlisten);
    });
    invoke.mockImplementationOnce((cmd, args) => {
      order.push(`invoke ${cmd} ${JSON.stringify(args)}`);
      return Promise.resolve([{ name: "2026-11-19.md", content: "# digest" }]);
    });
    const onPicked = vi.fn();
    render(<Probe onPicked={onPicked} />);
    await vi.waitFor(() =>
      expect(onPicked).toHaveBeenCalledWith([
        { name: "2026-11-19.md", content: "# digest" },
      ]),
    );
    expect(order).toEqual([
      "listen zashiki:files-opened",
      `invoke take_opened_files {"maxBytes":${FILE_MAX_BYTES}}`,
    ]);
  });

  it("takes the files again each time the shell signals new ones", async () => {
    const onPicked = vi.fn();
    render(<Probe onPicked={onPicked} />);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    invoke.mockResolvedValueOnce([{ name: "b.md", error: "tooLarge" }]);
    signal();
    await vi.waitFor(() =>
      expect(onPicked).toHaveBeenCalledWith([
        { name: "b.md", error: "tooLarge" },
      ]),
    );
  });

  it("opens the takes in arrival order even when an earlier read finishes later", async () => {
    let finishFirst: (picked: PickedFile[]) => void = () => undefined;
    invoke.mockImplementationOnce(
      () =>
        new Promise<PickedFile[]>((resolve) => {
          finishFirst = resolve;
        }),
    );
    const onPicked = vi.fn();
    render(<Probe onPicked={onPicked} />);
    await vi.waitFor(() => expect(listen).toHaveBeenCalled());
    invoke.mockResolvedValueOnce([{ name: "b.md", content: "B" }]);
    signal();
    await Promise.resolve();
    finishFirst([{ name: "a.md", content: "A" }]);
    await vi.waitFor(() => expect(onPicked).toHaveBeenCalledTimes(2));
    expect(onPicked.mock.calls.map(([picked]) => picked[0].name)).toEqual([
      "a.md",
      "b.md",
    ]);
  });

  it("keeps taking after a handler throws", async () => {
    invoke.mockResolvedValueOnce([{ name: "a.md", content: "A" }]);
    const onPicked = vi.fn(() => {
      throw new Error("boom");
    });
    render(<Probe onPicked={onPicked} />);
    await vi.waitFor(() => expect(onPicked).toHaveBeenCalledTimes(1));
    invoke.mockResolvedValueOnce([{ name: "b.md", content: "B" }]);
    signal();
    await vi.waitFor(() => expect(onPicked).toHaveBeenCalledTimes(2));
  });

  it("stays quiet when nothing is waiting", async () => {
    const onPicked = vi.fn();
    render(<Probe onPicked={onPicked} />);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    await invoke.mock.results[0]?.value;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onPicked).not.toHaveBeenCalled();
  });

  it("reports a failed take instead of dropping it", async () => {
    invoke.mockRejectedValueOnce(new Error("not allowed"));
    const onFailed = vi.fn();
    render(<Probe onPicked={vi.fn()} onFailed={onFailed} />);
    await vi.waitFor(() => expect(onFailed).toHaveBeenCalledTimes(1));
  });

  it("reports a failed subscription, since files handed over later would go unseen", async () => {
    listen.mockRejectedValueOnce(new Error("not allowed"));
    const onFailed = vi.fn();
    render(<Probe onPicked={vi.fn()} onFailed={onFailed} />);
    await vi.waitFor(() => expect(onFailed).toHaveBeenCalledTimes(1));
  });

  it("unsubscribes on unmount", async () => {
    const { unmount } = render(<Probe onPicked={vi.fn()} />);
    unmount();
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalled());
  });

  it("does nothing outside the Tauri shell, where macOS cannot hand files over", () => {
    isTauri.mockReturnValue(false);
    render(<Probe onPicked={vi.fn()} />);
    expect(listen).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
});
