import { describe, expect, it } from "vitest";
import type { AppSession } from "../App.js";
import { PopOutAwareSession } from "./pop-out-aware-session.js";

function fakeSession(): { session: AppSession; calls: string[] } {
  const calls: string[] = [];
  const session: AppSession = {
    start: () => calls.push("start"),
    input: () => {},
    resize: () => {},
    notifyWritten: () => {},
    onData: () => () => {},
    getStatus: () => "attached",
    onStatus: () => () => {},
    debugSnapshot: () => ({
      status: "attached",
      attempt: 0,
      pendingAck: 0,
      cockpitTerminalId: null,
      termId: null,
      suspended: false,
    }),
    select: (id) => calls.push(`select ${id}`),
    getTermId: () => null,
    reconnect: () => calls.push("reconnect"),
    retryLostTerm: () => {},
    suspend: () => calls.push("suspend"),
    resume: () => calls.push("resume"),
  };
  return { session, calls };
}

describe("PopOutAwareSession", () => {
  it("passes selections of terminals that are not popped out straight through", () => {
    const { session, calls } = fakeSession();
    const main = new PopOutAwareSession(session);
    main.select("a");
    main.select("b");
    expect(calls).toEqual(["select a", "select b"]);
  });

  it("parks the main terminal when the terminal it shows is popped out", () => {
    const { session, calls } = fakeSession();
    const main = new PopOutAwareSession(session);
    main.select("a");
    main.setPoppedOut(new Set(["a"]));
    expect(calls).toEqual(["select a", "suspend"]);
  });

  it("never attaches to a popped-out terminal that gets selected", () => {
    const { session, calls } = fakeSession();
    const main = new PopOutAwareSession(session);
    main.setPoppedOut(new Set(["a"]));
    main.select("b");
    main.select("a");
    expect(calls).toEqual(["select b", "suspend"]);
  });

  it("re-attaches to the selected terminal once it returns from its window", () => {
    const { session, calls } = fakeSession();
    const main = new PopOutAwareSession(session);
    main.select("a");
    main.setPoppedOut(new Set(["a"]));
    main.setPoppedOut(new Set());
    // Selecting before resuming makes the reopen carry the terminal, so no other one is attached first.
    expect(calls).toEqual(["select a", "suspend", "select a", "resume"]);
  });

  it("re-attaches when another terminal is selected while parked", () => {
    const { session, calls } = fakeSession();
    const main = new PopOutAwareSession(session);
    main.select("a");
    main.setPoppedOut(new Set(["a"]));
    main.select("b");
    expect(calls).toEqual(["select a", "suspend", "select b", "resume"]);
  });

  it("keeps a parked terminal parked when the app resumes", () => {
    const { session, calls } = fakeSession();
    const main = new PopOutAwareSession(session);
    main.select("a");
    main.setPoppedOut(new Set(["a"]));
    main.resume();
    expect(calls).toEqual(["select a", "suspend"]);
  });

  it("stays suspended on return while the app has no terminal to attach", () => {
    const { session, calls } = fakeSession();
    const main = new PopOutAwareSession(session);
    main.select("a");
    main.setPoppedOut(new Set(["a"]));
    main.suspend();
    main.setPoppedOut(new Set());
    expect(calls).toEqual(["select a", "suspend", "suspend", "select a"]);
  });

  it("does not re-select when the popped-out set changes without touching the selection", () => {
    const { session, calls } = fakeSession();
    const main = new PopOutAwareSession(session);
    main.select("a");
    main.setPoppedOut(new Set(["b"]));
    main.setPoppedOut(new Set());
    expect(calls).toEqual(["select a"]);
  });
});
