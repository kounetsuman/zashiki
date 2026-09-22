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

// jsdom lacks Range's rect APIs (CodeMirror measures the caret with them, and logs the failure on
// every measure); the Range guard skips the node environment. Layout is absent either way, so zero
// rects are as truthful as it gets.
if (typeof Range !== "undefined") {
  if (typeof Range.prototype.getClientRects !== "function") {
    Range.prototype.getClientRects = () =>
      Object.assign([], { item: () => null }) as unknown as DOMRectList;
  }
  if (typeof Range.prototype.getBoundingClientRect !== "function") {
    Range.prototype.getBoundingClientRect = () => new DOMRect();
  }
}
