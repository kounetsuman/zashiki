import type { SessionEvent } from "@zashiki/shared";
import { describe, expect, it } from "vitest";

import {
  externalTools,
  filterCounts,
  fmtClock,
  fmtEventDuration,
  isHighlighted,
  isRunning,
  summarize,
  timelineEvents,
} from "./session-stats.js";

let clock = 0;

function ev(partial: Partial<SessionEvent> & Pick<SessionEvent, "kind">) {
  clock += 1;
  return { at: clock, text: "", ...partial } as SessionEvent;
}

const read = (path: string) =>
  ev({ kind: "read", tool: "Read", text: path, target: path, outcome: "ok" });
const edit = (path: string) =>
  ev({ kind: "edit", tool: "Edit", text: path, target: path, outcome: "ok" });
const command = (
  text: string,
  target: string,
  outcome: SessionEvent["outcome"] = "ok",
  domains?: string[],
  via?: string[],
) => ev({ kind: "command", tool: "Bash", text, target, outcome, domains, via });
const fetchUrl = (url: string, host: string) =>
  ev({ kind: "web", tool: "WebFetch", text: url, domains: [host] });

describe("summarize: files", () => {
  it("counts reads and edits per file separately, ranked by their sum then path", () => {
    const { files } = summarize([
      read("b.ts"),
      edit("a.ts"),
      read("a.ts"),
      read("c.ts"),
      read("c.ts"),
      edit("c.ts"),
      read("b.ts"),
    ]);
    expect(files.rows).toEqual([
      { key: "c.ts", reads: 2, edits: 1 },
      { key: "a.ts", reads: 1, edits: 1 },
      { key: "b.ts", reads: 2, edits: 0 },
    ]);
    expect(files.reads).toBe(5);
    expect(files.edits).toBe(2);
  });

  it("ties are broken by key ascending", () => {
    const { files } = summarize([read("z"), read("a"), read("m")]);
    expect(files.rows.map((r) => r.key)).toEqual(["a", "m", "z"]);
  });

  it("ignores events without a target", () => {
    expect(summarize([ev({ kind: "read" })]).files.rows).toEqual([]);
  });
});

describe("summarize: commands", () => {
  it("counts runs and failures per command group, ranked by runs", () => {
    const { commands } = summarize([
      command("git status", "git"),
      command("pnpm test", "pnpm test", "failed"),
      command("pnpm test --run", "pnpm test", "ok"),
      command("pnpm test", "pnpm test", "failed"),
      command("git log", "git log"),
      command("git diff", "git"),
    ]);
    expect(commands.rows).toEqual([
      { key: "pnpm test", runs: 3, failures: 2 },
      { key: "git", runs: 2, failures: 0 },
      { key: "git log", runs: 1, failures: 0 },
    ]);
    expect(commands.runs).toBe(6);
    expect(commands.failures).toBe(2);
  });

  it("a denied command is a run but not a failure", () => {
    const { commands } = summarize([command("rm -rf x", "rm", "denied")]);
    expect(commands.rows).toEqual([{ key: "rm", runs: 1, failures: 0 }]);
  });
});

describe("summarize: external access", () => {
  it("counts visits per domain with the tools that made them", () => {
    const { external } = summarize([
      fetchUrl("https://docs.rs/a", "docs.rs"),
      command("curl -s https://docs.rs/b", "curl", "ok", ["docs.rs"], ["curl"]),
      ev({
        kind: "web",
        tool: "mcp__playwright__browser_navigate",
        text: "http://localhost:5173/",
        domains: ["localhost"],
      }),
      fetchUrl("https://docs.rs/c", "docs.rs"),
    ]);
    expect(external.rows).toEqual([
      { key: "docs.rs", visits: 3, tools: ["WebFetch", "curl"] },
      { key: "localhost", visits: 1, tools: ["browser_navigate"] },
    ]);
    expect(external.visits).toBe(4);
  });

  it("one call reaching two domains is a visit to each", () => {
    const { external } = summarize([
      command("wget https://a.example/ https://b.example/", "wget", "ok", [
        "a.example",
        "b.example",
      ]),
    ]);
    expect(external.rows.map((r) => [r.key, r.visits])).toEqual([
      ["a.example", 1],
      ["b.example", 1],
    ]);
  });
});

describe("externalTools", () => {
  it("names the programs the server says reached the domains", () => {
    expect(
      externalTools(
        command("echo start", "echo", "ok", ["late.example"], ["curl"]),
      ),
    ).toEqual(["curl"]);
    expect(
      externalTools(
        command(
          "echo 'no curl' && wget https://b/",
          "echo",
          "ok",
          ["b"],
          ["wget"],
        ),
      ),
    ).toEqual(["wget"]);
    expect(
      externalTools(
        command("curl x | wget y", "curl", "ok", ["a"], ["curl", "wget"]),
      ),
    ).toEqual(["curl", "wget"]);
  });

  it("falls back to the tool name", () => {
    expect(
      externalTools(command("curl https://a/", "curl", "ok", ["a"])),
    ).toEqual(["Bash"]);
    expect(externalTools(fetchUrl("https://a/", "a"))).toEqual(["WebFetch"]);
  });
});

describe("summarize: denials", () => {
  it("counts denials per operation with who stopped them", () => {
    const { denials } = summarize([
      command("rm -rf x", "rm", "denied"),
      ev({
        kind: "command",
        text: "git push -f",
        target: "git push",
        outcome: "denied",
        deniedBy: "hook",
      }),
      ev({
        kind: "command",
        text: "git push -f",
        target: "git push",
        outcome: "denied",
        deniedBy: "user",
      }),
      ev({
        kind: "command",
        text: "git push -f",
        target: "git push",
        outcome: "denied",
        deniedBy: "hook",
      }),
      command("ls", "ls", "failed"),
    ]);
    expect(denials.rows).toEqual([
      { key: "git push -f", count: 3, deniedBy: ["hook", "user"] },
      { key: "rm -rf x", count: 1, deniedBy: [] },
    ]);
    expect(denials.count).toBe(4);
  });
});

describe("timelineEvents", () => {
  const events = [
    ev({ kind: "prompt", text: "go" }),
    read("a.ts"),
    edit("b.ts"),
    command("pnpm test", "pnpm test", "failed"),
    command("curl https://x.example/", "curl", "denied", ["x.example"]),
    fetchUrl("https://y.example/", "y.example"),
    ev({ kind: "compaction", text: "auto", preTokens: 2, postTokens: 1 }),
  ];

  it("all keeps every event in order", () => {
    expect(timelineEvents(events, "all", null)).toEqual(events);
  });

  it("each group keeps its own events", () => {
    const kinds = (filter: Parameters<typeof timelineEvents>[1]) =>
      timelineEvents(events, filter, null).map((e) => e.text);
    expect(kinds("files")).toEqual(["a.ts", "b.ts"]);
    expect(kinds("commands")).toEqual(["pnpm test", "curl https://x.example/"]);
    expect(kinds("external")).toEqual([
      "curl https://x.example/",
      "https://y.example/",
    ]);
    expect(kinds("denials")).toEqual(["curl https://x.example/"]);
  });

  it("a row filter narrows to that Summary row's events", () => {
    const narrowed = (
      group: "files" | "commands" | "external" | "denials",
      key: string,
    ) => timelineEvents(events, group, { group, key }).map((e) => e.text);
    expect(narrowed("files", "b.ts")).toEqual(["b.ts"]);
    expect(narrowed("commands", "pnpm test")).toEqual(["pnpm test"]);
    expect(narrowed("external", "y.example")).toEqual(["https://y.example/"]);
    expect(narrowed("denials", "curl https://x.example/")).toEqual([
      "curl https://x.example/",
    ]);
  });

  it("counts each filter's events", () => {
    expect(filterCounts(events)).toEqual({
      all: 7,
      files: 2,
      commands: 2,
      external: 2,
      denials: 1,
    });
  });
});

describe("filter counts and Summary totals", () => {
  it("count the same events, so a call without a target is in neither", () => {
    const events = [
      read("a.ts"),
      ev({ kind: "read", tool: "Read" }),
      ev({ kind: "edit", tool: "Edit" }),
      ev({ kind: "command", tool: "Bash" }),
      command("ls", "ls"),
    ];
    const summary = summarize(events);
    const counts = filterCounts(events);
    expect(counts.files).toBe(summary.files.reads + summary.files.edits);
    expect(counts.commands).toBe(summary.commands.runs);
    expect(timelineEvents(events, "files", null)).toEqual([events[0]]);
  });
});

describe("isHighlighted", () => {
  it("highlights failed and denied calls only", () => {
    expect(isHighlighted(command("x", "x", "failed"))).toBe(true);
    expect(isHighlighted(command("x", "x", "denied"))).toBe(true);
    expect(isHighlighted(command("x", "x", "ok"))).toBe(false);
    expect(isHighlighted(ev({ kind: "command" }))).toBe(false);
  });
});

describe("isRunning", () => {
  it("is a tool call still waiting for its result", () => {
    expect(isRunning(ev({ kind: "command", tool: "Bash" }))).toBe(true);
    expect(isRunning(command("x", "x", "ok"))).toBe(false);
    expect(isRunning(ev({ kind: "prompt" }))).toBe(false);
    expect(isRunning(ev({ kind: "interrupt" }))).toBe(false);
    expect(isRunning(ev({ kind: "compaction" }))).toBe(false);
  });
});

describe("fmtClock", () => {
  it("is the local wall clock as HH:MM:SS", () => {
    expect(fmtClock(new Date(2026, 10, 19, 4, 5, 6, 789).getTime())).toBe(
      "04:05:06",
    );
    expect(fmtClock(new Date(2026, 10, 19, 23, 59, 0).getTime())).toBe(
      "23:59:00",
    );
  });
});

describe("fmtEventDuration", () => {
  it("shows milliseconds under a second and the footer's format above", () => {
    expect(fmtEventDuration(0)).toBe("0ms");
    expect(fmtEventDuration(999)).toBe("999ms");
    expect(fmtEventDuration(1_500)).toBe("1s");
    expect(fmtEventDuration(125_000)).toBe("2m 5s");
  });
});
