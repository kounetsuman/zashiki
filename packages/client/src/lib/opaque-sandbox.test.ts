import { describe, expect, it } from "vitest";

import { OPAQUE_SCRIPT_SANDBOX } from "./opaque-sandbox.js";

describe("OPAQUE_SCRIPT_SANDBOX", () => {
  it("is an opaque origin, which no navigation inside the frame can widen", () => {
    expect(OPAQUE_SCRIPT_SANDBOX).toBe("allow-scripts");
    expect(OPAQUE_SCRIPT_SANDBOX).not.toContain("allow-same-origin");
    expect(OPAQUE_SCRIPT_SANDBOX).not.toContain("allow-top-navigation");
  });
});
