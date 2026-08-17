import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONFIG,
  DEFAULT_STARTUP_CONFIG,
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
    expect(parseConfig({ notifySound: false, debug: true })).toEqual({
      notifySound: false,
      debug: true,
      updateCheck: true,
      language: null,
    });
  });

  it("reads updateCheck as an opt-out (default on)", () => {
    expect(parseConfig({ updateCheck: false })).toEqual({
      notifySound: true,
      debug: false,
      updateCheck: false,
      language: null,
    });
  });

  it("fills in missing fields with defaults", () => {
    expect(parseConfig({ notifySound: false })).toEqual({
      notifySound: false,
      debug: false,
      updateCheck: true,
      language: null,
    });
  });

  it("falls back to defaults for fields with an invalid type (does not throw)", () => {
    expect(parseConfig({ notifySound: "yes", debug: 1 })).toEqual(
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
      debug: false,
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
