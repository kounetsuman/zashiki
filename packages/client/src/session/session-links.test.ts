import type { SessionLink } from "@zashiki/shared";
import { describe, expect, it } from "vitest";

import {
  distinctLinkCount,
  filterChips,
  groupLinks,
  linksInTab,
  linkText,
  selectableFilter,
  tabCounts,
} from "./session-links.js";

function pr(n: number, tab: SessionLink["tab"] = "conversation"): SessionLink {
  return {
    url: `https://github.com/o/r/pull/${n}`,
    tab,
    kind: "pr",
    source: "user",
    github: { owner: "o", repo: "r", number: n },
  };
}

function issue(n: number): SessionLink {
  return {
    url: `https://github.com/o/r/issues/${n}`,
    tab: "conversation",
    kind: "issue",
    source: "assistant",
    github: { owner: "o", repo: "r", number: n },
  };
}

function other(
  url: string,
  tab: SessionLink["tab"] = "conversation",
): SessionLink {
  return { url, tab, kind: "other", source: "WebFetch" };
}

describe("linksInTab / tabCounts", () => {
  it("splits the links by tab, keeping their order", () => {
    const links = [
      pr(1),
      other("https://a.example/", "ai_referenced"),
      issue(2),
    ];
    expect(linksInTab(links, "conversation")).toEqual([pr(1), issue(2)]);
    expect(linksInTab(links, "ai_referenced")).toEqual([
      other("https://a.example/", "ai_referenced"),
    ]);
    expect(tabCounts(links)).toEqual({ conversation: 2, ai_referenced: 1 });
  });
});

describe("distinctLinkCount", () => {
  it("counts a URL found in both tabs once", () => {
    expect(distinctLinkCount([pr(1), pr(1, "ai_referenced"), issue(2)])).toBe(
      2,
    );
    expect(distinctLinkCount([])).toBe(0);
  });
});

describe("filterChips", () => {
  it("offers All plus only the kinds that have links, in PR / Issue / Other order", () => {
    expect(filterChips([other("https://a.example/"), pr(1), pr(2)])).toEqual([
      { filter: "all", count: 3 },
      { filter: "pr", count: 2 },
      { filter: "other", count: 1 },
    ]);
  });

  it("offers only All when there are no links", () => {
    expect(filterChips([])).toEqual([{ filter: "all", count: 0 }]);
  });
});

describe("selectableFilter", () => {
  it("falls back to All when the chosen kind has no links any more", () => {
    const chips = filterChips([pr(1)]);
    expect(selectableFilter(chips, "pr")).toBe("pr");
    expect(selectableFilter(chips, "issue")).toBe("all");
  });
});

describe("groupLinks", () => {
  const links = [other("https://a.example/"), issue(3), pr(1), pr(2)];

  it("groups All into PR, Issue, Other, keeping each group's order", () => {
    expect(groupLinks(links, "all")).toEqual([
      { kind: "pr", links: [pr(1), pr(2)] },
      { kind: "issue", links: [issue(3)] },
      { kind: "other", links: [other("https://a.example/")] },
    ]);
  });

  it("keeps only the chosen kind", () => {
    expect(groupLinks(links, "issue")).toEqual([
      { kind: "issue", links: [issue(3)] },
    ]);
  });

  it("is empty when there are no links", () => {
    expect(groupLinks([], "all")).toEqual([]);
  });
});

describe("linkText", () => {
  it("names a GitHub link by its repository and number", () => {
    expect(linkText(pr(12))).toEqual({
      title: "o/r #12",
      detail: "github.com/o/r",
    });
  });

  it("names another link by its host and shows the rest of the URL below", () => {
    expect(
      linkText(other("https://docs.example.com/guide/start?x=1#top")),
    ).toEqual({
      title: "docs.example.com",
      detail: "docs.example.com/guide/start?x=1#top",
    });
  });

  it("tells apart links that differ only by query", () => {
    expect(linkText(other("https://example.com/?page=2")).detail).toBe(
      "example.com/?page=2",
    );
  });

  it("shows the bare host for a site root", () => {
    expect(linkText(other("https://example.com/"))).toEqual({
      title: "example.com",
      detail: "example.com",
    });
  });

  it("prefers a title already known from the transcript", () => {
    expect(
      linkText({ ...other("https://www.rust-lang.org/"), title: "Rust Lang" }),
    ).toEqual({ title: "Rust Lang", detail: "www.rust-lang.org" });
  });

  it("falls back to the raw URL when it cannot be parsed", () => {
    expect(linkText(other("https://"))).toEqual({
      title: "https://",
      detail: "https://",
    });
  });
});
