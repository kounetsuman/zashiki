# VIEWER

View files opened from **EXPLORER** / **SEARCH** (view-only; leave editing to claude code). They open as tabs at the top of the main area.

- Shown with line numbers and syntax highlighting inferred from the file extension (the dark one-dark theme).
- Markdown (`.md` / `.markdown` / `.mdx`) can be toggled between code and preview within a single pane (raw HTML is escaped when rendered).
- The `⧉` at the left end of the header copies that file's absolute path ("Path copied" flashes briefly).
- External changes, such as those made by claude code, are reflected live automatically via polling at a fixed interval (no manual refresh needed).
- You can't edit or save files. IDE features such as completion, go-to-definition, and the minimap are also out of scope.
