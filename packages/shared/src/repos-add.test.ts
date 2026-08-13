import { describe, expect, it } from "vitest";

import {
  addRepoRequestSchema,
  addRepoResponseSchema,
  fsValidateResponseSchema,
  isOrgColorToken,
  reposListResponseSchema,
} from "./repos-add.js";

describe("addRepoRequestSchema", () => {
  it("accepts a bare path without a color", () => {
    const parsed = addRepoRequestSchema.parse({ path: "/Users/me/ws/foo" });
    expect(parsed).toEqual({ path: "/Users/me/ws/foo" });
  });

  it("accepts a path with a #rrggbb / #rgb color", () => {
    expect(
      addRepoRequestSchema.parse({ path: "~/ws/foo", color: "#7aa2f7" }).color,
    ).toBe("#7aa2f7");
    expect(
      addRepoRequestSchema.parse({ path: "~/ws/foo", color: "#abc" }).color,
    ).toBe("#abc");
  });

  it("rejects an empty path and a non-color-token color", () => {
    expect(addRepoRequestSchema.safeParse({ path: "" }).success).toBe(false);
    expect(
      addRepoRequestSchema.safeParse({ path: "/x", color: "blue" }).success,
    ).toBe(false);
    expect(
      addRepoRequestSchema.safeParse({ path: "/x", color: "#12" }).success,
    ).toBe(false);
  });
});

describe("addRepoResponseSchema", () => {
  it("requires a non-empty org", () => {
    expect(addRepoResponseSchema.parse({ org: "foo" }).org).toBe("foo");
    expect(addRepoResponseSchema.safeParse({ org: "" }).success).toBe(false);
  });
});

describe("fsValidateResponseSchema", () => {
  it("accepts ok with an org", () => {
    expect(
      fsValidateResponseSchema.parse({ status: "ok", org: "foo" }),
    ).toEqual({ status: "ok", org: "foo" });
  });

  it("accepts a failure status without an org", () => {
    expect(fsValidateResponseSchema.parse({ status: "duplicate" }).status).toBe(
      "duplicate",
    );
  });

  it("rejects an unknown status", () => {
    expect(fsValidateResponseSchema.safeParse({ status: "nope" }).success).toBe(
      false,
    );
  });
});

describe("reposListResponseSchema", () => {
  it("accepts a list of {org, path}", () => {
    const parsed = reposListResponseSchema.parse({
      orgs: [{ org: "myorg", path: "/Users/me/ws/myorg" }],
    });
    expect(parsed.orgs[0]).toEqual({
      org: "myorg",
      path: "/Users/me/ws/myorg",
    });
  });

  it("accepts an empty list and rejects blank fields", () => {
    expect(reposListResponseSchema.parse({ orgs: [] }).orgs).toEqual([]);
    expect(
      reposListResponseSchema.safeParse({ orgs: [{ org: "", path: "/x" }] })
        .success,
    ).toBe(false);
  });
});

describe("isOrgColorToken", () => {
  it("matches only #rgb / #rrggbb", () => {
    expect(isOrgColorToken("#7aa2f7")).toBe(true);
    expect(isOrgColorToken("#ABC")).toBe(true);
    expect(isOrgColorToken("#7aa2f")).toBe(false);
    expect(isOrgColorToken("7aa2f7")).toBe(false);
    expect(isOrgColorToken("# note")).toBe(false);
  });
});
