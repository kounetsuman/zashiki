import type { Locale } from "../i18n/detect.js";
import {
  type HelpCategoryDef,
  type HelpTopic,
  parseHelpTopic,
  sortTopics,
} from "./help-model.js";

/**
 * Imports `content/<locale>/*.md` at bundle time (1 file = 1 help item).
 * To add an item, add one markdown file with the same name to each locale
 * directory under content/. The numeric-prefixed filename (not the language)
 * decides the topic id and order, so a topic keeps the same id across locales.
 */
const TOPICS_BY_LOCALE: Record<Locale, HelpTopic[]> = {
  ja: topicsFrom(
    import.meta.glob("./content/ja/*.md", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>,
  ),
  en: topicsFrom(
    import.meta.glob("./content/en/*.md", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>,
  ),
};

function topicsFrom(modules: Record<string, string>): HelpTopic[] {
  return sortTopics(
    Object.entries(modules).map(([path, raw]) => parseHelpTopic(path, raw)),
  );
}

/** Help topics for the given locale; English is the fallback for any non-Japanese locale. */
export function getHelpTopics(locale: string): HelpTopic[] {
  return locale.toLowerCase().startsWith("ja")
    ? TOPICS_BY_LOCALE.ja
    : TOPICS_BY_LOCALE.en;
}

/**
 * The source of truth for help categories (display order, display name, member topic ids).
 * `topicIds` are the content/*.md filename slugs (the part without the numeric prefix and extension).
 * Topics not listed here fall into the trailing "Other" on the HelpView side (so nothing is dropped).
 */
export const HELP_CATEGORIES: HelpCategoryDef[] = [
  { id: "config", titleKey: "help.category.config", topicIds: ["repos-conf"] },
  {
    id: "general",
    titleKey: "help.category.general",
    topicIds: ["keybindings", "navigation"],
  },
  {
    id: "subview",
    titleKey: "help.category.subview",
    topicIds: [
      "session-list",
      "notifications",
      "explorer",
      "search",
      "source-control",
    ],
  },
  {
    id: "mainview",
    titleKey: "help.category.mainview",
    topicIds: ["session", "viewer"],
  },
];
