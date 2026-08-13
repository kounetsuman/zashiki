import { describe, expect, it } from "vitest";

import {
  countRunningShellsBySid,
  isBashWrapperArgs,
  parseLsofFdOutputs,
} from "./shells.js";

describe("isBashWrapperArgs", () => {
  const WRAPPER =
    "/bin/zsh -c source /Users/x/.claude/shell-snapshots/snapshot-zsh-1785832386151-14k7pp.sh 2>/dev/null || true && setopt NO_EXTENDED_GLOB 2>/dev/null || true && eval 'make ci' < /dev/null && pwd -P >| /tmp/claude-1f2b-cwd";

  it("true for Claude Code's Bash wrapper form", () => {
    expect(isBashWrapperArgs(WRAPPER)).toBe(true);
  });

  it("false for ordinary zsh/vim/claude", () => {
    expect(isBashWrapperArgs("-zsh")).toBe(false);
    expect(isBashWrapperArgs("vim foo.ts")).toBe(false);
    expect(isBashWrapperArgs("claude --session-id abc")).toBe(false);
    // Quoted text that contains snapshot but lacks eval, etc., is false
    expect(
      isBashWrapperArgs("/bin/zsh -c echo shell-snapshots/snapshot-x"),
    ).toBe(false);
  });
});

const SID_A = "a2814219-c53d-4def-b542-5e71aeddab2b";
const SID_B = "631587f4-bed5-4eec-8b43-8e162bf1e5c6";

// Machine-readable output of lsof -F pfn (p=pid / f=fd / n=name). Faithful to a real captured form.
const LSOF = `p44413
f1
n/private/tmp/claude-501/-Users-kilo-workspace-whiskey/${SID_A}/tasks/bush20ok3.output
p73096
f1
n/private/tmp/claude-501/-Users-kilo-workspace-whiskey/${SID_B}/tasks/bh8hl40cs.output
`;

describe("parseLsofFdOutputs", () => {
  it("extracts sid and taskId from a wrapper whose fd1 is <sid>/tasks/<id>.output", () => {
    expect(parseLsofFdOutputs(LSOF)).toEqual([
      { sid: SID_A, taskId: "bush20ok3" },
      { sid: SID_B, taskId: "bh8hl40cs" },
    ]);
  });

  it("ignores fds that are not tasks/*.output (tmux pty or other files)", () => {
    const out = `p100
f1
n/dev/ttys003
p200
f1
n/private/tmp/claude-501/-Users-x/${SID_A}/tasks/abc12345x.output
`;
    expect(parseLsofFdOutputs(out)).toEqual([
      { sid: SID_A, taskId: "abc12345x" },
    ]);
  });

  it("excludes fds other than fd1 (e.g. f2)", () => {
    const out = `p300
f2
n/private/tmp/claude-501/-Users-x/${SID_A}/tasks/zzz99999z.output
`;
    expect(parseLsofFdOutputs(out)).toEqual([]);
  });

  it("returns [] for empty strings and malformed lines", () => {
    expect(parseLsofFdOutputs("")).toEqual([]);
    expect(parseLsofFdOutputs("garbage\n\n")).toEqual([]);
  });
});

describe("countRunningShellsBySid", () => {
  it("counts only live wrappers whose taskId is in that sid's backgroundTaskId set", () => {
    const outputs = [
      { sid: SID_A, taskId: "bush20ok3" }, // bg (match)
      { sid: SID_A, taskId: "fgonly123" }, // fg (no match) -> excluded
      { sid: SID_B, taskId: "bh8hl40cs" }, // bg (match)
    ];
    const bgIdsBySid = new Map<string, Set<string>>([
      [SID_A, new Set(["bush20ok3", "b48tqxha9"])],
      [SID_B, new Set(["bh8hl40cs"])],
    ]);
    expect(countRunningShellsBySid(outputs, bgIdsBySid)).toEqual(
      new Map([
        [SID_A, 1],
        [SID_B, 1],
      ]),
    );
  });

  it("adds up when multiple bg shells persist under the same sid", () => {
    const outputs = [
      { sid: SID_A, taskId: "bush20ok3" },
      { sid: SID_A, taskId: "b48tqxha9" },
    ];
    const bgIdsBySid = new Map<string, Set<string>>([
      [SID_A, new Set(["bush20ok3", "b48tqxha9"])],
    ]);
    expect(countRunningShellsBySid(outputs, bgIdsBySid)).toEqual(
      new Map([[SID_A, 2]]),
    );
  });

  it("a sid with no backgroundTaskId set is 0 (does not create the key at all)", () => {
    const outputs = [{ sid: SID_A, taskId: "fgonly123" }];
    expect(countRunningShellsBySid(outputs, new Map())).toEqual(new Map());
  });
});
