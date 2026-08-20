**English** | [日本語](./README.ja.md)

# @zashiki/client

A Vite + React + xterm.js browser client. State is a thin store (zustand) that receives `state.sync`. The spec for each UI View and state transition lives in the `*.test.tsx` / `*.test.ts` next to each component as the source of truth.

## Domain model (ubiquitous language)

Canonical UI terms. Some code still uses legacy names (`windowId`, `SessionState`, `PanelId`); those renames are tracked as follow-ups. Naming rules (casing, the wire boundary) live in the root [`CLAUDE.md`](../../CLAUDE.md).

- **Area** — a layout region that holds Views.
- **View** — the concept drawn into an Area; its contents vary per View. (There is no "Panel"; sub-area surfaces are `… View`.)

```
Main Area
└ Cockpit View — shows a Cockpit Terminal | a Viewer (one per Cockpit Tab)
     └ Cockpit Terminal — the durable unit; a Claude Session (sid) runs inside it
          ├ CockpitTerminalState — waiting_input / running / running_bg_agent / idle / no_claude / starting / unknown
          ├ Background Activity — runningSubagents / shellsRunning / limited (orthogonal flags)
          └ term / termId — the xterm.js render slot (attaches to a Cockpit Terminal)

Sub Area
├ Cockpit Terminal List View — grouped by Organization; a row is a Cockpit Terminal (select → shown in the Cockpit View)
├ Explorer View / Search View / Source Control View
└ Notification View (unread/read) / Help View / Settings View

Navigation Area — switches Sub Area Views
Cockpit Footer — per-terminal status
Overlays — Notification Toast, Modal
```

- **Cockpit Terminal** (was window/session) — not called "session": Ctrl+C ends the Claude run, but the terminal itself survives.
- **Claude Session** (`sid`) — the transient Claude Code run inside a Cockpit Terminal.
- **Viewer** — read-only file viewer; zashiki is a vibe-coding-only cockpit, so there is no plan to grow it into an editor.
- **Organization** (`org`) — a Cockpit Terminal belongs to one; the list is grouped by it.

## Running (development)

```sh
# 1. Start the Rust server (the startup log prints the token file location. The token is at ~/.zashiki/token)
cargo run --manifest-path crates/zashiki-server/Cargo.toml

# 2. Start the client dev server (a different port from the server)
VITE_ZK_SERVER=http://127.0.0.1:8790 pnpm -F @zashiki/client dev

# 3. Open it in a browser (the token is the value in ~/.zashiki/token)
open "http://127.0.0.1:5173/?token=<token>"
```

On first access the token is saved to sessionStorage and immediately stripped from the URL
(cookies are not used). Closing the tab clears the token, so
re-entry is via a URL with `?token=`.

## Manual checklist (not covered by automated tests)

Because the feel of IME composition, scrolling, and copying cannot be reproduced with Playwright,
a human verifies the following before release.

### IME Japanese input

- [ ] Japanese can be typed in the terminal (the pre-edit string before conversion is displayed on xterm.js)
- [ ] Only the string converted with Space and committed with Enter is sent to the pty (the pre-edit is not sent twice)
- [ ] The conversion candidate window appears near the cursor position (does not jump off-screen or to the origin)
- [ ] No characters are dropped when typing ASCII right after committing
- [ ] Typing Japanese at the Claude Code prompt → sending → the display does not break

### Scrolling

- [ ] The wheel enters tmux copy-mode and history can be scrolled back (delegated to tmux, not xterm.js's scrollback)
- [ ] `q` during copy-mode / scrolling to the bottom returns to normal display
- [ ] Key input (such as `q`) reaches the terminal even during copy-mode
- [ ] The UI does not freeze even during heavy output (such as `yes`) (flow control; it catches up after being stopped)

### Copy

- [ ] Shift+drag allows text selection in xterm.js (does not conflict with tmux's mouse mode)
- [ ] Selecting automatically copies to the clipboard (verify by pasting into another app)
- [ ] Copying lines containing Japanese or box-drawing characters is not garbled
- [ ] Right-click brings up the browser's standard context menu

### Reconnection

- [ ] Restarting the server turns the status bar to reconnecting, and the terminal is re-displayed after recovery
- [ ] The window selected in the window switcher bar keeps being displayed even after reconnection
