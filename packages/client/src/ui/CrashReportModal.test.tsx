// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CrashReportModal } from "./CrashReportModal.js";

afterEach(cleanup);

describe("CrashReportModal", () => {
  it("shows the log and a GitHub report link that opens in a new tab", () => {
    render(<CrashReportModal log="panicked at 'boom'" onClose={() => {}} />);
    expect(screen.getByText("panicked at 'boom'")).toBeTruthy();
    const link = screen.getByRole("link", {
      name: "GitHub で報告",
    }) as HTMLAnchorElement;
    expect(link.target).toBe("_blank");
    expect(link.href).toContain("github.com/kounetsuman/zashiki/issues/new");
  });

  it("copies the full log to the clipboard and confirms", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<CrashReportModal log="full log body" onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "ログをコピー" }));
    expect(writeText).toHaveBeenCalledWith("full log body");
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "コピーしました",
      ),
    );
  });

  it("closes on the X button and on Escape", () => {
    const onClose = vi.fn();
    render(<CrashReportModal log="x" onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
