export type Locale = "ja" | "en";

export const SUPPORTED_LOCALES: readonly Locale[] = ["ja", "en"];

/** Type guard that decides whether a given value is a supported locale. */
function isLocale(value: string | null): value is Locale {
  return value === "ja" || value === "en";
}

/**
 * Pure function that decides the display locale.
 * Precedence: URL `?lang=ja|en` (explicit override) -> browser language (`ja*` means ja) -> en.
 * Anything other than ja, or undetectable, falls to en (aligned with fallbackLng=en).
 */
export function detectLocale(
  languages: readonly string[] | undefined,
  search: string,
): Locale {
  const override = new URLSearchParams(search).get("lang");
  if (isLocale(override)) return override;
  const langs = languages ?? [];
  return langs.some((l) => l.toLowerCase().startsWith("ja")) ? "ja" : "en";
}

/** Extracts navigator's language candidates from the browser environment (undefined outside a browser). */
export function browserLanguages(): readonly string[] | undefined {
  if (typeof navigator === "undefined") return undefined;
  if (navigator.languages && navigator.languages.length > 0) {
    return navigator.languages;
  }
  return navigator.language ? [navigator.language] : undefined;
}
