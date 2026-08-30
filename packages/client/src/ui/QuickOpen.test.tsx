// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { FileEntry } from "@zashiki/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

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

function renderPalette(over: Partial<Parameters<typeof QuickOpen>[0]> = {}) {
  const onOpen = vi.fn();
  const onClose = vi.fn();
  const utils = render(
    <QuickOpen
      files={FILES}
      activeOrg={null}
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
  return { ...utils, onOpen, onClose, input, rows };
}

describe("QuickOpen", () => {
  it("lists all files initially and fuzzy-filters on input", () => {
    const { input, rows } = renderPalette();
    expect(rows()).toHaveLength(3);
    fireEvent.change(input, { target: { value: "app" } });
    const names = rows().map((r) => r.textContent ?? "");
    expect(names.some((n) => n.includes("App.tsx"))).toBe(true);
    expect(names.some((n) => n.includes("app-store.ts"))).toBe(true);
    expect(names.some((n) => n.includes("readme.md"))).toBe(false);
  });

  it("opens the highlighted row on Enter, parsing a :line suffix", () => {
    const { input, onOpen } = renderPalette();
    fireEvent.change(input, { target: { value: "App.tsx:42" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ relPath: "src/App.tsx" }),
      42,
    );
  });

  it("moves the selection with the arrow keys", () => {
    const { input, rows, onOpen } = renderPalette();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(rows()[1]?.getAttribute("data-selected")).toBe("true");
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("opens a row on click with no line when none was typed", () => {
    const { rows, onOpen } = renderPalette();
    fireEvent.click(rows()[0] as HTMLElement);
    expect(onOpen).toHaveBeenCalledWith(expect.anything(), null);
  });

  it("shows the empty state when nothing matches", () => {
    const { input, rows, container } = renderPalette();
    fireEvent.change(input, { target: { value: "zzzznomatch" } });
    expect(rows()).toHaveLength(0);
    expect(container.querySelector(".quickopen-empty")).not.toBeNull();
  });
});
