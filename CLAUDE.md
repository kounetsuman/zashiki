# zashiki Development Conventions

## Comment Conventions

The principle is "let naming and structure speak first." When you feel a comment is needed, first consider "extracting into a function whose name expresses the intent" or "expressing it in a test."

- **Inline comments**: As a rule, don't write them. Leave only short notes for context that can't be read from the code, such as non-obvious workarounds grounded in actual measurements.
- **JSDoc**: Only when there is internal behavior that naming alone can't explain, and keep it concise.
- **Tags** (`@param` / `@returns` / `@see`, etc.): Only the minimum when needed (extra lines from tags are acceptable; types are spoken by TS, so don't mechanically annotate every argument).

## Testing

- Push logic into pure functions in shared/domain and guard it with Vitest unit tests (don't cram decision logic into e2e).
- Pre-commit gate: `pnpm build && pnpm lint && pnpm test`.
- Keep e2e (Playwright) thin—connectivity plus critical paths only.

## Documentation (Where Design, Specs, and Context Live)

There is no dedicated design-documentation directory (`docs/`). Consolidate into these three:

- **The spec is the test code** (`*.test.ts` / `cargo test`)—this is canonical. To change behavior, update the tests first. References like "the canonical source is xxx.test.ts" point from each README / comment to the tests.
- **Context lives in commits / Pull Requests**. Revision logs, PDCA, and "why it ended up this way" belong here (don't write context notes like "reflects ~" in the code or README).
- **Design is expressed through descriptive, declarative implementation and appropriate abstraction**. If a comment is still needed, use an inline comment (following the comment conventions); if it's needed across directories, use each directory's `README.md`.
  - Don't reference retired design documents from comments (don't add new section-number pointers). Put cross-cutting "why" in the relevant directory's README, and point to the tests rather than restating the spec detail.

## Bilingual Markdown

When you create a new Markdown document (README, guide, etc.), author it in both supported languages: English as the default `X.md` and Japanese as `X.ja.md`, cross-linked in the header — mirroring the root `README.md` / `README.ja.md` convention (`**English** | [日本語](./README.ja.md)` and `[English](./README.md) | **日本語**`).
