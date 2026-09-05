// @vitest-environment jsdom
import {
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClipboardEditModal } from "./ClipboardEditModal.js";

// The editor is now CodeMirror; text/indent/search behavior is the pure specs
// (clipboard-edit-indent.test.ts, clipboard-edit-modal.test.ts, editor-search.test.ts). This suite
// covers the React shell only.

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  localStorage.clear();
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});

afterEach(cleanup);

function renderModal(
  overrides: Partial<{ enabled: boolean; text: string }> = {},
) {
  const onClose = vi.fn();
  const onSetEnabled = vi.fn();
  const utils = render(
    <ClipboardEditModal
      text={overrides.text ?? "claude \\\n  --flag"}
      enabled={overrides.enabled ?? true}
      onSetEnabled={onSetEnabled}
      onClose={onClose}
    />,
  );
  return { onClose, onSetEnabled, ...utils };
}

describe("ClipboardEditModal", () => {
  it("shows the title and the inline description", () => {
    renderModal();
    expect(screen.getByText("クリップボード編集")).toBeTruthy();
    expect(screen.getByText(/折り返された1行コマンド/)).toBeTruthy();
  });

  it("mounts the CodeMirror editor so Ctrl+F find works like the Memo editor", () => {
    const { container } = renderModal();
    expect(container.querySelector(".clip-edit-cm .cm-editor")).toBeTruthy();
  });

  it("closes without touching the clipboard when the close button is pressed", () => {
    const { onClose } = renderModal();
    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    expect(writeText).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("closes when the backdrop is clicked", () => {
    const { onClose, container } = renderModal();
    fireEvent.click(
      container.querySelector(".clip-edit-backdrop") as HTMLElement,
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("dismisses on Escape without writing to the clipboard", () => {
    const { onClose } = renderModal();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("stays open when Escape was already consumed by the editor (closing the search panel)", () => {
    const { onClose } = renderModal();
    const dialog = screen.getByRole("dialog");
    const escapeEvent = createEvent.keyDown(dialog, { key: "Escape" });
    escapeEvent.preventDefault();
    fireEvent(dialog, escapeEvent);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("turns the setting off when 'don't show again' is checked", () => {
    const { onSetEnabled } = renderModal({ enabled: true });
    const box = screen.getByRole("checkbox") as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(onSetEnabled).toHaveBeenCalledWith(false);
  });

  it("persists the tab indent unit across opens", () => {
    const { unmount } = renderModal({ text: "a\nb" });
    fireEvent.click(screen.getByRole("radio", { name: "タブ" }));
    unmount();
    renderModal({ text: "a" });
    expect(
      (screen.getByRole("radio", { name: "タブ" }) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it("persists the chosen space width across opens", () => {
    const { unmount } = renderModal({ text: "a" });
    fireEvent.change(screen.getByRole("combobox", { name: "幅" }), {
      target: { value: "4" },
    });
    unmount();
    renderModal({ text: "a" });
    expect(
      (screen.getByRole("combobox", { name: "幅" }) as HTMLSelectElement).value,
    ).toBe("4");
  });
});
