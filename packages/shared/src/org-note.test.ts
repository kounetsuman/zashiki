import { describe, expect, it } from "vitest";

import { ORG_NOTE_MAX_CHARS, orgNoteRequestSchema } from "./org-note.js";

describe("orgNoteRequestSchema", () => {
  it("accepts an org with a Markdown body (including a blank body, which means delete)", () => {
    expect(
      orgNoteRequestSchema.parse({ org: "acme", text: "# Acme\n" }),
    ).toEqual({ org: "acme", text: "# Acme\n" });
    expect(orgNoteRequestSchema.parse({ org: "acme", text: "" })).toEqual({
      org: "acme",
      text: "",
    });
  });

  it("rejects an empty org", () => {
    expect(orgNoteRequestSchema.safeParse({ org: "", text: "x" }).success).toBe(
      false,
    );
  });

  it("caps the body at ORG_NOTE_MAX_CHARS", () => {
    expect(
      orgNoteRequestSchema.safeParse({
        org: "acme",
        text: "x".repeat(ORG_NOTE_MAX_CHARS),
      }).success,
    ).toBe(true);
    expect(
      orgNoteRequestSchema.safeParse({
        org: "acme",
        text: "x".repeat(ORG_NOTE_MAX_CHARS + 1),
      }).success,
    ).toBe(false);
  });
});
