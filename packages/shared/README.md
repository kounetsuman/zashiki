**English** | [日本語](./README.ja.md)

# @zashiki/shared

The innermost core of the onion architecture. It holds only **side-effect-free pure functions** (domain) and **protocol types shared by both the client and server ends** (zod). It knows nothing of the PTY, fs, or the network.

The dependency direction is `shared (domain) ← server/usecase ← server/infra` / `client (presentation)`. This package depends on nothing, and is the main battleground for unit tests (Vitest).

## The source of truth for the spec is the tests

For each module, **the source of truth for its behavior is the `*.test.ts` next to it**. Design decisions are expressed in code (naming, types, structure) and, where needed, inline comments. The following is a map of "which test to read to understand the spec".

| Module | Role | Spec source of truth |
|---|---|---|
| `session-state.ts` | A pure function that determines the state (`waiting_input`/`running`/`running_bg_agent`/`idle`/`no_claude`) from capture text and the like. Priority order, wizard detection, spinner/bg-agent detection | `session-state.test.ts` (table tests using normal-width + 80-column-wrapped capture fixtures) |
| `protocol.ts` | zod schemas for control messages (`ClientMessage`/`ServerMessage`) and `SessionInfo` | `protocol.test.ts` |
| `repos.ts` | `repos.conf`-compatible parser + org colors (`orgColor`/`resolveOrgColor`/`DEFAULT_ORG_PALETTE`) | `repos.test.ts` |
| `git.ts` | `git status --porcelain` parser | `git.test.ts` |
| `process-tree.ts` | Builds a process tree from ps output and looks up a pane by `--session-id` | `process-tree.test.ts` |
| `save-file.ts` | TSV (`widx\twname\tcwd\tsid`) serialization/parsing for save/restore | `save-file.test.ts` |
| `fs-tree.ts` | Explorer display formatting (`sortFsEntries`/`joinRepoRelative`/`fileIconKind`) | `fs-tree.test.ts` |
| `search.ts` | ripgrep argument assembly / `rg --json` output parsing | `search.test.ts` |
| `session-state.ts`/`flow.ts` | Pure logic for state transitions and flow control | the respective `*.test.ts` |
| `config.ts` | Schema for immediately-applied / restart-required settings, with default completion (parsing never throws; it falls back to defaults) | `config.test.ts` |
| `notifications.ts` | In-app notification data (`{id,level,title,body,createdAt,sticky,dismissible}`) and upsert | `notifications.test.ts` |
| `terminal-size.ts` | Practical lower-bound clamp for terminal size (`isUsableTerminalSize` etc.) | `terminal-size.test.ts` |
| `jsonl.ts` | Tail event/title extraction from `~/.claude/projects/**/*.jsonl` | `jsonl.test.ts` |

## Protocol (wire) contract — the invariant for swapping the server implementation

The types in `protocol.ts` are **the contract for keeping the client unmodified even when the server implementation (Node / Rust) is swapped**. The crate `zashiki-server` returns JSON byte-equivalent to this wire (guaranteed by the Rust-side wire types). The points to keep invariant:

- The message shapes of `/ws/control` (control JSON). The bytes of `term.ack` are in **UTF-16 code units** (match the JS string length written by xterm.js = the client-side watermark).
- `/ws/term/<termId>` (raw PTY binary, no framing).
- REST (`/api/git/*`, `/api/fs/*`, `/api/search`, `/api/file`) and `/healthz`.
- Token validation (`x-zashiki-token` / `?token=`) and Host/Origin validation.
- The `SessionInfo` shape of `state.sync`.

The PTY management strategy is an implementation detail outside the wire, invisible to the client.
