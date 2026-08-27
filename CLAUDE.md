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

## Issues vs. Discussions

An Issue must have a **defined completion condition** — a single, unambiguous "when is this done".

- **Bug** → done when it no longer reproduces.
- **Settled spec** → done when the spec is met (its tests pass).
- **Open-ended idea / proposal / design** whose spec is not yet settled → **Discussions**, not an Issue. Decide there whether and how to turn it into a spec; only once the completion condition is clear do you cut an Issue for it.

Do not open an Issue you cannot state a completion condition for, and do not use a tracking Issue to hold open-ended design (split the settled, completion-bearing parts into their own Issues and keep the rest in a Discussion).

## Bilingual Markdown

When you create a new Markdown document (README, guide, etc.), author it in both supported languages: English as the default `X.md` and Japanese as `X.ja.md`, cross-linked in the header — mirroring the root `README.md` / `README.ja.md` convention (`**English** | [日本語](./README.ja.md)` and `[English](./README.md) | **日本語**`).

## Naming Conventions (Ubiquitous Language)

Use the canonical domain terms below. Some code still carries legacy names (`windowId`, `SessionState`, `PanelId`, …); those are mechanical renames migrated as separate follow-ups. The full UI model tree lives in `packages/client/README.md`.

**Terms**

- **Area** — a layout region. **View** — the concept drawn into an Area; its contents vary per View. *"Panel" is retired* — name new surfaces `… View`.
- **Cockpit Terminal** — the durable main-area unit (was `window` / `session`). Not "session": Ctrl+C ends the run but the terminal survives. `Terminal` alone collides with the xterm layer, so it is qualified.
- **Claude Session** (`sid`) — the transient Claude run *inside* a Cockpit Terminal. "session" is scoped to `sid` only.
- **Viewer** — read-only file viewer (vibe-coding cockpit; no editor planned). **Memo** — the single, opt-in scratchpad editor pinned to the front of the Cockpit Tabs; the *only* editable surface in the cockpit (the deliberate exception to Viewer/Diff being read-only), persisted to `<repos.conf dir>/memo.md`. **Organization** (`org`) — a Cockpit Terminal belongs to one. **Background Activity** — umbrella for `runningSubagents` / `shellsRunning` / `limited`.
- **term / termId** — the xterm.js render slot; kept, and distinct from Cockpit Terminal.

**Casing**

- Internal: `snake_case` (Rust) / `camelCase` (TS); Rust enum variants `PascalCase`; constants `UPPER_SNAKE`; files `kebab-case`.
- Wire (serde `rename_all = "camelCase"` ↔ Zod, guarded by `protocol.test.ts`): fields `camelCase`; message type `t` is `namespace.verb`; enum wire values stay `snake_case`.
- Prefer descriptive names even when verbose (`cockpitTerminalId`, `CockpitTerminalState`) — zero ambiguity beats brevity. Established short forms `org` / `repo` / `pty` / `term` / `sid` are kept.

**Legacy → target** (separate follow-ups): `windowId`→`cockpitTerminalId`, `SessionState`→`CockpitTerminalState`, `SessionInfo`→`CockpitTerminalInfo`, `SessionListPanel`→`CockpitTerminalListView`, `TerminalSessionStatus`→`TermAttachStatus`, `PanelId` / `PANEL_DEFS` / `panel.*`→`ViewId` / `VIEW_DEFS` / `view.*`.
