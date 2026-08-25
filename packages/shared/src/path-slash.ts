// Linear-time "/" trimming. Regex forms such as /\/+$/ backtrack super-linearly
// on long slash runs (CodeQL js/polynomial-redos); a single char scan is O(n).
// shared also runs in the browser, so node:path is not used.

const SLASH = "/";

/** Removes the trailing run of "/" (inner separators are kept). */
export function stripTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === SLASH) end--;
  return path.slice(0, end);
}

/** Removes the leading and trailing runs of "/" (inner separators are kept). */
export function stripSurroundingSlashes(path: string): string {
  let start = 0;
  let end = path.length;
  while (start < end && path[start] === SLASH) start++;
  while (end > start && path[end - 1] === SLASH) end--;
  return path.slice(start, end);
}
