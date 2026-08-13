[English](./README.md) | **日本語**

# @zashiki/server-darwin-arm64

`zashiki-server` バイナリ（macOS arm64）。公開パッケージ [`zashiki`](https://www.npmjs.com/package/zashiki)
の `optionalDependencies` として配布され、実行環境が macOS arm64 の時だけ `npm` が取得する。

単体で使うものではない。`zashiki` CLI が
`require.resolve('@zashiki/server-darwin-arm64/bin/zashiki-server')` で解決して起動する。

バイナリは `crates/zashiki-server` を `cargo build --release` してリポジトリの
`scripts/build-npm-server-binary.mjs` で `bin/` へ配置する（コミットせず build/release で生成）。
