[English](./README.md) | **日本語**

# @zashiki/client

Vite + React + xterm.js のブラウザクライアント。状態は `state.sync` を受ける薄い store（zustand）。UI の各パネル・状態遷移の仕様は各コンポーネント隣の `*.test.tsx` / `*.test.ts` が正本。

## 起動（開発）

```sh
# 1. Rust server を起動（起動ログに token file の場所が出る。~/.zashiki/token に token）
cargo run --manifest-path crates/zashiki-server/Cargo.toml

# 2. client dev サーバを起動（server とは別ポート）
VITE_ZK_SERVER=http://127.0.0.1:8790 pnpm -F @zashiki/client dev

# 3. ブラウザで開く（token は ~/.zashiki/token の値）
open "http://127.0.0.1:5173/?token=<token>"
```

トークンは初回アクセス時に sessionStorage へ保存され、URL からは即座に除去される
（cookie は使わない）。タブを閉じるとトークンは消えるので、
再入場は `?token=` 付き URL から。

## 手動チェックリスト（自動テスト対象外）

IME 合成・スクロール/コピーの体感は Playwright で再現できないため、
リリース前に人間が以下を確認する。

### IME 日本語入力

- [ ] ターミナルで日本語を入力できる（変換前のプリエディット文字列が xterm.js 上に表示される）
- [ ] スペースで変換、Enter で確定した文字列だけが pty に送られる（プリエディットが二重送信されない）
- [ ] 変換候補ウィンドウがカーソル位置近くに出る（画面外・原点に飛ばない）
- [ ] 確定後に続けて ASCII を打っても取りこぼしがない
- [ ] Claude Code のプロンプトで日本語を入力 → 送信 → 表示が崩れない

### スクロール

- [ ] ホイールで tmux copy-mode に入り履歴を遡れる（xterm.js 側の scrollback ではなく tmux 委譲）
- [ ] copy-mode 中に `q` / 最下部までスクロールで通常表示へ戻る
- [ ] copy-mode 中もキー入力（q 等）がターミナルへ届く
- [ ] 大量出力（`yes` 等）中でも UI が固まらない（フロー制御。止めた後に追いつく）

### コピー

- [ ] Shift+ドラッグで xterm.js のテキスト選択ができる（tmux の mouse mode と衝突しない）
- [ ] 選択するとクリップボードへ自動コピーされる（別アプリに貼り付けて確認）
- [ ] 日本語・罫線を含む行のコピーで文字化けしない
- [ ] 右クリックでブラウザ標準のコンテキストメニューが出る

### 再接続

- [ ] server を再起動するとステータスバーが reconnecting になり、復帰後にターミナルが再表示される
- [ ] ウィンドウ切替バーで選んだ窓が、再接続後も表示され続ける
