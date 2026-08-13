/**
 * Pure function that formats a session name for display (placeholder scaffold implementation).
 * Trims leading and trailing whitespace, and truncates with a trailing "…" when it exceeds maxLength.
 */
export function formatSessionName(raw: string, maxLength = 32): string {
  const trimmed = raw.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength - 1)}…`;
}
