# SESSION

The main area shows the terminal (Claude's output) and conversation header for the selected session. Choose which session to show from the **SESSION LIST** (this view has no open/close button of its own).

## Working in the terminal

- Dragging to select text without a modifier key copies it automatically. Right-click selects a word and copies it.
- `Alt+drag` is passed through to the application's mouse operations (e.g. selection inside a TUI).
- Scrolling with the wheel moves through the terminal's own scrollback (kept large enough to reach the first prompt).
- `Shift+Enter` sends a newline (a plain Enter is sent to Claude).

## Conversation header

- Click the title to edit it in place. `Enter` confirms, `Escape` cancels, and clicking away confirms it (an Enter that confirms a conversion does not confirm the edit).
- A manually set title takes top priority; failing that, the auto-summary; failing that, the window name is shown.
- The action to close (kill) a session isn't placed here—it's consolidated in the **SESSION LIST**. You can create a new session with `Cmd+N`.
