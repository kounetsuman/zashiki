// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ServerMessage, SessionInfo } from "@zashiki/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalSessionStatus } from "../session/terminal-session.js";
import type { ControlStatus } from "../ws/control.js";
import { DebugPanel } from "./DebugPanel.js";
import type { ControlDebugSnapshot, TermDebugSnapshot } from "./debug-model.js";

afterEach(cleanup);

function fakeControl(initial: ControlDebugSnapshot) {
  let snap = initial;
  const statusListeners = new Set<(s: ControlStatus) => void>();
  const protoListeners = new Set<(dir: "send" | "recv", t: string) => void>();
  const msgListeners = new Set<(m: ServerMessage) => void>();
  return {
    control: {
      debugSnapshot: () => snap,
      onStatus(fn: (s: ControlStatus) => void) {
        statusListeners.add(fn);
        return () => statusListeners.delete(fn);
      },
      onProtocol(fn: (dir: "send" | "recv", t: string) => void) {
        protoListeners.add(fn);
        return () => protoListeners.delete(fn);
      },
      onMessage(fn: (m: ServerMessage) => void) {
        msgListeners.add(fn);
        return () => msgListeners.delete(fn);
      },
    },
    setSnap(s: ControlDebugSnapshot) {
      snap = s;
      for (const fn of statusListeners) fn(s.status);
    },
    proto(dir: "send" | "recv", t: string) {
      for (const fn of protoListeners) fn(dir, t);
    },
    msg(m: ServerMessage) {
      for (const fn of msgListeners) fn(m);
    },
  };
}

function fakeSession(initial: TermDebugSnapshot) {
  const snap = initial;
  return {
    session: {
      debugSnapshot: () => snap,
      onStatus: (_fn: (s: TerminalSessionStatus) => void) => () => undefined,
    },
  };
}

const controlSnap: ControlDebugSnapshot = {
  status: "open",
  attempt: 0,
  lastCloseCode: null,
};

const termSnap: TermDebugSnapshot = {
  status: "attached",
  attempt: 1,
  pendingAck: 128,
  windowId: "@3",
  termId: "term-xyz",
  suspended: false,
};

const sessions: SessionInfo[] = [
  {
    windowId: "@1",
    name: "zashiki",
    org: "kilo",
    repo: "zashiki",
    state: "running",
    title: null,
    active: true,
  },
];

describe("DebugPanel", () => {
  it("displays the control / term diagnostic values and the tmux session name", () => {
    const c = fakeControl(controlSnap);
    const { session } = fakeSession(termSnap);
    render(
      <DebugPanel
        control={c.control}
        session={session}
        sessions={sessions}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText("@3")).toBeTruthy();
    expect(screen.getByText("term-xyz")).toBeTruthy();
    expect(screen.getByText("zk-term-xyz")).toBeTruthy();
    expect(screen.getByText("128")).toBeTruthy();
    // The window layout from state.sync
    expect(
      screen.getByText(/@1 \[running\] kilo\/zashiki zashiki/),
    ).toBeTruthy();
  });

  it("updates the reconnect attempt / close code on control status changes", () => {
    const c = fakeControl(controlSnap);
    const { session } = fakeSession(termSnap);
    render(
      <DebugPanel
        control={c.control}
        session={session}
        sessions={[]}
        onClose={() => undefined}
      />,
    );
    act(() => c.setSnap({ status: "closed", attempt: 3, lastCloseCode: 1006 }));
    expect(screen.getByText("1006")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
  });

  it("pushes the send/recv direction and t into the protocol tail", () => {
    const c = fakeControl(controlSnap);
    const { session } = fakeSession(termSnap);
    render(
      <DebugPanel
        control={c.control}
        session={session}
        sessions={[]}
        onClose={() => undefined}
      />,
    );
    act(() => c.proto("send", "term.open"));
    act(() => c.proto("recv", "state.sync"));
    expect(screen.getByText(/→ term\.open/)).toBeTruthy();
    expect(screen.getByText(/← state\.sync/)).toBeTruthy();
  });

  it("pushes notify / git.dirty to the event log but not state.sync", () => {
    const c = fakeControl(controlSnap);
    const { session } = fakeSession(termSnap);
    render(
      <DebugPanel
        control={c.control}
        session={session}
        sessions={[]}
        onClose={() => undefined}
      />,
    );
    act(() =>
      c.msg({ t: "notify", kind: "waiting", windowId: "@1", title: "x" }),
    );
    act(() => c.msg({ t: "git.dirty" }));
    act(() =>
      c.msg({ t: "state.sync", sessions: [], orgs: [], orgColors: {} }),
    );
    expect(screen.getByText('notify waiting @1 "x"')).toBeTruthy();
    expect(screen.getByText("git.dirty")).toBeTruthy();
  });

  it("notes the hook observation limit (UserPromptSubmit does not arrive)", () => {
    const c = fakeControl(controlSnap);
    const { session } = fakeSession(termSnap);
    render(
      <DebugPanel
        control={c.control}
        session={session}
        sessions={[]}
        onClose={() => undefined}
      />,
    );
    expect(
      screen.getByText(/UserPromptSubmit は client に届きません/),
    ).toBeTruthy();
  });

  it("calls onClose via the close button", () => {
    const c = fakeControl(controlSnap);
    const { session } = fakeSession(termSnap);
    const onClose = vi.fn();
    render(
      <DebugPanel
        control={c.control}
        session={session}
        sessions={[]}
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "デバッグを閉じる" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
