**English** | [日本語](./README.ja.md)

# .githooks — contamination-prevention hooks

A version-controlled set of git hooks that stops secrets, internal-only terms, and PII "before they get in."
They are enabled via `core.hooksPath`, so contributors who clone the repo get the same defenses.

## Setup

`package.json`'s `prepare` configures this automatically during `pnpm install`. To do it manually:

```bash
git config core.hooksPath .githooks
brew install gitleaks   # if not yet installed
```

## Hook list

| Hook | Target | Method |
|---|---|---|
| `pre-commit` | staged diff | `gitleaks git --staged` + internal-term denylist |
| `commit-msg` | commit message | `gitleaks stdin` + denylist |
| `pre-push` | commits being pushed | `gitleaks git --log-opts=<range>` |

Since git hooks cannot protect the body of gh PRs/Issues/comments, submissions via Claude are
scanned separately by `../hooks/scan-gh-body.sh` (a PreToolUse hook in `.claude/settings.json`).

## Denylist of internal-only terms / PII

If you list one regular expression per line in `deny-terms.local.txt` (**local-only, already in .gitignore**),
each hook greps staged added lines, commit messages, and gh bodies against it.
The denylist itself is internal information, so do not commit it.

## Escape hatches for false positives

- A `gitleaks:allow` comment on the relevant line
- Registering the fingerprint in `.gitleaksignore`
- Adding the excluded path to `[allowlist].paths` in `.gitleaks.toml`

## Last line of defense (GitHub side)

So that things are still stopped even if they slip past the local hooks, enable
**Secret scanning → Push protection** in the repository settings on GitHub.
