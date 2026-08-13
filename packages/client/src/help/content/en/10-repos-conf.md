# repos.conf and org colors

The repositories that zashiki lists are determined by `~/.zashiki/repos.conf`. One path per line; anything after `#` and blank lines are ignored. The final directory name of each path becomes the org (group).

```
/Users/you/workspace/whiskey
/Users/you/workspace/charlie
```

## Coloring an org

If you add a color token (`#RGB` or `#RRGGBB`) at the end of a path line, that org's heading takes on that color. Orgs without a color use the default color (white).

```
/Users/you/workspace/whiskey   #7aa2f7
/Users/you/workspace/charlie   #98c379
/Users/you/workspace/delta
```

- Place the color token at the end of the line, separated from the path by whitespace.
- A `#` that isn't a color (e.g. `# note`) is a comment, as before.
- If multiple orgs share the same final name, the color written first is used.

## When changes take effect

- **All changes take effect immediately when saved** (no restart needed) — colors as well as adding, removing, or reordering orgs. zashiki watches `repos.conf` and reflects edits live.
- You can also add an org from the app: the **+** button in the SESSION LIST header (or SETTINGS → Organizations) appends the directory to `repos.conf` for you, and it appears in the list right away.
