// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useModalEscape } from "./useModalEscape.js";

afterEach(cleanup);

function Modal({ onClose }: { onClose: () => void }) {
  useModalEscape(onClose);
  return null;
}

describe("useModalEscape", () => {
  it("closes the single mounted modal on Escape", () => {
    const onClose = vi.fn();
    render(<Modal onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes only the topmost (last-mounted) modal, leaving the parent open", () => {
    const closeParent = vi.fn();
    const closeChild = vi.fn();
    render(
      <>
        <Modal onClose={closeParent} />
        <Modal onClose={closeChild} />
      </>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closeChild).toHaveBeenCalledOnce();
    expect(closeParent).not.toHaveBeenCalled();
  });

  it("falls back to the parent once the child unmounts", () => {
    const closeParent = vi.fn();
    const closeChild = vi.fn();
    const { rerender } = render(
      <>
        <Modal onClose={closeParent} />
        <Modal onClose={closeChild} />
      </>,
    );
    rerender(<Modal onClose={closeParent} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closeParent).toHaveBeenCalledOnce();
    expect(closeChild).not.toHaveBeenCalled();
  });
});
