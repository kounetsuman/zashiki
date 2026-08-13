import { describe, expect, it } from "vitest";

import {
  buildProcessMaps,
  findSidInTree,
  parsePsSnapshot,
  resolveIdentitySid,
  sidFromArgs,
} from "./process-tree.js";

const SID = "0b6cbc45-83a9-4f2e-9c3d-1a2b3c4d5e6f";

describe("sidFromArgs (port of dom_sid_from_args)", () => {
  it("reads the UUID from --session-id", () => {
    expect(sidFromArgs(`claude --session-id ${SID}`)).toBe(SID);
  });

  it("reads the UUID from --resume", () => {
    expect(sidFromArgs(`claude --resume ${SID} --continue`)).toBe(SID);
  });

  it("reads the UUID from -r", () => {
    expect(sidFromArgs(`claude -r ${SID}`)).toBe(SID);
  });

  it("lowercases an uppercase UUID", () => {
    expect(sidFromArgs(`claude --session-id ${SID.toUpperCase()}`)).toBe(SID);
  });

  it("returns null when there is no UUID", () => {
    expect(sidFromArgs("claude --continue")).toBeNull();
    expect(sidFromArgs("")).toBeNull();
  });

  it("takes only the first match", () => {
    const other = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    expect(sidFromArgs(`claude --session-id ${SID} --resume ${other}`)).toBe(
      SID,
    );
  });
});

describe("parsePsSnapshot (parsing ps -o pid=,ppid=,args= output)", () => {
  it("reads pid/ppid/args (preserves whitespace in args)", () => {
    const out = `    1     0 /sbin/launchd\n  200     1 tmux -L zashiki\n  300   200 claude --session-id ${SID}\n`;
    expect(parsePsSnapshot(out)).toEqual([
      { pid: 1, ppid: 0, args: "/sbin/launchd" },
      { pid: 200, ppid: 1, args: "tmux -L zashiki" },
      { pid: 300, ppid: 200, args: `claude --session-id ${SID}` },
    ]);
  });

  it("skips blank and malformed lines", () => {
    expect(parsePsSnapshot("\ngarbage line\n")).toEqual([]);
  });

  it("reads pid/ppid/args even with a leading tty column (-o tty=,pid=,ppid=,args=)", () => {
    const out = [
      `ttys003  300 200 claude --session-id ${SID}`,
      "??       200   1 tmux -L zashiki",
      "-        400   1 -zsh",
    ].join("\n");
    expect(parsePsSnapshot(out)).toEqual([
      { pid: 300, ppid: 200, args: `claude --session-id ${SID}` },
      { pid: 200, ppid: 1, args: "tmux -L zashiki" },
      { pid: 400, ppid: 1, args: "-zsh" },
    ]);
  });
});

describe("findSidInTree (BFS port of dom_find_sid_in_tree)", () => {
  const entries = parsePsSnapshot(
    [
      "  100    1 -zsh",
      `  110  100 claude --session-id ${SID}`,
      "  120  100 vim",
      "  200    1 -zsh",
      "  210  200 node server.js",
      `  211  210 claude --resume aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeffff`,
    ].join("\n"),
  );
  const maps = buildProcessMaps(entries);

  it("returns the sid when claude is a direct child", () => {
    expect(findSidInTree(100, maps)).toBe(SID);
  });

  it("finds it by traversing down to a grandchild (via node)", () => {
    expect(findSidInTree(200, maps)).toBe(
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeffff",
    );
  });

  it("returns the origin's sid when the origin itself is claude", () => {
    expect(findSidInTree(110, maps)).toBe(SID);
  });

  it("returns null when there is no claude in the tree", () => {
    expect(findSidInTree(120, maps)).toBeNull();
  });

  it("returns null for a nonexistent pid (does not throw)", () => {
    expect(findSidInTree(9999, maps)).toBeNull();
  });
});

describe("buildProcessMaps", () => {
  it("does not put non-claude processes in the sid lookup table", () => {
    const entries = parsePsSnapshot(
      `  100    1 some-tool --session-id ${SID}\n`,
    );
    const maps = buildProcessMaps(entries);
    expect(findSidInTree(100, maps)).toBeNull();
  });

  it("terminates even when parent/child data is cyclic (defensive)", () => {
    const entries = parsePsSnapshot("  100  200 -zsh\n  200  100 -zsh\n");
    const maps = buildProcessMaps(entries);
    expect(findSidInTree(100, maps)).toBeNull();
  });
});

describe("resolveIdentitySid (stamped sid fallback)", () => {
  const STAMP = "11111111-2222-3333-4444-555555555555";

  it("prefers the running claude's sid (liveSid) above all", () => {
    expect(resolveIdentitySid(SID, STAMP)).toBe(SID);
  });

  it("returns liveSid without transformation (assumes the caller already lowercased it via sidFromArgs)", () => {
    const upper = SID.toUpperCase();
    expect(resolveIdentitySid(upper, STAMP)).toBe(upper);
  });

  it("falls back to the window's stamped sid when there is no liveSid (allows rename even after claude exits)", () => {
    expect(resolveIdentitySid(null, STAMP)).toBe(STAMP);
  });

  it("lowercases the stamped sid", () => {
    expect(resolveIdentitySid(null, STAMP.toUpperCase())).toBe(STAMP);
  });

  it("returns undefined when there is neither a liveSid nor a stamp", () => {
    expect(resolveIdentitySid(null, undefined)).toBeUndefined();
  });

  it("does not use the stamp unless it is a UUID (prevents bucket contamination)", () => {
    expect(resolveIdentitySid(null, "not-a-uuid")).toBeUndefined();
    expect(resolveIdentitySid(null, "")).toBeUndefined();
  });
});
