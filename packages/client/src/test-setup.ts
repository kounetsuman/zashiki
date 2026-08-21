// Synchronously initialize i18n before each vitest test file and pin the display
// language to ja. Since jsdom/node's navigator defaults to en, without pinning the
// existing Japanese assertions would turn into en. Pinning to ja makes
// useTranslation()/t() return ja values even without a Provider, so the existing
// tests pass as-is (language detection itself is covered by detect.test.ts).
import i18n from "./i18n/index.js";

void i18n.changeLanguage("ja");

// jsdom lacks scrollIntoView (the tab bar calls it); the Element guard skips the node environment.
if (
  typeof Element !== "undefined" &&
  typeof Element.prototype.scrollIntoView !== "function"
) {
  Element.prototype.scrollIntoView = () => {};
}
