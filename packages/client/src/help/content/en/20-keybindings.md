# Keybindings

## Session actions

- `Cmd+N`: Create a new session in the org of the highlighted session (works even while the terminal is focused).
- `Ctrl-N`: While the session list view is focused, create a new session in the selected session's org (or the first org if none is selected).
- `Ctrl-X`: Close the selected session (with an inline confirmation).

You can also use right-click. Right-click an org heading → New session; right-click a row → Delete.

## Opening files

- `Cmd+O`: Open the native file picker and show the chosen file read-only in the Viewer.
- `Cmd+P`: Open the quick-open palette to fuzzy-find a file across all orgs (the active org ranks first) and open it. Append `:` and a line number (e.g. `App.tsx:42`) to jump to that line. Arrow keys move the selection, Enter opens, Escape closes.

## Toggling view visibility (NAVIGATION)

Use `Ctrl+Alt+<key>` to toggle each view's visibility.

- `Ctrl+Alt+E`: Explorer
- `Ctrl+Alt+F`: Search
- `Ctrl+Alt+G`: Source Control
- `Ctrl+Alt+N`: Notifications

`Cmd+B` also toggles the Explorer, and (like the other meta shortcuts) works even while the terminal is focused.

## Help and Settings

Both open as a modal dialog (Escape or the close button dismisses it).

- `Ctrl+Alt+H`: Help
- `Ctrl+Alt+S`: Settings

## Source Control

- `⌘Enter` / `Ctrl+Enter`: Commit the expanded repository (in the message input field; an Enter that confirms an IME conversion is ignored).
