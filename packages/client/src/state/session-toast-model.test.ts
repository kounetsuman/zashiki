import { describe, expect, it } from "vitest";

import {
  pruneClosedSessionToasts,
  removeSessionToast,
  type SessionToast,
  upsertSessionToast,
  visibleSessionToasts,
} from "./session-toast-model.js";

function toast(
  id: string,
  kind: SessionToast["kind"] = "waiting",
): SessionToast {
  return { cockpitTerminalId: id, kind, org: "org", title: null };
}

describe("session-toast-model", () => {
  it("upserts newest first and coalesces per terminal with the latest kind", () => {
    let list = upsertSessionToast([], toast("@1", "waiting"));
    list = upsertSessionToast(list, toast("@2", "waiting"));
    list = upsertSessionToast(list, toast("@1", "done"));
    expect(list.map((t) => t.cockpitTerminalId)).toEqual(["@1", "@2"]);
    expect(list[0]?.kind).toBe("done");
  });

  it("removes a terminal's toast on activation/dismissal", () => {
    const list = [toast("@1"), toast("@2")];
    expect(
      removeSessionToast(list, "@1").map((t) => t.cockpitTerminalId),
    ).toEqual(["@2"]);
    expect(removeSessionToast(list, "@nope")).toHaveLength(2);
  });

  it("prunes toasts whose terminal has closed", () => {
    const list = [toast("@1"), toast("@2"), toast("@3")];
    expect(
      pruneClosedSessionToasts(list, new Set(["@2"])).map(
        (t) => t.cockpitTerminalId,
      ),
    ).toEqual(["@2"]);
    expect(pruneClosedSessionToasts(list, new Set(["@1", "@2", "@3"]))).toBe(
      list,
    );
  });

  it("caps the visible slice and reveals the next once one is dismissed", () => {
    let list: SessionToast[] = [];
    for (const id of ["@1", "@2", "@3", "@4", "@5", "@6"]) {
      list = upsertSessionToast(list, toast(id));
    }
    expect(
      visibleSessionToasts(list, 5).map((t) => t.cockpitTerminalId),
    ).toEqual(["@6", "@5", "@4", "@3", "@2"]);
    list = removeSessionToast(list, "@6");
    expect(visibleSessionToasts(list, 5)).toHaveLength(5);
    expect(visibleSessionToasts(list, 5).at(-1)?.cockpitTerminalId).toBe("@1");
  });
});
