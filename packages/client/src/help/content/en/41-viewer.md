# VIEWER

View files opened from **EXPLORER** / **SEARCH** (view-only; leave editing to claude code). They open as tabs at the top of the main area.

- Shown with line numbers and syntax highlighting inferred from the file extension (the dark one-dark theme).
- Markdown (`.md` / `.markdown` / `.mdx`) can be toggled between code and preview within a single pane (raw HTML is escaped when rendered).
- Images from outside the repo (such as `https://` URLs) are not fetched when a Markdown preview opens; each one shows as a button with its alt text and host, and clicking it loads that image.
- A Mermaid diagram that would load something from outside the repo (such as an image node with an `https://` URL) is not drawn when the preview opens; it shows as a button naming the hosts, and clicking it draws that diagram.
- CSV / TSV (`.csv` / `.tsv` / `.tab`) open as a table: one colour per column, numbers aligned right, and the first record read as the header row. Clicking a header sorts the rows (ascending, descending, then back to the file's own order), and the toolbar toggles back to the raw text.
- Images, videos, and PDFs (`.pdf`) are shown rendered rather than as text, both when opened from a repo and when dropped from Finder.
- The wrap icon in the header (shown while the code view is open) wraps long lines so they fit the pane; click it again to scroll sideways instead. The choice is kept for every file you open.
- The `⧉` at the left end of the header copies that file's absolute path ("Path copied" flashes briefly).
- External changes, such as those made by claude code, are reflected live automatically via polling at a fixed interval (no manual refresh needed).
- You can't edit or save files. IDE features such as completion, go-to-definition, and the minimap are also out of scope.
