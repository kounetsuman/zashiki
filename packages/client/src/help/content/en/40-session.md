# SESSION

The main area shows the terminal (Claude's output) and conversation header for the selected session. Choose which session to show from the **SESSION LIST** (this view has no open/close button of its own).

## Working in the terminal

- Dragging to select text without a modifier key copies it automatically. Right-click selects a word and copies it.
- `Alt+drag` is passed to tmux's mouse operations (pane selection, copy-mode, etc.).
- Scrolling with the wheel enters tmux's copy-mode (tmux owns the scrollback; see also "SESSION LIST").
- `Shift+Enter` sends a newline (a plain Enter is sent to Claude).

## Conversation header

- Click the title to edit it in place. `Enter` confirms, `Escape` cancels, and clicking away confirms it (an Enter that confirms a conversion does not confirm the edit).
- A manually set title takes top priority; failing that, the auto-summary; failing that, the window name is shown.
- The action to close (kill) a session isn't placed here—it's consolidated in the **SESSION LIST**. You can create a new session with `Cmd+N`.
