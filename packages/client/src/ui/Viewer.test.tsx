// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ViewerBuffer } from "../viewer/viewer-model.js";
import { Viewer } from "./Viewer.js";

const base: ViewerBuffer = {
  repoPath: "/ws/repo",
  relPath: "src/app.ts",
  status: "ready",
  content: "export {}\n",
  preview: false,
};

const noop = () => undefined;

afterEach(cleanup);

describe("Viewer", () => {
  it("shows the shared loading UI while loading", () => {
    render(
      <Viewer
        buffer={{ ...base, status: "loading", content: null }}
        onTogglePreview={noop}
        onCopyPath={noop}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("読み込み中");
  });

  it("shows the error message on error", () => {
    render(
      <Viewer
        buffer={{ ...base, status: "error", error: "file not found" }}
        onTogglePreview={noop}
        onCopyPath={noop}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("file not found");
  });

  it("has no save button since it is read-only", () => {
    render(<Viewer buffer={base} onTogglePreview={noop} onCopyPath={noop} />);
    expect(screen.queryByRole("button", { name: /保存/ })).toBeNull();
  });

  it("has no refresh button since it is read-only (realtime is polling)", () => {
    render(<Viewer buffer={base} onTogglePreview={noop} onCopyPath={noop} />);
    expect(screen.queryByRole("button", { name: "更新" })).toBeNull();
  });

  it("calls onCopyPath via the copy button", () => {
    const onCopyPath = vi.fn();
    render(
      <Viewer buffer={base} onTogglePreview={noop} onCopyPath={onCopyPath} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "パスをコピー" }));
    expect(onCopyPath).toHaveBeenCalled();
  });

  it("does not show the preview toggle for non-Markdown", () => {
    render(<Viewer buffer={base} onTogglePreview={noop} onCopyPath={noop} />);
    expect(screen.queryByRole("button", { name: "プレビュー" })).toBeNull();
  });

  it("shows the toggle for Markdown and renders with markdown-it in preview mode", () => {
    render(
      <Viewer
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

  it("focuses its main-area section when the focus nonce changes", () => {
    const { container, rerender } = render(
      <Viewer
        buffer={base}
        onTogglePreview={noop}
        onCopyPath={noop}
        focusNonce={0}
      />,
    );
    const section = container.querySelector(".viewer-view");
    expect(section?.getAttribute("tabindex")).toBe("-1");

    rerender(
      <Viewer
        buffer={base}
        onTogglePreview={noop}
        onCopyPath={noop}
        focusNonce={1}
      />,
    );
    expect(document.activeElement).toBe(section);
  });

  it("calls onTogglePreview on toggle click", () => {
    const onTogglePreview = vi.fn();
    render(
      <Viewer
        buffer={{ ...base, relPath: "README.md" }}
        onTogglePreview={onTogglePreview}
        onCopyPath={noop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "プレビュー" }));
    expect(onTogglePreview).toHaveBeenCalled();
  });

  it("renders an image buffer as <img> pointing at the media URL", () => {
    const { container } = render(
      <Viewer
        buffer={{
          ...base,
          relPath: "assets/logo.png",
          content: null,
          media: { kind: "image", url: "blob:img-1" },
        }}
        onTogglePreview={noop}
        onCopyPath={noop}
      />,
    );
    const img = container.querySelector("img.viewer-media");
    expect(img?.getAttribute("src")).toBe("blob:img-1");
  });

  it("renders a video buffer as <video controls>", () => {
    const { container } = render(
      <Viewer
        buffer={{
          ...base,
          relPath: "clip.mp4",
          content: null,
          media: { kind: "video", url: "blob:vid-1" },
        }}
        onTogglePreview={noop}
        onCopyPath={noop}
      />,
    );
    const video = container.querySelector("video.viewer-media");
    expect(video?.getAttribute("src")).toBe("blob:vid-1");
    expect(video?.hasAttribute("controls")).toBe(true);
  });
});
