// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClipboardEditModal } from "./ClipboardEditModal.js";

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

function tab(el: HTMLTextAreaElement, opts: { shift?: boolean } = {}) {
  fireEvent.keyDown(el, { key: "Tab", shiftKey: opts.shift ?? false });
}

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

  it("indents every selected line with the default two spaces on Tab", () => {
    renderModal({ text: "a\nb" });
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    ta.setSelectionRange(0, ta.value.length);
    tab(ta);
    expect(ta.value).toBe("  a\n  b");
  });

  it("removes one indent level from every selected line on Shift+Tab", () => {
    renderModal({ text: "    a\n  b" });
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    ta.setSelectionRange(0, ta.value.length);
    tab(ta, { shift: true });
    expect(ta.value).toBe("  a\nb");
  });

  it("indents with a tab once the tab unit is selected, and persists the choice", () => {
    const { unmount } = render(
      <ClipboardEditModal
        text={"a\nb"}
        enabled
        onSetEnabled={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "タブ" }));
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    ta.setSelectionRange(0, ta.value.length);
    tab(ta);
    expect(ta.value).toBe("\ta\n\tb");

    unmount();
    render(
      <ClipboardEditModal
        text="a"
        enabled
        onSetEnabled={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(
      (screen.getByRole("radio", { name: "タブ" }) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it("indents by the chosen space width and persists it", () => {
    const { unmount } = renderModal({ text: "a" });
    fireEvent.change(screen.getByRole("combobox", { name: "幅" }), {
      target: { value: "4" },
    });
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    ta.setSelectionRange(0, ta.value.length);
    tab(ta);
    expect(ta.value).toBe("    a");

    unmount();
    renderModal({ text: "a" });
    expect(
      (screen.getByRole("combobox", { name: "幅" }) as HTMLSelectElement).value,
    ).toBe("4");
  });
});
