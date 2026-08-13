# repos.conf と org の色

zashiki が一覧に出す対象リポジトリは `~/.zashiki/repos.conf` で決めます。1 行 1 パス、`#` 以降と空行は無視されます。各パスの末尾ディレクトリ名が org（グループ）になります。

```
/Users/you/workspace/whiskey
/Users/you/workspace/charlie
```

## org に色を付ける

各パス行の行末に色トークン（`#RGB` または `#RRGGBB`）を書くと、その org の見出しがその色になります。色を書かない org は既定色（白）です。

```
/Users/you/workspace/whiskey   #7aa2f7
/Users/you/workspace/charlie   #98c379
/Users/you/workspace/delta
```

- 色トークンはパスと空白で区切って行末に置きます。
- 色でない `#`（例 `# メモ`）は従来どおりコメントです。
- 同じ末尾名の org が複数あると、先に書いた色が使われます。

## 反映のタイミング

- **保存した変更はすべて即時反映**されます（再起動不要）。色の変更も、org（行）の増減・並び替えも同様です。zashiki が `repos.conf` を監視してライブ反映します。
- アプリからも org を追加できます。SESSION LIST ヘッダの **＋** ボタン（または SETTINGS → 組織）でディレクトリを `repos.conf` に追記でき、すぐに一覧へ表示されます。
