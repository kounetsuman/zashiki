// Pure logic for org attribution.
// Reading, parsing, and absolutizing repos.conf is consolidated into server/infra/repos.ts (readConfRoots).
// This module only does string comparison over a list of absolute root paths passed as arguments.

import { stripTrailingSlashes } from "./path-slash.js";

/** The last element of a path (shared also runs in the browser, so node:path is not used). */
function basename(path: string): string {
  const trimmed = stripTrailingSlashes(path);
  const last = trimmed.split("/").pop();
  return last !== undefined && last.length > 0 ? last : trimmed;
}

/**
 * Which org the cwd belongs to (the org name = the last element of the root).
 * If it is not under any root, the last element of the cwd itself (a catch-all for detection outside the conf).
 */
export function orgOfCwd(cwd: string, roots: readonly string[]): string {
  for (const root of roots) {
    if (cwd === root || cwd.startsWith(`${root}/`)) return basename(root);
  }
  return basename(cwd);
}

/** org name → root absolute path (null if no match). */
export function orgRoot(org: string, roots: readonly string[]): string | null {
  for (const root of roots) {
    if (basename(root) === org) return root;
  }
  return null;
}

/**
 * Default palette for automatic org coloring (up to 10 colors). Bright hues that are
 * easy to distinguish on a dark theme, placed roughly evenly around the color wheel.
 * Used as the default color when the org color is not explicitly set in repos.conf.
 */
export const DEFAULT_ORG_PALETTE = [
  "#7aa2f7", // blue
  "#9ece6a", // green
  "#e0af68", // amber
  "#bb9af7", // purple
  "#f7768e", // red
  "#7dcfff", // sky
  "#ff9e64", // orange
  "#94e2d5", // teal
  "#f5c2e7", // pink
  "#b4befe", // periwinkle
] as const;

/**
 * Stably hashes the org name and assigns it one color from the palette (conf-independent automatic coloring).
 * A pure function that gives a default color to orgs not specified in repos.conf. Deterministic via FNV-1a.
 */
export function orgColor(
  org: string,
  palette: readonly string[] = DEFAULT_ORG_PALETTE,
): string {
  let h = 2166136261;
  for (let i = 0; i < org.length; i++) {
    h ^= org.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return palette[(h >>> 0) % palette.length] ?? "#ffffff";
}

/**
 * Determines an org's display color: the explicit color from repos.conf (`explicit`)
 * if present, otherwise the automatic coloring from {@link orgColor}. Used commonly
 * across the UI (tabs, the list, explorer/git/search).
 */
export function resolveOrgColor(
  org: string,
  explicit: Readonly<Record<string, string>>,
  palette: readonly string[] = DEFAULT_ORG_PALETTE,
): string {
  // An empty string (e.g. an invalid payload) also falls back to automatic coloring rather than being left colorless (`||`, not `??`).
  return explicit[org] || orgColor(org, palette);
}

/**
 * Determines an org's display name: the explicit alias from repos.conf (`aliases`) if present,
 * otherwise the org identity itself (the root basename). Mirrors {@link resolveOrgColor} — the
 * grouping key stays the org identity, only the rendered label changes. An empty alias (e.g. an
 * invalid payload) falls back to the identity rather than rendering blank (`||`, not `??`).
 */
export function resolveOrgName(
  org: string,
  aliases: Readonly<Record<string, string>>,
): string {
  return aliases[org] || org;
}

/** Display-name list of all orgs in the conf (order-preserving dedup). Also the anchor for always showing orgs with zero cockpit terminals. */
export function orgNames(roots: readonly string[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const root of roots) {
    const name = basename(root);
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}
