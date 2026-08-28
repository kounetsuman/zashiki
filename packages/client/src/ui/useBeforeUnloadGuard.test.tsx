// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useBeforeUnloadGuard } from "./useBeforeUnloadGuard.js";

afterEach(cleanup);

function Harness({ dirty }: { dirty: boolean }) {
  useBeforeUnloadGuard(dirty);
  return null;
}

function fireBeforeUnload(): boolean {
  const e = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
}

describe("useBeforeUnloadGuard", () => {
  it("blocks unload while dirty", () => {
    render(<Harness dirty={true} />);
    expect(fireBeforeUnload()).toBe(true);
  });

  it("does not block when clean, and releases once dirty clears", () => {
    const { rerender } = render(<Harness dirty={false} />);
    expect(fireBeforeUnload()).toBe(false);
    rerender(<Harness dirty={true} />);
    expect(fireBeforeUnload()).toBe(true);
    rerender(<Harness dirty={false} />);
    expect(fireBeforeUnload()).toBe(false);
  });

  it("removes the listener on unmount", () => {
    const { unmount } = render(<Harness dirty={true} />);
    unmount();
    expect(fireBeforeUnload()).toBe(false);
  });
});
