import type { CockpitTerminalInfo } from "@zashiki/shared";
import {
  effectiveCustomTitle,
  resolveTitle,
  type TitleMap,
} from "../lib/conversation-title.js";
import type { Tab, TabKind } from "../tabs/tab-model.js";

/** Icon per tab kind (Material Symbols Outlined ligature). */
export const TAB_ICON: Record<TabKind, string> = {
  session: "terminal",
  viewer: "description",
  diff: "difference",
};

function basenameLabel(rel: string): { label: string; title: string } {
  return { label: rel.split("/").pop() ?? rel, title: rel };
}

/**
 * The tab's display label and title (tooltip). For session tabs, uses resolveTitle; for viewer/diff
 * tabs, shows the file name (basename) with the repo-relative path as the title. A viewer id is
 * `repoPath\nrelPath`; a diff id is `side\nrepoPath\nrelPath`, so relPath is everything past the
 * fixed leading segments (it may itself contain a newline).
 */
export function tabLabel(
  tab: Tab,
  cockpitTerminals: CockpitTerminalInfo[],
  titles: TitleMap,
): { label: string; title: string } {
  if (tab.kind === "session") {
    const s = cockpitTerminals.find((x) => x.cockpitTerminalId === tab.id);
    const label =
      s === undefined
        ? tab.id
        : resolveTitle(effectiveCustomTitle(titles, s), s);
    return { label, title: label };
  }
  if (tab.kind === "diff") {
    return basenameLabel(tab.id.split("\n").slice(2).join("\n") || tab.id);
  }
  return basenameLabel(tab.id.split("\n").slice(1).join("\n") || tab.id);
}
