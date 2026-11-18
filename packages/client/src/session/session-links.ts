import type {
  SessionLink,
  SessionLinkKind,
  SessionLinkTab,
} from "@zashiki/shared";

export type LinkFilter = "all" | SessionLinkKind;

export const LINK_KIND_ORDER: readonly SessionLinkKind[] = [
  "pr",
  "issue",
  "other",
];

export interface FilterChip {
  filter: LinkFilter;
  count: number;
}

export interface LinkGroup {
  kind: SessionLinkKind;
  links: SessionLink[];
}

export function linksInTab(
  links: readonly SessionLink[],
  tab: SessionLinkTab,
): SessionLink[] {
  return links.filter((link) => link.tab === tab);
}

export function tabCounts(
  links: readonly SessionLink[],
): Record<SessionLinkTab, number> {
  return {
    conversation: linksInTab(links, "conversation").length,
    ai_referenced: linksInTab(links, "ai_referenced").length,
  };
}

export function distinctLinkCount(links: readonly SessionLink[]): number {
  return new Set(links.map((link) => link.url)).size;
}

function countOfKind(
  links: readonly SessionLink[],
  kind: SessionLinkKind,
): number {
  return links.filter((link) => link.kind === kind).length;
}

export function filterChips(links: readonly SessionLink[]): FilterChip[] {
  const kinds = LINK_KIND_ORDER.map((kind) => ({
    filter: kind,
    count: countOfKind(links, kind),
  })).filter((chip) => chip.count > 0);
  return [{ filter: "all", count: links.length }, ...kinds];
}

export function selectableFilter(
  chips: readonly FilterChip[],
  filter: LinkFilter,
): LinkFilter {
  return chips.some((chip) => chip.filter === filter) ? filter : "all";
}

export function groupLinks(
  links: readonly SessionLink[],
  filter: LinkFilter,
): LinkGroup[] {
  return LINK_KIND_ORDER.filter((kind) => filter === "all" || filter === kind)
    .map((kind) => ({
      kind,
      links: links.filter((link) => link.kind === kind),
    }))
    .filter((group) => group.links.length > 0);
}

function readableRest(url: URL): string {
  const rest = `${url.pathname}${url.search}${url.hash}`;
  const trimmed = rest === "/" ? "" : rest;
  try {
    return decodeURI(trimmed);
  } catch {
    return trimmed;
  }
}

/** The row's title and second line, from what the link itself carries. */
export function linkText(link: SessionLink): { title: string; detail: string } {
  if (link.github !== undefined) {
    const { owner, repo, number } = link.github;
    return {
      title: `${owner}/${repo} #${number}`,
      detail: `github.com/${owner}/${repo}`,
    };
  }
  let url: URL;
  try {
    url = new URL(link.url);
  } catch {
    return { title: link.title ?? link.url, detail: link.url };
  }
  return {
    title: link.title ?? url.host,
    detail: `${url.host}${readableRest(url)}`,
  };
}
