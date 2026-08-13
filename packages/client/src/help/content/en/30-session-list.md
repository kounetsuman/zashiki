# SESSION LIST

Sessions are shown collapsed by org (groups derived from `repos.conf`). Click the `▼` / `▶` in a heading to expand or collapse it; `(count)` is the number of sessions in that org. You can set the color of an org heading in `repos.conf` (see "repos.conf and org colors").

Double-click a row, or move focus with `↑` / `↓` and press `Enter`, to switch to that terminal (a single click only places the focus outline, to avoid accidentally triggering a heavy session). The active window is shown with a faint highlight across the whole row, and the selected one with a slightly stronger highlight.

## Status icons

The leading icon on each row is its current state.

- `!` Waiting for a response (waiting for your input)
- `•` Running
- `•+🤖` Sub-agent running (a robot badge overlaid on the running icon)
- `✔︎` Idle (finished / waiting)
- `▮` Claude isn't running (a plain terminal such as zsh)
- `·` Unknown (state held off in copy-mode, etc.)

Each row shows the status icon and a summary title of the conversation. The org name isn't repeated on the row, since it's clear from the collapsible heading.
