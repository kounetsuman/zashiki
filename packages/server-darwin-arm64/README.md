**English** | [日本語](./README.ja.md)

# @zashiki/server-darwin-arm64

The `zashiki-server` binary (macOS arm64). It is distributed as an `optionalDependencies`
of the published package [`zashiki`](https://www.npmjs.com/package/zashiki), and `npm` fetches
it only when the runtime environment is macOS arm64.

It is not meant to be used on its own. The `zashiki` CLI resolves and launches it via
`require.resolve('@zashiki/server-darwin-arm64/bin/zashiki-server')`.

The binary is produced by running `cargo build --release` on `crates/zashiki-server` and placed
into `bin/` by the repository's `scripts/build-npm-server-binary.mjs` (generated during build/release, not committed).
