**English** | [日本語](./CONTRIBUTING.ja.md)

# Contribution Guide

Thank you for your interest in contributing to zashiki. Bug reports, feature proposals, and Pull Requests are all welcome.

## Getting Started

- For bugs and requests, please first open an [Issue](../../issues) (or use an existing related Issue if one exists).
- **Do not report security vulnerabilities in public Issues.** Instead, report them privately following the procedure in [SECURITY.md](./SECURITY.md).
- By participating, you agree to follow the [Code of Conduct (CODE_OF_CONDUCT.md)](./CODE_OF_CONDUCT.md).

## Development Environment

Prerequisites: Node.js 22+ / pnpm / Rust (stable).

```sh
pnpm install
pnpm -F @zashiki/desktop dev   # Tauri shell (= tauri dev)
```

## Pre-Commit Gate

Before submitting a Pull Request, always run the following locally.

```sh
# TypeScript side
pnpm build && pnpm lint && pnpm test

# Rust side (when you have changed the relevant code)
cargo test --manifest-path crates/zashiki-core/Cargo.toml --locked
cargo test --manifest-path crates/zashiki-server/Cargo.toml --locked
```

## Pull Request Flow

1. Prepare a corresponding Issue (create one if none exists).
2. Create a branch and work on it.
3. Protect your changes with tests (the test code is the source of truth for the specification).
4. Get the gate to green before submitting the PR. Keep it as a draft while working, and mark it ready once it is reviewable.
5. Reference the target Issue in the PR body (e.g., `Closes #<issue>`).

## Coding Conventions

- Commit messages: `gitmoji #<issue number> one-line summary` (e.g., `✨ #<issue> Add sorting to the session list`).
- For comment, test, and documentation policies, see [CLAUDE.md](./CLAUDE.md).
- The test code (`*.test.ts` / `cargo test`) is the source of truth for the specification. When changing behavior, update the tests first.

## Versioning

Releases are published as `vX.Y.Z` tags (the format is enforced by the release workflow). zashiki is a distributed app rather than a library with API consumers, so while it is pre-1.0 we keep the scheme deliberately simple and treat the version mostly as a release counter:

- **MINOR** (`0.Y.0`) — every regular release bumps MINOR and resets PATCH to `0`. There is no need to classify what the release contains.
- **PATCH** (`0.Y.Z`) — only for a hotfix / re-release of an already-published version (a bug-only or packaging fix that ships the same feature set again).
- **`1.0.0`** — reserved for declaring the UX and behavior stable. MAJOR bumps for breaking changes apply only from `1.0.0` onward.

The bump is a property of the *release*, not of individual Issues, so it is decided at tag time — there is no per-Issue rule to aggregate.

Issue labels (`enhancement` / `bug` / `documentation` / `refactor`) exist only to group entries in the changelog. They are optional and do **not** drive the version number.

## License

Contributed code is considered to be agreed for distribution under this repository's license ([MIT](./LICENSE)).
