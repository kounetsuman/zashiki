import { remoteImageHost } from "./remote-host.js";

const NAVIGATION_ONLY_ELEMENTS = new Set(["a", "area"]);
const URL_ATTRIBUTES = new Set([
  "src",
  "href",
  "poster",
  "data",
  "background",
  "action",
  "formaction",
  "lowsrc",
  "dynsrc",
]);
const SRCSET_ATTRIBUTES = new Set(["srcset", "imagesrcset"]);

/**
 * The hosts outside the repo that the elements under `root` would fetch from, read from their
 * URL attributes and from the CSS the browser parsed (inline styles, presentation attributes and
 * style sheets, including `@import`). Links that only navigate when clicked do not count.
 */
export function remoteHostsIn(root: Element): string[] {
  const hosts = new Set<string>();
  const add = (url: string) => {
    const host = remoteImageHost(url);
    if (host !== null) hosts.add(host);
  };
  const scratch = root.ownerDocument.createElement("div").style;
  for (const element of [root, ...Array.from(root.querySelectorAll("*"))]) {
    for (const url of urlsInElement(element, scratch)) add(url);
  }
  for (const style of Array.from(root.querySelectorAll("style"))) {
    for (const url of urlsInStyleElement(style)) add(url);
  }
  return [...hosts].sort();
}

function urlsInElement(
  element: Element,
  scratch: CSSStyleDeclaration,
): string[] {
  const urls: string[] = [];
  const navigatesOnly = NAVIGATION_ONLY_ELEMENTS.has(
    element.localName.toLowerCase(),
  );
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.localName.toLowerCase();
    if (name === "style") continue;
    if (URL_ATTRIBUTES.has(name)) {
      if (!(navigatesOnly && name === "href")) urls.push(attribute.value);
    } else if (SRCSET_ATTRIBUTES.has(name)) {
      urls.push(...srcsetUrls(attribute.value));
    } else {
      urls.push(...urlsInPresentationAttribute(name, attribute.value, scratch));
    }
  }
  const { style } = element as Partial<ElementCSSInlineStyle>;
  if (style !== undefined) urls.push(...urlsInDeclarations(style));
  return urls;
}

function srcsetUrls(srcset: string): string[] {
  return srcset
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/)[0] ?? "")
    .filter((url) => url !== "");
}

function urlsInPresentationAttribute(
  name: string,
  value: string,
  scratch: CSSStyleDeclaration,
): string[] {
  scratch.cssText = "";
  scratch.setProperty(name, value);
  return cssUrls(scratch.getPropertyValue(name));
}

function urlsInStyleElement(style: Element): string[] {
  const { sheet } = style as Partial<LinkStyle>;
  if (sheet !== undefined && sheet !== null) return urlsInRules(sheet);
  const parsed = style.ownerDocument.createElement("style");
  parsed.textContent = style.textContent;
  style.ownerDocument.head.appendChild(parsed);
  try {
    return parsed.sheet === null ? [] : urlsInRules(parsed.sheet);
  } finally {
    parsed.remove();
  }
}

interface RuleLike {
  href?: string;
  style?: CSSStyleDeclaration;
  cssRules?: CSSRuleList;
}

function urlsInRules(sheet: { cssRules: CSSRuleList }): string[] {
  const urls: string[] = [];
  for (const rule of Array.from(sheet.cssRules) as RuleLike[]) {
    if (typeof rule.href === "string") urls.push(rule.href);
    if (rule.style !== undefined) urls.push(...urlsInDeclarations(rule.style));
    if (rule.cssRules !== undefined)
      urls.push(...urlsInRules({ cssRules: rule.cssRules }));
  }
  return urls;
}

function urlsInDeclarations(style: CSSStyleDeclaration): string[] {
  const urls: string[] = [];
  for (let i = 0; i < style.length; i++) {
    const property = style.item(i);
    const value = style.getPropertyValue(property);
    // A custom property keeps its text unparsed, so an escaped `url(` in it is only resolved where
    // it is used; such a value counts as a remote reference of its own.
    if (property.startsWith("--") && value.includes("\\")) urls.push(value);
    urls.push(...cssUrls(value));
  }
  return urls;
}

/**
 * The URLs in a CSS value as the browser serializes it: `url(...)` arguments, quoted or not, and
 * the strings of `image-set()`.
 */
export function cssUrls(value: string): string[] {
  const urls: string[] = [];
  const lower = value.toLowerCase();
  let at = lower.indexOf("url(");
  while (at !== -1) {
    const { text, end } = readUrlArgument(value, at + "url(".length);
    urls.push(text);
    at = lower.indexOf("url(", end);
  }
  if (lower.includes("image-set(")) urls.push(...quotedStrings(value));
  return urls;
}

function readUrlArgument(
  value: string,
  start: number,
): { text: string; end: number } {
  let i = start;
  while (i < value.length && /\s/.test(value[i] ?? "")) i++;
  const quote = value[i];
  if (quote === '"' || quote === "'") return readQuoted(value, i);
  const close = value.indexOf(")", i);
  const end = close === -1 ? value.length : close;
  return { text: value.slice(i, end).trim(), end };
}

function readQuoted(
  value: string,
  open: number,
): { text: string; end: number } {
  const quote = value[open];
  let text = "";
  let i = open + 1;
  while (i < value.length && value[i] !== quote) {
    if (value[i] === "\\" && i + 1 < value.length) i++;
    text += value[i];
    i++;
  }
  return { text, end: i + 1 };
}

function quotedStrings(value: string): string[] {
  const strings: string[] = [];
  let i = 0;
  while (i < value.length) {
    if (value[i] === '"' || value[i] === "'") {
      const { text, end } = readQuoted(value, i);
      strings.push(text);
      i = end;
    } else i++;
  }
  return strings;
}
