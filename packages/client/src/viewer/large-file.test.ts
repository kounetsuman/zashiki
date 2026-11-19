import { describe, expect, it } from "vitest";

import { FileTooLargeError } from "../api/files.js";
import { classifyReadFailure, formatFileSize } from "./large-file.js";

const MIB = 1024 * 1024;
const MAX = 200 * MIB;
const tooLarge = (size: number | null) => new FileTooLargeError("big", size);
const timeout = new DOMException("aborted", "AbortError");
const offline = new TypeError("Failed to fetch");

describe("classifyReadFailure before the user opens anyway", () => {
  it("asks for confirmation when the refused file is within the maximum", () => {
    expect(classifyReadFailure(tooLarge(30 * MIB), false, MAX)).toEqual({
      tooLarge: { reason: "confirm", size: 30 * MIB },
    });
    expect(classifyReadFailure(tooLarge(MAX), false, MAX)).toEqual({
      tooLarge: { reason: "confirm", size: MAX },
    });
  });

  it("says the file is over the maximum when it is", () => {
    expect(classifyReadFailure(tooLarge(MAX + 1), false, MAX)).toEqual({
      tooLarge: { reason: "overMax", size: MAX + 1, maxBytes: MAX },
    });
  });

  it("keeps the read's own error otherwise", () => {
    for (const e of [tooLarge(null), timeout, offline, new Error("gone")]) {
      expect(classifyReadFailure(e, false, MAX)).toEqual({
        tooLarge: null,
        error: e,
      });
    }
  });
});

describe("classifyReadFailure after the user opens anyway", () => {
  it("reports a timeout, a lost connection or a refusal as too large to open", () => {
    for (const e of [timeout, offline, tooLarge(MAX + 1), tooLarge(null)]) {
      expect(classifyReadFailure(e, true, MAX)).toEqual({
        tooLarge: { reason: "failedAfterConfirm" },
      });
    }
  });

  it("keeps any other error as it is", () => {
    const e = new Error("file not found");
    expect(classifyReadFailure(e, true, MAX)).toEqual({
      tooLarge: null,
      error: e,
    });
  });
});

describe("formatFileSize", () => {
  it("shows whole megabytes without a fraction and others to one decimal", () => {
    expect(formatFileSize(200 * MIB)).toBe("200 MB");
    expect(formatFileSize(25.25 * MIB)).toBe("25.3 MB");
    expect(formatFileSize(MIB / 2)).toBe("0.5 MB");
  });
});
