// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { FileEntry, FileListScope } from "@zashiki/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FilesListApi } from "../api/files-list.js";
import { QuickOpen } from "./QuickOpen.js";

afterEach(cleanup);

function entry(relPath: string, org = "org1"): FileEntry {
  return { org, repo: "repo-a", path: `/ws/${org}/repo-a/${relPath}`, relPath };
}

const FILES = [
  entry("src/App.tsx"),
  entry("src/app-store.ts"),
  entry("docs/readme.md"),
];

const OTHER_ORG_FILES = [entry("src/Other.tsx", "org2")];

/** Serves the active org for a workspace listing, and org2 for a path under /ws/org2/. */
function fakeApi() {
  return {
    list: vi.fn(async (scope: FileListScope) => ({
      truncated: false,
      home: "/home/me",
      files:
        scope.kind === "path" && scope.dir.startsWith("/ws/org2/")
          ? OTHER_ORG_FILES
          : FILES,
    })),
  } satisfies FilesListApi;
}

async function renderPalette(
  over: Partial<Parameters<typeof QuickOpen>[0]> = {},
) {
  const onOpen = vi.fn();
  const onClose = vi.fn();
  const api = fakeApi();
  const utils = render(
    <QuickOpen
      api={api}
      activeCwd="/ws/org1/repo-a/src"
      onOpen={onOpen}
      onClose={onClose}
      {...over}
    />,
  );
  const input = utils.container.querySelector(
    ".quickopen-input",
  ) as HTMLInputElement;
  const rows = (): HTMLElement[] =>
    Array.from(utils.container.querySelectorAll(".quickopen-row"));
  await waitFor(() => expect(rows().length).toBeGreaterThan(0));
  return { ...utils, api, onOpen, onClose, input, rows };
}

describe("QuickOpen", () => {
  it("lists the active workspace initially and fuzzy-filters on input", async () => {
    const { api, input, rows } = await renderPalette();
    expect(api.list).toHaveBeenCalledWith(
      { kind: "workspace", cwd: "/ws/org1/repo-a/src" },
      expect.any(AbortSignal),
    );
    expect(rows()).toHaveLength(3);
    fireEvent.change(input, { target: { value: "app" } });
    const names = rows().map((r) => r.textContent ?? "");
    expect(names.some((n) => n.includes("App.tsx"))).toBe(true);
    expect(names.some((n) => n.includes("app-store.ts"))).toBe(true);
    expect(names.some((n) => n.includes("readme.md"))).toBe(false);
  });

  it("opens the highlighted row on Enter, parsing a :line suffix", async () => {
    const { input, onOpen } = await renderPalette();
    fireEvent.change(input, { target: { value: "App.tsx:42" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ relPath: "src/App.tsx" }),
      42,
    );
  });

  it("moves the selection with the arrow keys", async () => {
    const { input, rows, onOpen } = await renderPalette();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(rows()[1]?.getAttribute("data-selected")).toBe("true");
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("opens a row on click with no line when none was typed", async () => {
    const { rows, onOpen } = await renderPalette();
    fireEvent.click(rows()[0] as HTMLElement);
    expect(onOpen).toHaveBeenCalledWith(expect.anything(), null);
  });

  it("shows the empty state when nothing matches", async () => {
    const { input, rows, container } = await renderPalette();
    fireEvent.change(input, { target: { value: "zzzznomatch" } });
    expect(rows()).toHaveLength(0);
    expect(container.querySelector(".quickopen-empty")).not.toBeNull();
  });

  it("lists a typed full path across orgs, refetching only when the directory changes", async () => {
    const { api, input, rows, onOpen } = await renderPalette();
    fireEvent.change(input, { target: { value: "/ws/org2/repo-a/src/Oth" } });
    await waitFor(() =>
      expect(rows().map((r) => r.textContent)).toEqual([
        expect.stringContaining("Other.tsx"),
      ]),
    );
    expect(api.list).toHaveBeenLastCalledWith(
      { kind: "path", dir: "/ws/org2/repo-a/src/" },
      expect.any(AbortSignal),
    );
    const calls = api.list.mock.calls.length;
    fireEvent.change(input, {
      target: { value: "/ws/org2/repo-a/src/Other.tsx:7" },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ org: "org2", relPath: "src/Other.tsx" }),
      7,
    );
    expect(api.list).toHaveBeenCalledTimes(calls);
  });

  it("retries a failed listing on the next keystroke", async () => {
    const api = fakeApi();
    api.list.mockRejectedValueOnce(new Error("server restarting"));
    const utils = render(
      <QuickOpen
        api={api}
        activeCwd={null}
        onOpen={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const input = utils.container.querySelector(
      ".quickopen-input",
    ) as HTMLInputElement;
    await waitFor(() =>
      expect(utils.container.querySelector(".quickopen-empty")).not.toBeNull(),
    );
    fireEvent.change(input, { target: { value: "readme" } });
    await waitFor(() =>
      expect(utils.container.querySelectorAll(".quickopen-row")).toHaveLength(
        1,
      ),
    );
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it("does not offer the previous scope's files while a typed path is being listed", async () => {
    const { input, rows, onOpen } = await renderPalette();
    fireEvent.change(input, { target: { value: "/ws/org1/repo-a/src/App" } });
    expect(rows()).toHaveLength(0);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpen).not.toHaveBeenCalled();
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
  });

  it("lets a retry finish instead of restarting it on every keystroke", async () => {
    const api = fakeApi();
    api.list
      .mockRejectedValueOnce(new Error("server restarting"))
      .mockReturnValueOnce(new Promise(() => {}));
    const utils = render(
      <QuickOpen
        api={api}
        activeCwd={null}
        onOpen={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const input = utils.container.querySelector(
      ".quickopen-input",
    ) as HTMLInputElement;
    await waitFor(() =>
      expect(utils.container.querySelector(".quickopen-empty")).not.toBeNull(),
    );
    fireEvent.change(input, { target: { value: "r" } });
    fireEvent.change(input, { target: { value: "re" } });
    fireEvent.change(input, { target: { value: "rea" } });
    expect(api.list).toHaveBeenCalledTimes(2);
  });
});
