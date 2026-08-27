import type { CockpitTerminalInfo } from "@zashiki/shared";
import { describe, expect, it } from "vitest";
import type { TitleMap } from "../lib/conversation-title.js";
import type { Tab } from "../tabs/tab-model.js";
import { tabLabel } from "./tab-bar-model.js";

function session(
  cockpitTerminalId: string,
  extra: Partial<CockpitTerminalInfo> = {},
): CockpitTerminalInfo {
  return {
    cockpitTerminalId,
    org: "acme",
    name: "acme",
    state: "idle",
    title: null,
    ...extra,
  } as CockpitTerminalInfo;
}

describe("tabLabel", () => {
  it("resolves a session tab via resolveTitle", () => {
    const s = session("w1", { title: "Fix the bug" });
    const { label, title } = tabLabel(
      { kind: "session", id: "w1" } as Tab,
      [s],
      {} as TitleMap,
    );
    expect(label).toBe("Fix the bug");
    expect(title).toBe("Fix the bug");
  });

  it("prefers a manually edited title for a session tab", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const s = session(uuid, { title: "auto", name: "acme" });
    const titles = { [uuid]: { title: "Custom", name: "acme" } } as TitleMap;
    const { label } = tabLabel(
      { kind: "session", id: uuid } as Tab,
      [s],
      titles,
    );
    expect(label).toBe("Custom");
  });

  it("falls back to the window id when the session is gone", () => {
    const { label, title } = tabLabel(
      { kind: "session", id: "missing" } as Tab,
      [],
      {} as TitleMap,
    );
    expect(label).toBe("missing");
    expect(title).toBe("missing");
  });

  it("shows a viewer tab's basename as label and the repo-relative path as title", () => {
    const { label, title } = tabLabel(
      { kind: "viewer", id: "/repo\nsrc/app/main.ts" } as Tab,
      [],
      {} as TitleMap,
    );
    expect(label).toBe("main.ts");
    expect(title).toBe("src/app/main.ts");
  });

  it("falls back to the whole id for a viewer tab without a newline", () => {
    const { label, title } = tabLabel(
      { kind: "viewer", id: "bare" } as Tab,
      [],
      {} as TitleMap,
    );
    expect(label).toBe("bare");
    expect(title).toBe("bare");
  });

  it("shows a diff tab's basename, skipping the leading side segment", () => {
    const { label, title } = tabLabel(
      { kind: "diff", id: "c\n/repo\nsrc/app/main.ts" } as Tab,
      [],
      {} as TitleMap,
    );
    expect(label).toBe("main.ts");
    expect(title).toBe("src/app/main.ts");
  });

  it("keeps a newline inside a diff tab's relPath intact", () => {
    const { title } = tabLabel(
      { kind: "diff", id: "s\n/repo\nwe\nird.ts" } as Tab,
      [],
      {} as TitleMap,
    );
    expect(title).toBe("we\nird.ts");
  });

  it("labels the Memo tab", () => {
    const { label, title } = tabLabel(
      { kind: "memo", id: "memo" } as Tab,
      [],
      {} as TitleMap,
    );
    expect(label).toBe("Memo");
    expect(title).toBe("Memo");
  });
});
