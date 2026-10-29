// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import type { CockpitTerminalInfo } from "@zashiki/shared";
import { afterEach, describe, expect, it } from "vitest";

import { StateIcon } from "./SessionStateIcons.js";

afterEach(cleanup);

const base: CockpitTerminalInfo = {
  cockpitTerminalId: "@1",
  name: "repo",
  org: "org",
  repo: "repo",
  state: "idle",
  title: null,
  active: false,
};

function glyphOf(session: CockpitTerminalInfo, fresh = false): string {
  const { container } = render(<StateIcon session={session} fresh={fresh} />);
  return container.querySelector(".state-stack-glyph")?.textContent ?? "";
}

describe("StateIcon", () => {
  it("shows the API-error glyph for an idle session whose turn ended on an API error", () => {
    expect(glyphOf({ ...base, apiError: true })).toBe("cloud_off");
  });

  it("keeps the API-error glyph over the new-session glyph", () => {
    expect(glyphOf({ ...base, apiError: true }, true)).toBe("cloud_off");
  });

  it("lets a running session keep its live glyph despite a stale API error", () => {
    expect(glyphOf({ ...base, state: "running", apiError: true })).toBe(
      "progress_activity",
    );
  });

  it("lets an open Claude Code menu win over the API error", () => {
    expect(glyphOf({ ...base, menuOpen: true, apiError: true })).toBe(
      "settings",
    );
  });

  it("shows the plain idle glyph without the flag", () => {
    expect(glyphOf(base)).toBe("check");
  });
});
