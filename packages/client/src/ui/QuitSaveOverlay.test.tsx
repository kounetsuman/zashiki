// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { QuitSaveOverlay } from "./QuitSaveOverlay.js";

afterEach(cleanup);

/** Stands in for whatever had focus when the quit started (the Memo editor, a terminal). */
function focusedInput(): HTMLInputElement {
  const input = document.createElement("input");
  document.body.append(input);
  input.focus();
  return input;
}

function pressCmdW(on: HTMLElement): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "w",
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });
  on.dispatchEvent(event);
  return event;
}

describe("QuitSaveOverlay", () => {
  it("takes focus off whatever was being edited", () => {
    const input = focusedInput();
    const { container } = render(<QuitSaveOverlay />);

    expect(document.activeElement).toBe(
      container.querySelector(".quit-save-overlay"),
    );
    expect(document.activeElement).not.toBe(input);
  });

  it("keeps the app's window-level shortcuts from firing while the save runs", () => {
    // The app registers its Cmd shortcuts on window, which a React onKeyDown cannot reach.
    const shortcut = vi.fn();
    window.addEventListener("keydown", shortcut);
    const input = focusedInput();
    render(<QuitSaveOverlay />);

    const event = pressCmdW(input);

    expect(shortcut).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    window.removeEventListener("keydown", shortcut);
  });

  it("gives focus back and stops shielding once the save is over", () => {
    // A quit can still be called off, and focus left on <body> means keystrokes reach nothing.
    const shortcut = vi.fn();
    window.addEventListener("keydown", shortcut);
    const input = focusedInput();
    const { unmount } = render(<QuitSaveOverlay />);

    unmount();

    expect(document.activeElement).toBe(input);
    pressCmdW(input);
    expect(shortcut).toHaveBeenCalledOnce();
    window.removeEventListener("keydown", shortcut);
  });
});
