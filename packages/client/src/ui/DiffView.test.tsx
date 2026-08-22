// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { GitDiffResponse } from "@zashiki/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiffBuffer } from "../diff/diff-model.js";
import { DiffView } from "./DiffView.js";

const noop = (): void => {};

const payload = (over: Partial<GitDiffResponse> = {}): GitDiffResponse => ({
  oldText: "a\nb\n",
  newText: "a\nc\n",
  binary: false,
  tooLarge: false,
  added: 1,
  removed: 1,
  ...over,
});

const buffer = (over: Partial<DiffBuffer> = {}): DiffBuffer => ({
  repoPath: "/ws/org1/repo-a",
  relPath: "src/app.ts",
  side: "changed",
  status: "ready",
  payload: payload(),
  layout: "unified",
  ...over,
});

function renderDiff(over: Partial<DiffBuffer> = {}, handlers = {}) {
  return render(
    <DiffView
      buffer={buffer(over)}
      onToggleLayout={noop}
      onCopyPath={noop}
      onOpenInEditor={noop}
      {...handlers}
    />,
  );
}

afterEach(cleanup);

describe("DiffView", () => {
  it("mounts the CodeMirror merge host for a ready unified diff", () => {
    const { container } = renderDiff();
    expect(container.querySelector(".diff-cm")).not.toBeNull();
    expect(container.querySelector(".cm-editor")).not.toBeNull();
    // +added / -removed appear in the header.
    expect(container.querySelector(".diff-stat-added")?.textContent).toBe("+1");
    expect(container.querySelector(".diff-stat-removed")?.textContent).toBe(
      "-1",
    );
  });

  it("mounts the split merge view without throwing", () => {
    const { container } = renderDiff({ layout: "split" });
    expect(container.querySelector(".cm-mergeView")).not.toBeNull();
  });

  it("toggles layout from the header button", () => {
    const onToggleLayout = vi.fn();
    const { container } = renderDiff({}, { onToggleLayout });
    fireEvent.click(container.querySelector(".diff-toggle") as HTMLElement);
    expect(onToggleLayout).toHaveBeenCalled();
  });

  it("copies the path from the header button", () => {
    const onCopyPath = vi.fn();
    const { container } = renderDiff({}, { onCopyPath });
    fireEvent.click(container.querySelector(".diff-copy") as HTMLElement);
    expect(onCopyPath).toHaveBeenCalled();
  });

  it("offers the external editor for a binary diff instead of rendering it", () => {
    const onOpenInEditor = vi.fn();
    const { container } = renderDiff(
      { payload: payload({ binary: true, oldText: "", newText: "" }) },
      { onOpenInEditor },
    );
    expect(container.querySelector(".diff-cm")).toBeNull();
    fireEvent.click(container.querySelector(".diff-open") as HTMLElement);
    expect(onOpenInEditor).toHaveBeenCalled();
  });

  it("offers the external editor for a too-large diff instead of rendering it", () => {
    const { container } = renderDiff({
      payload: payload({ tooLarge: true, oldText: "", newText: "" }),
    });
    expect(container.querySelector(".diff-cm")).toBeNull();
    expect(container.querySelector(".diff-open")).not.toBeNull();
  });

  it("shows the error body and no toggle when the fetch failed", () => {
    const { container } = renderDiff({
      status: "error",
      payload: null,
      error: "boom",
    });
    expect(screen.getByRole("alert").textContent).toContain("boom");
    expect(container.querySelector(".diff-toggle")).toBeNull();
  });
});
