import { describe, expect, it } from "vitest";

import {
  isUuidSid,
  parseSaveFile,
  type SaveEntry,
  serializeSaveFile,
} from "./save-file.js";

describe("parseSaveFile", () => {
  const cases: {
    name: string;
    input: string;
    expected: SaveEntry[];
  }[] = [
    {
      name: "basic form (widx\\twname\\tcwd\\tsid)",
      input:
        "1\twhiskey:579f\t/Users/u/workspace/whiskey\t579fa8cf-4901-45cb-b9ec-17e229231a37\n",
      expected: [
        {
          widx: "1",
          wname: "whiskey:579f",
          cwd: "/Users/u/workspace/whiskey",
          sid: "579fa8cf-4901-45cb-b9ec-17e229231a37",
        },
      ],
    },
    {
      name: "multiple lines + no trailing newline",
      input:
        "1\ta\t/tmp/a\t11111111-1111-1111-1111-111111111111\n2\tb\t/tmp/b\t22222222-2222-2222-2222-222222222222",
      expected: [
        {
          widx: "1",
          wname: "a",
          cwd: "/tmp/a",
          sid: "11111111-1111-1111-1111-111111111111",
        },
        {
          widx: "2",
          wname: "b",
          cwd: "/tmp/b",
          sid: "22222222-2222-2222-2222-222222222222",
        },
      ],
    },
    {
      name: "skips blank and whitespace-only lines",
      input: "\n1\ta\t/tmp/a\t11111111-1111-1111-1111-111111111111\n\n   \n",
      expected: [
        {
          widx: "1",
          wname: "a",
          cwd: "/tmp/a",
          sid: "11111111-1111-1111-1111-111111111111",
        },
      ],
    },
    {
      name: "skips lines with too few fields (3 columns or fewer)",
      input:
        "1\ta\t/tmp/a\nbroken line\n2\tb\t/tmp/b\t22222222-2222-2222-2222-222222222222\n",
      expected: [
        {
          widx: "2",
          wname: "b",
          cwd: "/tmp/b",
          sid: "22222222-2222-2222-2222-222222222222",
        },
      ],
    },
    {
      name: "skips lines with an empty sid (cw-restore compatible)",
      input:
        "1\ta\t/tmp/a\t\n2\tb\t/tmp/b\t22222222-2222-2222-2222-222222222222\n",
      expected: [
        {
          widx: "2",
          wname: "b",
          cwd: "/tmp/b",
          sid: "22222222-2222-2222-2222-222222222222",
        },
      ],
    },
    {
      name: "skips lines with an empty cwd",
      input: "1\ta\t\t11111111-1111-1111-1111-111111111111\n",
      expected: [],
    },
    {
      name: "ignores extra columns beyond 5 (forward compatible)",
      input:
        "1\ta\t/tmp/a\t11111111-1111-1111-1111-111111111111\textra\tmore\n",
      expected: [
        {
          widx: "1",
          wname: "a",
          cwd: "/tmp/a",
          sid: "11111111-1111-1111-1111-111111111111",
        },
      ],
    },
    {
      name: "keeps a non-UUID sid too (compatible with cw's jsonl fallback; the restore side decides whether it can launch)",
      input: "5\tdelta:03f2\t/tmp/x\tworkspace\n",
      expected: [
        { widx: "5", wname: "delta:03f2", cwd: "/tmp/x", sid: "workspace" },
      ],
    },
    {
      name: "an empty string yields an empty array",
      input: "",
      expected: [],
    },
  ];

  it.each(cases)("$name", ({ input, expected }) => {
    expect(parseSaveFile(input)).toEqual(expected);
  });
});

describe("serializeSaveFile", () => {
  it("outputs last.tsv-compatible tab-separated lines with a trailing newline", () => {
    const entries: SaveEntry[] = [
      {
        widx: "1",
        wname: "whiskey",
        cwd: "/tmp/whiskey",
        sid: "11111111-1111-1111-1111-111111111111",
      },
      {
        widx: "2",
        wname: "delta",
        cwd: "/tmp/delta",
        sid: "22222222-2222-2222-2222-222222222222",
      },
    ];
    expect(serializeSaveFile(entries)).toBe(
      "1\twhiskey\t/tmp/whiskey\t11111111-1111-1111-1111-111111111111\n" +
        "2\tdelta\t/tmp/delta\t22222222-2222-2222-2222-222222222222\n",
    );
  });

  it("an empty array yields an empty string", () => {
    expect(serializeSaveFile([])).toBe("");
  });

  it("collapses tabs and newlines within a field to spaces (prevents format corruption)", () => {
    const out = serializeSaveFile([
      {
        widx: "1",
        wname: "bad\tname\nx",
        cwd: "/tmp/a",
        sid: "11111111-1111-1111-1111-111111111111",
      },
    ]);
    expect(out).toBe(
      "1\tbad name x\t/tmp/a\t11111111-1111-1111-1111-111111111111\n",
    );
  });

  it("round-trips with parse", () => {
    const entries: SaveEntry[] = [
      {
        widx: "1",
        wname: "a:b8b0",
        cwd: "/tmp/a",
        sid: "11111111-1111-1111-1111-111111111111",
      },
    ];
    expect(parseSaveFile(serializeSaveFile(entries))).toEqual(entries);
  });
});

describe("isUuidSid", () => {
  it.each([
    ["579fa8cf-4901-45cb-b9ec-17e229231a37", true],
    ["579FA8CF-4901-45CB-B9EC-17E229231A37", true],
    ["workspace", false],
    ["", false],
    ["11111111-1111-1111-1111-11111111111", false],
    ["x; rm -rf /", false],
  ])("%s → %s", (sid, expected) => {
    expect(isUuidSid(sid)).toBe(expected);
  });
});
