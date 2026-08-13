[English](./README.md) | **日本語**

# @zashiki/server-darwin-x64

`zashiki-server` バイナリ（macOS x64 / Intel）。公開パッケージ [`zashiki`](https://www.npmjs.com/package/zashiki)
の `optionalDependencies` として配布され、実行環境が macOS x64 の時だけ `npm` が取得する。

単体で使うものではない。`zashiki` CLI が
`require.resolve('@zashiki/server-darwin-x64/bin/zashiki-server')` で解決して起動する。

バイナリは `crates/zashiki-server` を `cargo build --release --target x86_64-apple-darwin` して
リポジトリの `scripts/build-npm-server-binary.mjs darwin-x64` で `bin/` へ配置する（クロスビルド。
ローカル arm64 での充填と pack 検証は行わず、タグビルドの release CI で実施する）。
