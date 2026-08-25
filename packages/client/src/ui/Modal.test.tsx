// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Modal } from "./Modal.js";

afterEach(cleanup);

const noop = () => {};

describe("Modal", () => {
  it("renders a labeled dialog carrying the title and the supplied body", () => {
    render(
      <Modal title="設定" closeLabel="閉じる" onClose={noop}>
        <p>body content</p>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog", { name: "設定" });
    expect(within(dialog).getByText("設定")).toBeTruthy();
    expect(within(dialog).getByText("body content")).toBeTruthy();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <Modal title="t" closeLabel="c" onClose={onClose}>
        <p>b</p>
      </Modal>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on the close button", () => {
    const onClose = vi.fn();
    render(
      <Modal title="t" closeLabel="閉じる" onClose={onClose}>
        <p>b</p>
      </Modal>,
    );
    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on a backdrop click but not on a click inside the dialog", () => {
    const onClose = vi.fn();
    const { container } = render(
      <Modal title="設定" closeLabel="c" onClose={onClose}>
        <p>b</p>
      </Modal>,
    );
    fireEvent.click(screen.getByRole("dialog", { name: "設定" }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector(".modal-backdrop") as HTMLElement);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("adds the given className alongside modal-box on the dialog", () => {
    render(
      <Modal title="t" closeLabel="c" onClose={noop} className="help-modal">
        <p>b</p>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.classList.contains("modal-box")).toBe(true);
    expect(dialog.classList.contains("help-modal")).toBe(true);
  });
});
