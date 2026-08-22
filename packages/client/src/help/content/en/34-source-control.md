# SOURCE CONTROL

Stage and commit git changes (VSCode SOURCE CONTROL style). Open it with the ⑂ icon in the footer or `Ctrl+Alt+G`. It's a tree of org → repository → section (Staged / Changed) → files.

- The buttons at the right end of each row are always visible.
  - File rows: Changed shows `+` (stage), Staged shows `−` (unstage).
  - Repository rows: `+` stages everything (`git add .`), `−` unstages everything (`git reset .`).
  - `⧉` copies that file's absolute path ("copied!" flashes briefly).
- Clicking a file name opens that file in your external editor (`ZK_EDITOR`); double-clicking opens its diff in a tab.
- The diff tab renders GitHub-style with an Unified ⇄ Split toggle. Staged and Changed rows open independent diffs. A binary or very large diff is not rendered and offers "Open in editor" instead.
- The commit message field appears **only inside the expanded repository** (one field per repository). Commit with `⌘Enter` / `Ctrl+Enter` (an Enter that confirms a conversion is ignored). Commit can't be pressed when nothing is staged.
- Status colors: Added A = green / Modified M = yellow / Deleted D = red / Renamed R = cyan / Untracked ?? = blue.
- Use the `↻` in the header to refetch (a spinner shows while fetching; on failure, hover `⚠` for the cause). During the first fetch a spinner appears instead of the tree, and if there are no changes it shows "No changes".
