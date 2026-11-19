// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { CockpitTerminalInfo, ServerMessage } from "@zashiki/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSession } from "../App.js";
import { PopOutApp } from "./PopOutApp.js";

vi.mock("./TerminalView.js", () => ({
  TerminalView: ({ cockpitTerminalId }: { cockpitTerminalId?: string }) => (
    <div data-testid="terminal-view" data-terminal={cockpitTerminalId} />
  ),
}));

afterEach(cleanup);

const terminal: CockpitTerminalInfo = {
  cockpitTerminalId: "@1",
  name: "zashiki",
  org: "kilo",
  repo: "zashiki",
  state: "unknown",
  title: "pop the tab out",
  active: true,
};

function setup() {
  const listeners = new Set<(m: ServerMessage) => void>();
  const control = {
    onMessage(fn: (m: ServerMessage) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const reconnect = vi.fn();
  const session = {
    getTermId: () => "term-1",
    reconnect,
    retryLostTerm: vi.fn(),
  } as unknown as AppSession;
  const onReturn = vi.fn();
  render(
    <PopOutApp
      control={control}
      session={session}
      cockpitTerminalId="@1"
      onReturn={onReturn}
    />,
  );
  const emit = (m: ServerMessage) =>
    act(() => {
      for (const fn of listeners) fn(m);
    });
  const sync = (cockpitTerminals: CockpitTerminalInfo[]) =>
    emit({
      t: "state.sync",
      cockpitTerminals,
      orgs: ["kilo"],
      orgColors: {},
      orgAliases: {},
    });
  return { emit, sync, onReturn, reconnect };
}

describe("PopOutApp", () => {
  it("shows only the one terminal under a header with its title", () => {
    const { sync } = setup();
    sync([terminal, { ...terminal, cockpitTerminalId: "@2", title: "other" }]);
    expect(screen.getByText("pop the tab out")).toBeTruthy();
    expect(screen.queryByText("other")).toBeNull();
    expect(screen.getByTestId("terminal-view").dataset.terminal).toBe("@1");
    expect(document.title).toBe("pop the tab out");
  });

  it("returns to the main window from the header button", () => {
    const { sync, onReturn } = setup();
    sync([terminal]);
    fireEvent.click(screen.getByRole("button", { name: /メインに戻す/ }));
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it("returns to the main window from the header's right-click menu", () => {
    const { sync, onReturn } = setup();
    sync([terminal]);
    fireEvent.contextMenu(screen.getByText("pop the tab out"));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "メインウィンドウに戻す" }),
    );
    expect(onReturn).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes itself once its terminal is gone", () => {
    const { sync, onReturn } = setup();
    sync([terminal]);
    expect(onReturn).not.toHaveBeenCalled();
    sync([]);
    expect(onReturn).toHaveBeenCalledTimes(1);
  });

  it("re-attaches its own term when the server replaced its PTY", () => {
    const { emit, reconnect } = setup();
    emit({ t: "term.reconnect", termIds: ["term-other"] });
    expect(reconnect).not.toHaveBeenCalled();
    emit({ t: "term.reconnect", termIds: ["term-1"] });
    expect(reconnect).toHaveBeenCalledTimes(1);
  });
});
