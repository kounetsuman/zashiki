# Org notes

Each org can carry a free-form Markdown note — a place to jot what the org is (customer vs. internal), where its repos sit, ticket prefixes, and so on.

## Editing a note

Open SETTINGS → Organizations, pick an org, type into the note box, and press **Save note**. A blank note removes it.

- Notes are stored one file per org at `~/.zashiki/notes/<org>.md` (beside `repos.conf`).
- The org key is its identity (the final directory name), the same key used for colors and aliases.

## When changes take effect

- **Saving reflects immediately** across all open windows — the server broadcasts the updated notes as soon as you save.
- You can also edit `~/.zashiki/notes/<org>.md` directly in your editor; zashiki watches the directory and picks up external edits live.
