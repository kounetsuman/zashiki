import { describe, expect, it } from "vitest";

import {
  filterTopics,
  groupTopics,
  type HelpCategoryDef,
  type HelpTopic,
  parseHelpTopic,
  parseInline,
  parseMarkdownBlocks,
  sortTopics,
} from "./help-model.js";

describe("parseHelpTopic", () => {
  it("derives id/order from the filename, the title from the leading h1, and the rest as the body", () => {
    const t = parseHelpTopic(
      "./content/03-session-list.md",
      "# セッション一覧の見方\n\n本文1\n本文2\n",
    );
    expect(t).toEqual({
      id: "session-list",
      order: 3,
      title: "セッション一覧の見方",
      body: "本文1\n本文2",
    });
  });

  it("when there is no h1, uses the id as the title and keeps the body as-is (any # from the second line on stays in the body)", () => {
    const t = parseHelpTopic("10-keybindings.md", "## 見出し\n中身\n");
    expect(t.id).toBe("keybindings");
    expect(t.order).toBe(10);
    expect(t.title).toBe("keybindings");
    expect(t.body).toBe("## 見出し\n中身");
  });

  it("without a numeric prefix, order is sent to the end", () => {
    const t = parseHelpTopic("intro.md", "# Intro\n");
    expect(t.order).toBe(Number.POSITIVE_INFINITY);
    expect(t.id).toBe("intro");
  });

  it("a # in the middle of the body is not promoted to the title and stays in the body (leading only)", () => {
    const t = parseHelpTopic("1-x.md", "本文先頭\n# 見出し\n中身\n");
    expect(t.title).toBe("x");
    expect(t.body).toBe("本文先頭\n# 見出し\n中身");
  });

  it("skips leading blank lines and uses the first non-empty line as the title if it is an h1", () => {
    const t = parseHelpTopic("1-x.md", "\n\n# タイトル\n本文\n");
    expect(t.title).toBe("タイトル");
    expect(t.body).toBe("本文");
  });
});

describe("sortTopics", () => {
  it("sorts by ascending order, and stably by title for ties", () => {
    const mk = (order: number, title: string): HelpTopic => ({
      id: title,
      order,
      title,
      body: "",
    });
    const sorted = sortTopics([mk(3, "c"), mk(1, "a"), mk(1, "b")]);
    expect(sorted.map((t) => t.title)).toEqual(["a", "b", "c"]);
  });
});

describe("groupTopics", () => {
  const mk = (id: string): HelpTopic => ({
    id,
    order: 0,
    title: id.toUpperCase(),
    body: "",
  });
  const defs: HelpCategoryDef[] = [
    { id: "config", titleKey: "設定ファイル", topicIds: ["repos-conf"] },
    {
      id: "general",
      titleKey: "全般",
      topicIds: ["keybindings", "navigation"],
    },
    { id: "sub", titleKey: "サブパネル", topicIds: ["explorer", "search"] },
  ];

  it("groups in the order of the category definitions and orders within a category by the id list", () => {
    // Intentionally offset the input order from the definition order
    const groups = groupTopics(
      [
        mk("search"),
        mk("repos-conf"),
        mk("navigation"),
        mk("explorer"),
        mk("keybindings"),
      ],
      defs,
    );
    expect(groups.map((g) => g.titleKey)).toEqual([
      "設定ファイル",
      "全般",
      "サブパネル",
    ]);
    expect(groups.map((g) => g.topics.map((t) => t.id))).toEqual([
      ["repos-conf"],
      ["keybindings", "navigation"],
      ["explorer", "search"],
    ]);
  });

  it("does not return categories with no matching topics (no empty categories)", () => {
    const groups = groupTopics([mk("repos-conf")], defs);
    expect(groups.map((g) => g.titleKey)).toEqual(["設定ファイル"]);
  });

  it('topics not in the definitions fall into a trailing "Other" category in order/title order', () => {
    const orphan = (id: string, order: number): HelpTopic => ({
      id,
      order,
      title: id,
      body: "",
    });
    const groups = groupTopics(
      [orphan("zeta", 2), mk("repos-conf"), orphan("alpha", 1)],
      defs,
    );
    expect(groups.map((g) => g.titleKey)).toEqual([
      "設定ファイル",
      "help.category.other",
    ]);
    const other = groups[groups.length - 1];
    expect(other?.topics.map((t) => t.id)).toEqual(["alpha", "zeta"]);
  });

  it('does not create an "Other" category when all topics are already classified', () => {
    const groups = groupTopics([mk("repos-conf"), mk("explorer")], defs);
    expect(groups.some((g) => g.id === "other")).toBe(false);
  });

  it("when the same id is placed in multiple categories, the first-appearing category wins without duplication", () => {
    const dup: HelpCategoryDef[] = [
      { id: "a", titleKey: "A", topicIds: ["explorer"] },
      { id: "b", titleKey: "B", topicIds: ["explorer"] },
    ];
    const groups = groupTopics([mk("explorer")], dup);
    expect(groups.map((g) => g.titleKey)).toEqual(["A"]);
    expect(groups[0]?.topics.map((t) => t.id)).toEqual(["explorer"]);
  });

  it("does not fail when a defined id is absent from the input (picks up only what exists)", () => {
    const groups = groupTopics([mk("explorer")], defs);
    expect(groups.map((g) => g.titleKey)).toEqual(["サブパネル"]);
    expect(groups[0]?.topics.map((t) => t.id)).toEqual(["explorer"]);
  });
});

describe("filterTopics", () => {
  const topics: HelpTopic[] = [
    {
      id: "a",
      order: 1,
      title: "repos.conf と org 色",
      body: "行末に #RRGGBB",
    },
    { id: "b", order: 2, title: "キーバインド", body: "Ctrl-N で新規" },
  ];

  it("an empty query returns all", () => {
    expect(filterTopics(topics, "  ").map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("matches by title (case-insensitive)", () => {
    expect(filterTopics(topics, "REPOS").map((t) => t.id)).toEqual(["a"]);
  });

  it("matches by body", () => {
    expect(filterTopics(topics, "ctrl-n").map((t) => t.id)).toEqual(["b"]);
  });

  it("no match returns empty", () => {
    expect(filterTopics(topics, "存在しない")).toEqual([]);
  });
});

describe("parseInline", () => {
  it("splits text inside backticks as code and outside as text", () => {
    expect(parseInline("設定は `repos.conf` を編集")).toEqual([
      { kind: "text", text: "設定は " },
      { kind: "code", text: "repos.conf" },
      { kind: "text", text: " を編集" },
    ]);
  });

  it("an unclosed backtick is treated as text", () => {
    expect(parseInline("a `b")).toEqual([{ kind: "text", text: "a `b" }]);
  });
});

describe("parseMarkdownBlocks", () => {
  it("breaks apart headings, paragraphs, bullet lists, and fenced code", () => {
    const blocks = parseMarkdownBlocks(
      [
        "# 大見出し",
        "## 小見出し",
        "段落1a",
        "段落1b",
        "",
        "- 項目1",
        "- 項目2",
        "",
        "```",
        "code line",
        "```",
      ].join("\n"),
    );
    expect(blocks[0]).toEqual({
      kind: "heading",
      level: 1,
      spans: [{ kind: "text", text: "大見出し" }],
    });
    expect(blocks[1]).toEqual({
      kind: "heading",
      level: 2,
      spans: [{ kind: "text", text: "小見出し" }],
    });
    // Consecutive plain lines merge into one paragraph
    expect(blocks[2]).toEqual({
      kind: "paragraph",
      spans: [{ kind: "text", text: "段落1a 段落1b" }],
    });
    expect(blocks[3]).toEqual({
      kind: "list",
      items: [
        [{ kind: "text", text: "項目1" }],
        [{ kind: "text", text: "項目2" }],
      ],
    });
    expect(blocks[4]).toEqual({ kind: "code", text: "code line" });
  });

  it("does not interpret heading/bullet-list syntax inside a code fence", () => {
    const blocks = parseMarkdownBlocks(
      ["```", "# not heading", "- not list", "```"].join("\n"),
    );
    expect(blocks).toEqual([
      { kind: "code", text: "# not heading\n- not list" },
    ]);
  });
});
