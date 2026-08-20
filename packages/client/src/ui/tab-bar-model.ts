import type { SessionInfo } from "@zashiki/shared";
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
};

/**
 * The tab's display label and title (tooltip). For session tabs, uses resolveTitle;
 * for viewer tabs, shows the file name (basename) and attaches the repo-relative path as the title.
 */
export function tabLabel(
  tab: Tab,
  sessions: SessionInfo[],
  titles: TitleMap,
): { label: string; title: string } {
  if (tab.kind === "session") {
    const s = sessions.find((x) => x.windowId === tab.id);
    const label =
      s === undefined
        ? tab.id
        : resolveTitle(effectiveCustomTitle(titles, s), s);
    return { label, title: label };
  }
  // A viewer id is the viewerKey (repoPath and relPath joined by a newline). Display shows the file name.
  const rel = tab.id.split("\n")[1] ?? tab.id;
  return { label: rel.split("/").pop() ?? rel, title: rel };
}
