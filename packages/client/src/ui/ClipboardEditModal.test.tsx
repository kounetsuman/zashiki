// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClipboardEditModal } from "./ClipboardEditModal.js";

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
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
  render(
    <ClipboardEditModal
      text={overrides.text ?? "claude \\\n  --flag"}
      enabled={overrides.enabled ?? true}
      onSetEnabled={onSetEnabled}
      onClose={onClose}
    />,
  );
  return { onClose, onSetEnabled };
}

describe("ClipboardEditModal", () => {
  it("prefills the textarea with the copied selection and shows the title", () => {
    renderModal();
    expect(screen.getByText("クリップボード編集")).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "claude \\\n  --flag",
    );
  });

  it("strips trailing whitespace from each prefilled line, keeping indentation", () => {
    renderModal({ text: "claude   \n  --flag\t" });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "claude\n  --flag",
    );
  });

  it("numbers every line so newlines are visible", () => {
    renderModal({ text: "a\nb\nc" });
    const gutter = document.querySelector(".clip-edit-gutter");
    expect(gutter?.textContent).toBe("1\n2\n3");
  });

  it("shows the inline description", () => {
    renderModal();
    expect(screen.getByText(/折り返された1行コマンド/)).toBeTruthy();
  });

  it("closes without touching the clipboard when the close button is pressed", () => {
    const { onClose } = renderModal();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "claude --flag" },
    });
    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    expect(writeText).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("dismisses on Escape from the focused textarea without writing to the clipboard", () => {
    const { onClose } = renderModal();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("turns the setting off when 'don't show again' is checked", () => {
    const { onSetEnabled } = renderModal({ enabled: true });
    const box = screen.getByRole("checkbox") as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(onSetEnabled).toHaveBeenCalledWith(false);
  });
});
