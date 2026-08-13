import { describe, expect, it } from "vitest";

import { controlWsUrl, termWsUrl, wsUrl } from "./url.js";

describe("wsUrl", () => {
  it("converts an http origin to ws and appends the token as a query", () => {
    expect(wsUrl("http://127.0.0.1:8790", "/ws/control", "tok")).toBe(
      "ws://127.0.0.1:8790/ws/control?token=tok",
    );
  });
  it("https becomes wss", () => {
    expect(wsUrl("https://localhost:8790", "/ws/control", "tok")).toBe(
      "wss://localhost:8790/ws/control?token=tok",
    );
  });
  it("the token is URL-encoded", () => {
    expect(wsUrl("http://localhost:1", "/p", "a/b c")).toBe(
      "ws://localhost:1/p?token=a%2Fb%20c",
    );
  });
});

describe("control/term URL", () => {
  it("builds the control and term paths", () => {
    expect(controlWsUrl("http://127.0.0.1:8790", "tok")).toBe(
      "ws://127.0.0.1:8790/ws/control?token=tok",
    );
    expect(termWsUrl("http://127.0.0.1:8790", "abc-1", "tok")).toBe(
      "ws://127.0.0.1:8790/ws/term/abc-1?token=tok",
    );
  });
});
