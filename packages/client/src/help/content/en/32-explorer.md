# EXPLORER

Shows all repositories registered in `repos.conf` as a collapsible tree of org → repository → folders / files. Open it with the 🗂 icon in the footer or `Ctrl+Alt+E`.

- Clicking a folder expands it **one level, in place** (lazy expansion that loads only the immediate children when opened).
- Clicking a file lets you view that file in the **VIEWER** (a tab in the main area).
- Each level lists directories first, then files, in name order. The `.git` directory is excluded from the list.
- The dot to the left of a repository name is the org color (a marker of org membership; see "repos.conf and org colors").
- Use the `↻` in the header to reload the list. Folders that couldn't be read (insufficient permissions, missing, etc.) show an error below their row.
