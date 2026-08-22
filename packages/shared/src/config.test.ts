import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONFIG,
  DEFAULT_FOOTER_THRESHOLDS,
  DEFAULT_STARTUP_CONFIG,
  footerThresholdsSchema,
  parseConfig,
  parseStartupConfig,
} from "./config.js";

describe("parseConfig", () => {
  it("falls back to defaults for empty/unspecified input", () => {
    expect(parseConfig(undefined)).toEqual(DEFAULT_CONFIG);
    expect(parseConfig(null)).toEqual(DEFAULT_CONFIG);
    expect(parseConfig({})).toEqual(DEFAULT_CONFIG);
  });

  it("reads the specified fields", () => {
    expect(parseConfig({ notifySound: false, updateCheck: false })).toEqual({
      notifySound: false,
      updateCheck: false,
      language: null,
    });
  });

  it("reads updateCheck as an opt-out (default on)", () => {
    expect(parseConfig({ updateCheck: false })).toEqual({
      notifySound: true,
      updateCheck: false,
      language: null,
    });
  });

  it("fills in missing fields with defaults", () => {
    expect(parseConfig({ notifySound: false })).toEqual({
      notifySound: false,
      updateCheck: true,
      language: null,
    });
  });

  it("falls back to defaults for fields with an invalid type (does not throw)", () => {
    expect(parseConfig({ notifySound: "yes", updateCheck: 1 })).toEqual(
      DEFAULT_CONFIG,
    );
  });

  it("returns defaults without throwing for non-object input", () => {
    expect(parseConfig(42)).toEqual(DEFAULT_CONFIG);
    expect(parseConfig("nope")).toEqual(DEFAULT_CONFIG);
    expect(parseConfig([])).toEqual(DEFAULT_CONFIG);
  });

  it("ignores unknown fields", () => {
    expect(parseConfig({ notifySound: false, extra: "x" })).toEqual({
      notifySound: false,
      updateCheck: true,
      language: null,
    });
  });
});

describe("parseStartupConfig", () => {
  it("empty input yields defaults (notifyMode unspecified)", () => {
    expect(parseStartupConfig(undefined)).toEqual(DEFAULT_STARTUP_CONFIG);
    expect(parseStartupConfig({})).toEqual(DEFAULT_STARTUP_CONFIG);
  });

  it("reads notifyMode", () => {
    expect(parseStartupConfig({ notifyMode: "both" })).toEqual({
      notifyMode: "both",
    });
  });

  it("falls back to the default (unspecified) for an invalid notifyMode without throwing", () => {
    expect(parseStartupConfig({ notifyMode: "wat" })).toEqual(
      DEFAULT_STARTUP_CONFIG,
    );
    expect(parseStartupConfig(123)).toEqual(DEFAULT_STARTUP_CONFIG);
  });
});

describe("footerThresholdsSchema", () => {
  const parse = (input: unknown) => footerThresholdsSchema.parse(input);

  it("fills every band with the current defaults for empty/absent input", () => {
    expect(parse(undefined)).toEqual(DEFAULT_FOOTER_THRESHOLDS);
    expect(parse({})).toEqual(DEFAULT_FOOTER_THRESHOLDS);
  });

  it("merges a partial config per field without dropping the others to zero", () => {
    const result = parse({
      usagePercent: { warn: { enabled: false, value: 40 } },
    });
    expect(result.usagePercent.warn).toEqual({ enabled: false, value: 40 });
    expect(result.usagePercent.high).toEqual(
      DEFAULT_FOOTER_THRESHOLDS.usagePercent.high,
    );
    expect(result.sessionTokens).toEqual(
      DEFAULT_FOOTER_THRESHOLDS.sessionTokens,
    );
    expect(result.elapsedMs).toEqual(DEFAULT_FOOTER_THRESHOLDS.elapsedMs);
  });

  it("degrades a non-integer value to the default, matching the server's integer contract", () => {
    expect(
      parse({ usagePercent: { warn: { enabled: true, value: 50.7 } } })
        .usagePercent.warn,
    ).toEqual(DEFAULT_FOOTER_THRESHOLDS.usagePercent.warn);
  });

  it("rejects malformed values field-by-field back to the default", () => {
    expect(
      parse({ usagePercent: { crit: { enabled: "yes", value: -5 } } })
        .usagePercent.crit,
    ).toEqual(DEFAULT_FOOTER_THRESHOLDS.usagePercent.crit);
    expect(
      parse({ elapsedMs: { crit: { value: "soon" } } }).elapsedMs.crit,
    ).toEqual(DEFAULT_FOOTER_THRESHOLDS.elapsedMs.crit);
  });

  it("returns defaults for non-object input without throwing", () => {
    expect(parse(42)).toEqual(DEFAULT_FOOTER_THRESHOLDS);
    expect(parse("nope")).toEqual(DEFAULT_FOOTER_THRESHOLDS);
  });
});
