import { describe, expect, it } from "vitest";

import {
  classifyReuse,
  DEFAULT_PORT,
  healthzField,
  healthzPid,
  initialUrl,
  isHealthyResponse,
  isHtmlDocument,
  isTokenAccepted,
  parseArgs,
  platformPackageName,
  readToken,
  resolvePort,
  resolveServerBin,
  tokenFilePath,
} from "./lib.mjs";

describe("platformPackageName", () => {
  it("returns the platform package name for a supported platform", () => {
    expect(platformPackageName("darwin", "arm64")).toBe(
      "@zashiki/server-darwin-arm64",
    );
    expect(platformPackageName("darwin", "x64")).toBe(
      "@zashiki/server-darwin-x64",
    );
  });

  it("returns null for an unsupported combination", () => {
    expect(platformPackageName("linux", "x64")).toBeNull();
    expect(platformPackageName("win32", "x64")).toBeNull();
    expect(platformPackageName("darwin", "ia32")).toBeNull();
  });
});

describe("resolveServerBin", () => {
  it("prioritizes ZK_SERVER_BIN (does not call require.resolve)", () => {
    const requireResolve = () => {
      throw new Error("must not be called");
    };
    expect(
      resolveServerBin({
        env: { ZK_SERVER_BIN: "/custom/zashiki-server" },
        platform: "linux",
        arch: "x64",
        requireResolve,
      }),
    ).toBe("/custom/zashiki-server");
  });

  it("resolves the bin from the platform package", () => {
    const requireResolve = (spec) => `/node_modules/${spec}`;
    expect(
      resolveServerBin({
        env: {},
        platform: "darwin",
        arch: "arm64",
        requireResolve,
      }),
    ).toBe("/node_modules/@zashiki/server-darwin-arm64/bin/zashiki-server");
  });

  it("throws for an unsupported platform", () => {
    expect(() =>
      resolveServerBin({
        env: {},
        platform: "linux",
        arch: "x64",
        requireResolve: () => "x",
      }),
    ).toThrow(/Unsupported platform/);
  });

  it("throws with remediation when the package is not found", () => {
    const requireResolve = () => {
      throw new Error("Cannot find module");
    };
    expect(() =>
      resolveServerBin({
        env: {},
        platform: "darwin",
        arch: "arm64",
        requireResolve,
      }),
    ).toThrow(/ZK_SERVER_BIN/);
  });
});

describe("parseArgs", () => {
  it("defaults to open=true and no port", () => {
    expect(parseArgs([])).toEqual({
      port: null,
      open: true,
      help: false,
      version: false,
      error: null,
    });
  });

  it("--no-open / --help / --version", () => {
    expect(parseArgs(["--no-open"]).open).toBe(false);
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs(["--version"]).version).toBe(true);
    expect(parseArgs(["-v"]).version).toBe(true);
  });

  it("--port <n> / --port=<n> / -p", () => {
    expect(parseArgs(["--port", "9000"]).port).toBe(9000);
    expect(parseArgs(["--port=9001"]).port).toBe(9001);
    expect(parseArgs(["-p", "9002"]).port).toBe(9002);
  });

  it("sets error for an invalid port", () => {
    expect(parseArgs(["--port", "0"]).error).toMatch(/--port/);
    expect(parseArgs(["--port", "70000"]).error).toMatch(/--port/);
    expect(parseArgs(["--port", "abc"]).error).toMatch(/--port/);
    expect(parseArgs(["--port"]).error).toMatch(/--port/);
  });

  it("sets error for an unknown argument", () => {
    expect(parseArgs(["--wat"]).error).toMatch(/Unknown argument/);
  });
});

describe("resolvePort", () => {
  it("CLI flag > ZK_PORT > default", () => {
    expect(resolvePort({ cliPort: 9000, env: { ZK_PORT: "8888" } })).toBe(9000);
    expect(resolvePort({ cliPort: null, env: { ZK_PORT: "8888" } })).toBe(8888);
    expect(resolvePort({ cliPort: null, env: {} })).toBe(DEFAULT_PORT);
  });

  it("falls back to the default when ZK_PORT is invalid", () => {
    expect(resolvePort({ env: { ZK_PORT: "abc" } })).toBe(DEFAULT_PORT);
    expect(resolvePort({ env: { ZK_PORT: "0" } })).toBe(DEFAULT_PORT);
  });
});

describe("tokenFilePath", () => {
  it("uses ~/.zashiki/token for the default port", () => {
    expect(tokenFilePath({ port: 8790, env: {}, home: "/home/u" })).toBe(
      "/home/u/.zashiki/token",
    );
  });

  it("isolates non-default ports as token-<port> (does not pollute the default token)", () => {
    expect(tokenFilePath({ port: 9000, env: {}, home: "/home/u" })).toBe(
      "/home/u/.zashiki/token-9000",
    );
  });

  it("prioritizes an explicit ZK_TOKEN_FILE", () => {
    expect(
      tokenFilePath({
        port: 9000,
        env: { ZK_TOKEN_FILE: "/iso/token" },
        home: "/home/u",
      }),
    ).toBe("/iso/token");
  });
});

describe("readToken", () => {
  it("trims and returns an alphanumeric token", () => {
    expect(readToken("  abc123DEF  \n")).toBe("abc123DEF");
  });

  it("throws when empty", () => {
    expect(() => readToken("")).toThrow(/empty/i);
    expect(() => readToken("   \n")).toThrow(/empty/i);
    expect(() => readToken(null)).toThrow(/empty/i);
  });

  it("throws when it contains non-alphanumeric characters", () => {
    expect(() => readToken("abc-123")).toThrow(/invalid/i);
    expect(() => readToken("ab c")).toThrow(/invalid/i);
    expect(() => readToken("tok\nen")).toThrow(/invalid/i);
  });
});

describe("initialUrl", () => {
  it("builds base/?token=token", () => {
    expect(initialUrl("http://127.0.0.1:8790", "deadbeef")).toBe(
      "http://127.0.0.1:8790/?token=deadbeef",
    );
  });
});

describe("isHealthyResponse", () => {
  it("is true only for status 200 with a status:ok body", () => {
    expect(isHealthyResponse(200, '{"status":"ok"}')).toBe(true);
    expect(isHealthyResponse(200, "hello")).toBe(false);
    expect(isHealthyResponse(401, '{"status":"ok"}')).toBe(false);
  });
});

describe("isTokenAccepted", () => {
  it("is true only for status 200 with an ok:true body", () => {
    expect(isTokenAccepted(200, '{"ok":true}')).toBe(true);
    expect(isTokenAccepted(200, "hello")).toBe(false);
    expect(isTokenAccepted(200, '{"ok":false}')).toBe(false);
    expect(isTokenAccepted(403, '{"ok":true}')).toBe(false);
  });
});

describe("isHtmlDocument", () => {
  it("detects a doctype / html prefix, ignoring case and leading whitespace", () => {
    expect(isHtmlDocument("<!DOCTYPE html><html></html>")).toBe(true);
    expect(isHtmlDocument("  \n<html>")).toBe(true);
    expect(isHtmlDocument("<!doctype HTML>")).toBe(true);
    expect(isHtmlDocument('{"error":"unauthorized"}')).toBe(false);
    expect(isHtmlDocument("")).toBe(false);
  });
});

describe("healthzField", () => {
  it("extracts a top-level string field, null on missing / non-string / bad JSON", () => {
    const body = '{"status":"ok","git_sha":"abc","pid":42}';
    expect(healthzField(body, "git_sha")).toBe("abc");
    expect(healthzField(body, "status")).toBe("ok");
    expect(healthzField(body, "pid")).toBeNull();
    expect(healthzField(body, "missing")).toBeNull();
    expect(healthzField("not json", "git_sha")).toBeNull();
  });
});

describe("healthzPid", () => {
  it("returns a positive integer pid, rejecting <=0 / non-integer / missing", () => {
    expect(healthzPid('{"pid":42}')).toBe(42);
    expect(healthzPid('{"pid":0}')).toBeNull();
    expect(healthzPid('{"pid":-5}')).toBeNull();
    expect(healthzPid('{"pid":1.5}')).toBeNull();
    expect(healthzPid('{"status":"ok"}')).toBeNull();
    expect(healthzPid("not json")).toBeNull();
  });
});

describe("classifyReuse", () => {
  const body = (sha) =>
    sha === undefined
      ? '{"status":"ok","pid":1}'
      : `{"status":"ok","git_sha":"${sha}","pid":1}`;

  it("reuses when there is no basis to judge (expected sha absent / unknown)", () => {
    expect(
      classifyReuse({ expectedGitSha: null, healthzBody: body("x") }),
    ).toBe("reuse");
    expect(
      classifyReuse({ expectedGitSha: "unknown", healthzBody: body("x") }),
    ).toBe("reuse");
  });

  it("reuses when the running server's git_sha matches the expected one", () => {
    expect(
      classifyReuse({ expectedGitSha: "abc", healthzBody: body("abc") }),
    ).toBe("reuse");
  });

  it("is stale on a git_sha mismatch (the resident server is a different build)", () => {
    expect(
      classifyReuse({ expectedGitSha: "abc", healthzBody: body("def") }),
    ).toBe("stale");
  });

  it("is stale when the server omits git_sha (an old server predating the build id = #364 case)", () => {
    expect(
      classifyReuse({ expectedGitSha: "abc", healthzBody: body(undefined) }),
    ).toBe("stale");
  });
});
