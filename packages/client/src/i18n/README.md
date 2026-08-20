# i18n (UI copy multi-language foundation)

UI copy is held in static resources (`locales/*.json`). We do not translate at runtime on the fly
(for latency, determinism, testability, and cost). Currently `ja` / `en` are provided.

## Deciding the Display Language

`detectLocale` in `detect.ts` decides. Precedence: **URL `?lang=ja|en` (explicit override) →
browser language (`navigator.languages`; ja if `ja*`) → `en`**. Anything other than ja, undetectable
cases, and untranslated keys all fall back to `en` (`fallbackLng: en`). There is no language-switch UI
(auto-detect + `?lang` only).

## Usage

- React components: `const { t } = useTranslation();` → `t("sessionList.newSession")`.
  For copy containing inline elements, use `<Trans i18nKey="..." components={{ code: <code /> }} />`.
- Non-React modules (store / pure functions): `import i18n from "../i18n"` → `i18n.t(...)`.
  Do not call `t()` in module top-level constants (avoid evaluation before init). Constants hold a
  **key** such as `labelKey`, which the render side resolves via `t(key)` (e.g. `labelKey` in `ui/views.ts`).

## Key Design Guidelines

- A single namespace (default `translation`) plus nested keys grouped by feature, `.`-separated.
  Groups roughly correspond to "screen / feature" (`sessionList` / `tabBar` / `notification` / `search` /
  `git` / `viewer` / `explorer` / `help` / `footer` / `view` / `debug`, etc.).
  Generic terms shared across multiple places go in `common` (`close` / `cancel` / `retry` …).
- Leaf keys are lowerCamelCase. Dynamic values use `{{name}}` interpolation (do not split sentences).
- To add a language, add `locales/<lng>.json` and register it in `resources` in `index.ts` and
  `SUPPORTED_LOCALES` in `detect.ts`. Untranslated keys fall back to en via `fallbackLng: en`.

## Out of Scope

- `help/content/*.md` (long-form help body text) remains ja content separate from the short UI copy. Handled separately.
- A language-selection UI on a settings screen (auto-detect + `?lang` is sufficient).

## Gap Detection

- `no-hardcoded-jp.test.ts`: machine-checks, via the TypeScript AST, whether any Japanese is written
  directly in strings/templates/JSX text under `src` (excluding tests and locales).
- `locales-parity.test.ts`: checks that the key sets and interpolation variables `{{...}}` match between
  `ja` / `en` (detects missing translations, key typos, and surplus keys).
- Both are included in `pnpm test` and fail in CI.
