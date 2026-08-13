import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import { browserLanguages, detectLocale, SUPPORTED_LOCALES } from "./detect.js";
import en from "./locales/en.json";
import ja from "./locales/ja.json";

/** Where to fall back when the display locale is undetected/unsupported (anything but ja goes to en). */
export const FALLBACK_LOCALE = "en";

const search = typeof window === "undefined" ? "" : window.location.search;

/**
 * The i18n instance for UI text. Resources are bundled and initialized synchronously
 * (no async backend), so `t()` / `useTranslation()` return definite values right after import.
 * The display language is detected from the browser language (overridable via `?lang=`), and
 * unsupported/undetectable falls to en. Adding a language is as easy as adding a locales/*.json
 * and registering it in resources and SUPPORTED_LOCALES.
 */
void i18n.use(initReactI18next).init({
  resources: {
    ja: { translation: ja },
    en: { translation: en },
  },
  lng: detectLocale(browserLanguages(), search),
  fallbackLng: FALLBACK_LOCALE,
  supportedLngs: SUPPORTED_LOCALES,
  interpolation: { escapeValue: false },
  returnNull: false,
  // Resources are bundled and always ready, so Suspense is unnecessary (explicitly disabled
  // so test renders need not be wrapped in a Suspense boundary).
  react: { useSuspense: false },
});

export default i18n;
