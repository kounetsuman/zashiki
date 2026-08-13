// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ErrorBoundary } from "./ErrorBoundary.js";

// A child throwing makes React dump a lot to console.error. Silence it to keep test output clean.
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  errorSpy.mockRestore();
  cleanup();
});

function Boom({ when }: { when: boolean }) {
  if (when) {
    throw new Error("boom");
  }
  return <div>child-ok</div>;
}

describe("ErrorBoundary", () => {
  it("renders children as-is when there is no exception", () => {
    render(
      <ErrorBoundary fallback={<div>fallback</div>}>
        <div>child-ok</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText("child-ok")).toBeTruthy();
    expect(screen.queryByText("fallback")).toBeNull();
  });

  it("renders the fallback when a child throws during render, without taking down the whole app", () => {
    render(
      <ErrorBoundary fallback={<div>fallback</div>}>
        <Boom when={true} />
      </ErrorBoundary>,
    );
    expect(screen.getByText("fallback")).toBeTruthy();
    expect(screen.queryByText("child-ok")).toBeNull();
  });

  it("passes the caught error to onError", () => {
    const onError = vi.fn();
    render(
      <ErrorBoundary fallback={<div>fallback</div>} onError={onError}>
        <Boom when={true} />
      </ErrorBoundary>,
    );
    expect(onError).toHaveBeenCalledTimes(1);
    const caught = onError.mock.calls[0]?.[0] as Error | undefined;
    expect(caught?.message).toBe("boom");
  });

  it("passes the error to a function fallback", () => {
    render(
      <ErrorBoundary fallback={(error) => <div>caught: {error.message}</div>}>
        <Boom when={true} />
      </ErrorBoundary>,
    );
    expect(screen.getByText("caught: boom")).toBeTruthy();
  });

  it("reset reinitializes the boundary and can re-render a recovered child", () => {
    let crash = true;
    function Rerenderable() {
      return <Boom when={crash} />;
    }
    render(
      <ErrorBoundary
        fallback={(_error, reset) => (
          <button
            type="button"
            onClick={() => {
              crash = false;
              reset();
            }}
          >
            retry
          </button>
        )}
      >
        <Rerenderable />
      </ErrorBoundary>,
    );
    expect(screen.getByText("retry")).toBeTruthy();
    fireEvent.click(screen.getByText("retry"));
    expect(screen.getByText("child-ok")).toBeTruthy();
    expect(screen.queryByText("retry")).toBeNull();
  });
});
