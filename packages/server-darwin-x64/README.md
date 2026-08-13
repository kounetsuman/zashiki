**English** | [日本語](./README.ja.md)

# @zashiki/server-darwin-x64

The `zashiki-server` binary (macOS x64 / Intel). It is distributed as an `optionalDependencies`
of the published package [`zashiki`](https://www.npmjs.com/package/zashiki), and `npm` fetches
it only when the runtime environment is macOS x64.

It is not meant to be used on its own. The `zashiki` CLI resolves and launches it via
`require.resolve('@zashiki/server-darwin-x64/bin/zashiki-server')`.

The binary is produced by running `cargo build --release --target x86_64-apple-darwin` on
`crates/zashiki-server` and placed into `bin/` by the repository's
`scripts/build-npm-server-binary.mjs darwin-x64` (cross-build; local arm64 filling and pack
verification are skipped and performed in the tag-build release CI instead).
