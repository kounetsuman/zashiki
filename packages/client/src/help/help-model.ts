/**
 * One help item = one markdown file. The pure logic needed for display
 * (extracting title/order, search filtering, block decomposition of lightweight markdown)
 * is gathered here and guarded by Vitest. Rendering (React) is a thin layer on the HelpModal side.
 */

export interface HelpTopic {
  /** The slug from the filename with the numeric prefix and extension removed. */
  id: string;
  /** Display order (the leading number in the filename; sent to the end if absent). */
  order: number;
  /** The leading `# ` heading (falls back to the id if absent). */
  title: string;
  /** The body with the leading h1 removed. */
  body: string;
}

/** `content/03-session-list.md` -> { id:"session-list", order:3 }. */
function idAndOrderFromPath(path: string): { id: string; order: number } {
  const file = path.split("/").pop() ?? path;
  const base = file.replace(/\.md$/i, "");
  const m = base.match(/^(\d+)[-_](.+)$/);
  if (m) return { id: m[2] ?? base, order: Number(m[1]) };
  return { id: base, order: Number.POSITIVE_INFINITY };
}

/**
 * Decomposes one file's raw text into a HelpTopic. **Only when the first non-empty line is an h1**
 * is it used as the title and removed from the body (a `# ` mid-body is not promoted to the title).
 */
export function parseHelpTopic(path: string, raw: string): HelpTopic {
  const { id, order } = idAndOrderFromPath(path);
  const normalized = raw.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  let idx = 0;
  while (idx < lines.length && (lines[idx] ?? "").trim() === "") idx++;
  const h1 = (lines[idx] ?? "").match(/^#\s+(.+?)\s*$/);
  if (h1) {
    return {
      id,
      order,
      title: h1[1] ?? id,
      body: lines
        .slice(idx + 1)
        .join("\n")
        .trim(),
    };
  }
  return { id, order, title: id, body: normalized.trim() };
}

/** Sort by order ascending, then (for ties) by title. */
export function sortTopics(topics: readonly HelpTopic[]): HelpTopic[] {
  return [...topics].sort(
    (a, b) => a.order - b.order || a.title.localeCompare(b.title),
  );
}

/** A category definition (display-name key, member topic id list; display order is the array order). */
export interface HelpCategoryDef {
  id: string;
  titleKey: string;
  /** The topic ids belonging to this category, in display order. */
  topicIds: readonly string[];
}

/** One category after grouping (for display). */
export interface HelpCategory {
  id: string;
  titleKey: string;
  topics: HelpTopic[];
}

/**
 * Bundles topics in the order of the category definitions. Within a category, order follows
 * `topicIds`, and empty categories are not returned. Topics belonging to no definition fall
 * into the trailing "Other" (`fallbackTitleKey`) in order->title order (so nothing is dropped).
 * If the same id appears in multiple categories, **the first category wins** and it is not duplicated.
 */
export function groupTopics(
  topics: readonly HelpTopic[],
  defs: readonly HelpCategoryDef[],
  fallbackTitleKey = "help.category.other",
): HelpCategory[] {
  const byId = new Map(topics.map((t) => [t.id, t]));
  const assigned = new Set<string>();
  const groups: HelpCategory[] = [];

  for (const def of defs) {
    const picked: HelpTopic[] = [];
    for (const id of def.topicIds) {
      const t = byId.get(id);
      if (t && !assigned.has(id)) {
        picked.push(t);
        assigned.add(id);
      }
    }
    if (picked.length > 0) {
      groups.push({ id: def.id, titleKey: def.titleKey, topics: picked });
    }
  }

  const leftover = topics.filter((t) => !assigned.has(t.id));
  if (leftover.length > 0) {
    groups.push({
      id: "other",
      titleKey: fallbackTitleKey,
      topics: sortTopics(leftover),
    });
  }
  return groups;
}

/** Returns only items whose title or body contains query (case-insensitive; an empty query returns all). */
export function filterTopics(
  topics: readonly HelpTopic[],
  query: string,
): HelpTopic[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...topics];
  return topics.filter(
    (t) =>
      t.title.toLowerCase().includes(q) || t.body.toLowerCase().includes(q),
  );
}

// ---- Lightweight markdown (a minimal subset for our own authored content) ----

export type InlineSpan =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string };

export type MarkdownBlock =
  | { kind: "heading"; level: 1 | 2; spans: InlineSpan[] }
  | { kind: "paragraph"; spans: InlineSpan[] }
  | { kind: "list"; items: InlineSpan[][] }
  | { kind: "code"; text: string };

/** Splits backtick-wrapped spans into code and the rest into text. */
export function parseInline(text: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let rest = text;
  for (;;) {
    const open = rest.indexOf("`");
    if (open < 0) {
      if (rest !== "") spans.push({ kind: "text", text: rest });
      break;
    }
    const close = rest.indexOf("`", open + 1);
    if (close < 0) {
      spans.push({ kind: "text", text: rest });
      break;
    }
    if (open > 0) spans.push({ kind: "text", text: rest.slice(0, open) });
    spans.push({ kind: "code", text: rest.slice(open + 1, close) });
    rest = rest.slice(close + 1);
  }
  return spans;
}

/**
 * Turns the body into a block sequence of paragraphs, headings (#/##), list items (- ), and fenced code (```).
 * Consecutive plain lines merge into one paragraph (newlines become spaces).
 */
export function parseMarkdownBlocks(body: string): MarkdownBlock[] {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let para: string[] = [];
  let list: string[] = [];

  const flushPara = (): void => {
    if (para.length > 0) {
      blocks.push({ kind: "paragraph", spans: parseInline(para.join(" ")) });
      para = [];
    }
  };
  const flushList = (): void => {
    if (list.length > 0) {
      blocks.push({ kind: "list", items: list.map(parseInline) });
      list = [];
    }
  };
  const flushAll = (): void => {
    flushPara();
    flushList();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trimStart().startsWith("```")) {
      flushAll();
      const code: string[] = [];
      i++;
      while (
        i < lines.length &&
        !(lines[i] ?? "").trimStart().startsWith("```")
      ) {
        code.push(lines[i] ?? "");
        i++;
      }
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    const h = line.match(/^(#{1,2})\s+(.+?)\s*$/);
    if (h) {
      flushAll();
      blocks.push({
        kind: "heading",
        level: (h[1] ?? "#").length === 2 ? 2 : 1,
        spans: parseInline(h[2] ?? ""),
      });
      continue;
    }
    const li = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (li) {
      flushPara();
      list.push(li[1] ?? "");
      continue;
    }
    if (line.trim() === "") {
      flushAll();
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  flushAll();
  return blocks;
}
