import { describe, expect, it } from "vitest";

import {
  DEFAULT_ORG_PALETTE,
  orgColor,
  orgNames,
  orgOfCwd,
  orgRoot,
  resolveOrgColor,
} from "./repos.js";

// Reading and parsing repos.conf is server/infra/repos.ts's (readConfRoots) responsibility.
// This file only verifies the org-attribution logic given a list of already-absolutized roots.
const ROOTS = [
  "/Users/kilo/workspace/charlie",
  "/Users/kilo/workspace/delta",
  "/Users/kilo/workspace/kilo",
];

describe("orgOfCwd (port of dom_org_of_cwd)", () => {
  it("for a cwd under a root, the org is that root's last path segment", () => {
    expect(orgOfCwd("/Users/kilo/workspace/charlie/repo-a", ROOTS)).toBe(
      "charlie",
    );
  });

  it("the root itself also belongs to the org", () => {
    expect(orgOfCwd("/Users/kilo/workspace/charlie", ROOTS)).toBe("charlie");
  });

  it("a prefix-matching but different directory (charlie2) is not misattributed", () => {
    expect(orgOfCwd("/Users/kilo/workspace/charlie2", ROOTS)).toBe("charlie2");
  });

  it("when under no root, uses the cwd's own last segment (a catch-all for detection outside the conf)", () => {
    expect(orgOfCwd("/tmp/scratch", ROOTS)).toBe("scratch");
  });
});

describe("orgRoot (port of dom_org_root)", () => {
  it("looks up the root absolute path from an org name", () => {
    expect(orgRoot("delta", ROOTS)).toBe("/Users/kilo/workspace/delta");
  });

  it("returns null when there is no match", () => {
    expect(orgRoot("unknown", ROOTS)).toBeNull();
  });
});

describe("orgNames (the source of the displayed org list)", () => {
  it("returns the last segment of every org in the conf, preserving order", () => {
    expect(orgNames(ROOTS)).toEqual(["charlie", "delta", "kilo"]);
  });

  it("dedups duplicate last segments while preserving order", () => {
    expect(orgNames(["/a/foo", "/b/foo", "/a/bar"])).toEqual(["foo", "bar"]);
  });
});

describe("orgColor (stable hash-based coloring of org names; the default when the conf has no explicit color)", () => {
  it("the default palette has 1 to 10 colors, all in #RRGGBB format", () => {
    expect(DEFAULT_ORG_PALETTE.length).toBeGreaterThan(0);
    expect(DEFAULT_ORG_PALETTE.length).toBeLessThanOrEqual(10);
    for (const c of DEFAULT_ORG_PALETTE) {
      expect(c).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("the return value is always a color from the palette", () => {
    for (const org of ["charlie", "whiskey", "kilo", "delta", ""]) {
      expect(DEFAULT_ORG_PALETTE).toContain(orgColor(org));
    }
  });

  it("the same org name always gets the same color (stable and deterministic)", () => {
    expect(orgColor("whiskey")).toBe(orgColor("whiskey"));
    expect(orgColor("kilo")).toBe(orgColor("kilo"));
  });

  it("multiple orgs do not all collapse to the same color (not a constant return)", () => {
    const colors = new Set(
      ["charlie", "whiskey", "kilo", "delta", "tango", "oscar"].map((o) =>
        orgColor(o),
      ),
    );
    expect(colors.size).toBeGreaterThan(1);
  });

  it("the palette can be swapped out (theme injection)", () => {
    const palette = ["#111111", "#222222"];
    expect(palette).toContain(orgColor("anything", palette));
  });
});

describe("resolveOrgColor (explicit color → automatic coloring if absent)", () => {
  it("prefers the explicit color from repos.conf when present", () => {
    expect(resolveOrgColor("whiskey", { whiskey: "#123456" })).toBe("#123456");
  });

  it("uses automatic coloring (from the palette) when there is no explicit color", () => {
    expect(DEFAULT_ORG_PALETTE).toContain(resolveOrgColor("whiskey", {}));
  });

  it("automatic coloring matches orgColor", () => {
    expect(resolveOrgColor("kilo", {})).toBe(orgColor("kilo"));
  });

  it("when the explicit color is an empty string, falls back to automatic coloring rather than no color (invalid-payload defense)", () => {
    expect(resolveOrgColor("whiskey", { whiskey: "" })).toBe(
      orgColor("whiskey"),
    );
  });
});
