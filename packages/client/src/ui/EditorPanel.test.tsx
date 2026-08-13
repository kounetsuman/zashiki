// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EditorBuffer } from "../editor/editor-model.js";
import { EditorPanel } from "./EditorPanel.js";

const base: EditorBuffer = {
  repoPath: "/ws/repo",
  relPath: "src/app.ts",
  status: "ready",
  content: "export {}\n",
  preview: false,
};

const noop = () => undefined;

afterEach(cleanup);

describe("EditorPanel", () => {
  it("shows the shared loading UI while loading", () => {
    render(
      <EditorPanel
        buffer={{ ...base, status: "loading", content: null }}
        onTogglePreview={noop}
        onCopyPath={noop}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("読み込み中");
  });

  it("shows the error message on error", () => {
    render(
      <EditorPanel
        buffer={{ ...base, status: "error", error: "file not found" }}
        onTogglePreview={noop}
        onCopyPath={noop}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("file not found");
  });

  it("has no save button since it is read-only", () => {
    render(
      <EditorPanel buffer={base} onTogglePreview={noop} onCopyPath={noop} />,
    );
    expect(screen.queryByRole("button", { name: /保存/ })).toBeNull();
  });

  it("has no refresh button since it is read-only (realtime is polling)", () => {
    render(
      <EditorPanel buffer={base} onTogglePreview={noop} onCopyPath={noop} />,
    );
    expect(screen.queryByRole("button", { name: "更新" })).toBeNull();
  });

  it("calls onCopyPath via the copy button", () => {
    const onCopyPath = vi.fn();
    render(
      <EditorPanel
        buffer={base}
        onTogglePreview={noop}
        onCopyPath={onCopyPath}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "パスをコピー" }));
    expect(onCopyPath).toHaveBeenCalled();
  });

  it("does not show the preview toggle for non-Markdown", () => {
    render(
      <EditorPanel buffer={base} onTogglePreview={noop} onCopyPath={noop} />,
    );
    expect(screen.queryByRole("button", { name: "プレビュー" })).toBeNull();
  });

  it("shows the toggle for Markdown and renders with markdown-it in preview mode", () => {
    render(
      <EditorPanel
        buffer={{
          ...base,
          relPath: "README.md",
          content: "# 見出し\n",
          preview: true,
        }}
        onTogglePreview={noop}
        onCopyPath={noop}
      />,
    );
    // In preview mode the toggle shows "Code".
    expect(screen.getByRole("button", { name: "コード" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain(
      "見出し",
    );
  });

  it("calls onTogglePreview on toggle click", () => {
    const onTogglePreview = vi.fn();
    render(
      <EditorPanel
        buffer={{ ...base, relPath: "README.md" }}
        onTogglePreview={onTogglePreview}
        onCopyPath={noop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "プレビュー" }));
    expect(onTogglePreview).toHaveBeenCalled();
  });
});
