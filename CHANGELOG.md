# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.18.0] - 2026-08-30

### Added

- Image and video preview in the Viewer: image and video files opened from the Explorer or dropped from Finder now render inline instead of showing raw bytes (#314)
- `Cmd+P` quick-open palette: fuzzy-find a file across all orgs (the active org ranks first) and open it in the Viewer; append `:line` to jump to a line (#312)
- `Cmd+O` opens the native file picker and shows the chosen file read-only in the Viewer (#312)

## [0.17.0] - 2026-08-29

### Added

- A dedicated Activity view that splits session activity out of the terminal (#306)
- A Notifications settings tab with per-category sound presets and an inline preview (#304)
- VSCode-style Tab / Shift+Tab block indent in the clipboard edit modal (#264)

### Fixed

- A leaked terminal alternate screen is now exited before the restore replay, so restored output renders in the normal buffer (#308)
- A WebView back gesture can no longer strand the app on the startup splash (#302)
- Unsaved Memo edits are flushed before a self-update, with a warning before the window unloads (#300)
- Background shells are now counted per task instead of per process, so the count stays accurate (#298)
- Notification sounds no longer clip, now routed through a shared audio context and limiter (#291)

## [0.16.0] - 2026-08-28

### Added

- Persistent click-to-focus toasts when a session finishes or waits for input; `ZK_NOTIFY_HISTORY=off` keeps those events out of the NOTIFICATION list while keeping the toasts (#282)
- Bulk mark-as-read with checkboxes and select-all on notifications (#276)
- Per-category notification toggles in Settings (#279)

### Changed

- A session standing by with open tasks now shows a watching indicator instead of the done checkmark (#292)
- Welcome onboarding is visually refined and now closes only via its buttons (#274)

### Fixed

- The session usage percent no longer goes stale while a limit banner is on screen (#294)
- Quoting a usage-limit message in the terminal no longer falsely triggers limit detection (#290)
- A terminal running the FleetView dashboard now reports its working/waiting status correctly (#288)
- The subagent chip stays visible while the main session is also running (#286)
- Sessions no longer flip to waiting on informational notifications — only ones that ask for input mark waiting (#281)
- The Memo tab keeps a constant width between saved and unsaved states (#273)

## [0.15.0] - 2026-08-27

### Added

- First-run welcome onboarding that hands off into the Claude Code integration setup, reopenable from Settings (#270)
- An opt-in Memo editor tab (#268)

### Changed

- Explorer row spacing is loosened to match VSCode (#266)
- Self-update is unified on a signed-dmg swap via install.sh (#262)

## [0.14.0] - 2026-08-26

### Added

- Right-click context menu for file operations on Explorer entries and preview tabs (#249)
- Preview a file dropped from Finder in the Viewer (#250)
- Render GFM tables, task lists, and links in the Markdown preview (#247)
- Highlight the matched query in Help search results (#245)

### Changed

- The header account email is now an account menu button for switching accounts and signing out (#253)

### Removed

- The inactive-view dimming overlay, so background views stay fully legible (#251)

### Fixed

- Input modes are restored on attach so mouse tracking can no longer leak across terminals (#259)

### Security

- Replaced ReDoS-prone regexes with linear parsers, bounded the live-timer tail, bumped nanoid to 3.3.18 (GHSA-2v37-7h3g-55p8), and restricted the CI token to read-only (#240)

## [0.13.0] - 2026-08-25

### Added

- Toggle the Explorer view with Cmd+B (#221)
- Group worktrees under their repository in the Explorer, with per-extension file icons (#234)
- Line numbering and trailing-whitespace trimming in the clipboard edit modal (#227)

### Changed

- The usage gauge now tracks window time and pins each cell to its widest reading so the width no longer jitters (#225)
- Refined the Help and Settings modals for scannability, with a guard against discarding unsaved edits (#228)
- UI chrome is no longer drag-selectable; the terminal and content stay selectable (#231)
- Source Control keeps its state across view switches (#233)

### Fixed

- Self-update now refreshes the Homebrew tap first so a new release installs (#223)
- Help search commits on IME confirmation and shows a result count (#235)

## [0.12.0] - 2026-08-25

### Added

- A loading spinner inside Search View while a search runs (#207)
- A usage meter in the account footer, with a toggle between remaining and elapsed time (#216)

### Changed

- Moved the signed-in account indicator into the native macOS title bar (#209)
- Search View now fills the full height of the left area (#210)
- The active tab's org color now extends as a full-width line under the tab bar (#212)
- Refined the Settings modal layout and visual tone (#214)
- Help is now a modal built on the shared Modal shell (#218)

## [0.11.0] - 2026-08-25

### Added

- Show the signed-in Claude account, with a refresh that fans out to all sessions (#184)
- A settings icon in the session list while a Claude Code menu is open (#190)
- Footer tooltip now shows the local reset time and warns as you approach the session limit (#201)

### Changed

- Reworked the layout into LEFT / CENTER / RIGHT areas with a navigation activity bar (#198)
- The Settings modal is now fixed to 80% of the window with a right-side menu (#197)
- The active tab's bottom border is tinted with the org color (#196)
- The Clipboard edit modal shows its help inline and no longer re-copies to the clipboard on close — it is a pure scratchpad (#178)
- The weekly usage reset countdown now shows days through seconds (#182)

### Removed

- Account-wide rate-limit cells (5-hour / weekly) from the session status footer; they remain in the account-usage footer, which reports the account-wide maximum rather than a session's stale-low snapshot (#180)

### Fixed

- The account-usage footer stays in sync while a session sits idle at a reached limit (#182)
- The global footer picks the freshest account-usage reading (#192)
- Scroll the terminal scrollback with the mouse wheel under WKWebView (#195)
- Detect a skill/workflow agent tray as a running background agent (#185)
- Stop status-bar drag-selection and make hover tooltips show reliably (#186)

## [0.10.0] - 2026-08-23

### Added

- View a file's diff in a GitHub-style Diff tab from Source Control (#174)

### Fixed

- Update button now upgrades and relaunches: self-update runs in a detached helper that survives the app quitting, and its output is logged (#173)

## [0.9.0] - 2026-08-22

### Added

- A first-run setup wizard, with a Settings opt-in for registering the Claude Code hook and statusLine bridge (#145)
- Mark, delete, and date worktrees directly from Source Control (#167)
- Org display aliases and per-org notes (#163)
- A persistent, rotating, redacted server log (#160)
- External-dependency boundary failures now surface as Warn notifications (#159)
- A configurable external-editor command in the Settings view (#157)
- Configurable session status footer severity thresholds in Settings (#169)

### Changed

- The Settings view is now a modal with General and Development tabs (#166)
- Session state is now event-authoritative, with a screen-scrape fallback (#146)
- Vertically center session-row activity icons and always show the subagent count (#149)

### Fixed

- Disable WebKit autocorrect on the Search input and ignore IME-confirming Enter (#151)
- Restore scrolling in the Viewer code view (#152)

## [0.8.0] - 2026-08-21

### Added

- Self-contained, opt-in account-usage footer that needs no edits to your Claude settings.json (#139)

### Changed

- Moved the developer tooling into a Settings "Developer mode" section (#141)

### Fixed

- Keep the Cockpit Terminal's running glyph accurate when a wide fan-out scrolls the heading out of view (#138)

## [0.7.0] - 2026-08-21

### Added

- Duplicate a session by forking it into a new independent terminal (#122)
- Self-update straight from the Update button via Homebrew (#125)
- "Close" and "Close all" actions in the tab right-click menu (#132)
- Auto-scroll the active tab into view, and hide the tab bar scrollbar (#130)

### Changed

- Reworked the NOTIFICATION view and the update toast/button (#123)
- Running cockpit terminals now show a spinning loading glyph (#126)

### Fixed

- Resolve ripgrep to an absolute path so search keeps working under a thin PATH (#127)
- Activate the Viewer when opening a file from the Explorer (#133)

### Removed

- The obsolete header refresh button from Session List and Source Control (#129)

## [0.6.0] - 2026-08-20

### Added

- A clipboard-edit modal for reviewing and repairing hard-wrapped commands before they run in a session (#90)
- An always-visible account-usage indicator in the global status bar, showing the current 5-hour session and week aggregated across sessions from the statusLine bridge (#115)

### Changed

- The session status footer is now always shown and tinted with the org color (#81)
- Session status is split into a lifecycle glyph and activity chips (#83)
- SESSION LIST highlights only the selected session (#84)
- The elapsed footer gains a day unit (`2d 3h 4m 5s`) and turns red once a full day has passed (#115)
- Renamed the "Panel" UI concept to "View", and the Git panel to "Source Control" (#108)

## [0.5.0] - 2026-08-20

### Added

- A header update banner with a one-click link to the latest release, shown while the update checker reports a newer version — the notice is no longer panel-only (#78)

## [0.4.0] - 2026-08-19

### Added

- A session status footer under the terminal showing this-turn and session token usage and elapsed time, plus 5-hour and weekly account usage limits when the statusLine bridge is configured (#74)
- The previous crash log in a copyable dialog on the next launch, with a bug-report link (#73)
- A background-shell badge on session rows so you can tell which sessions have a shell running in the background (#69)
- A confirmation before quitting while sessions, agents, or background shells are still running (#65)

### Changed

- The installer quits a running Zashiki before swapping the app bundle, so the new version launches on next open instead of the old one lingering. It requests a graceful quit through the app's own guarded-quit path and never hard-kills (#66)

## [0.3.0] - 2026-08-19

### Added

- Manual "Check for updates" in SETTINGS, reporting whether a newer release is available (#62)

### Changed

- Check for a newer release every 3h instead of every 24h, so running clients notice sooner (#62)

## [0.2.0] - 2026-08-19

### Added

- Copy a session's Claude Code session ID from the tab and session-list context menus (#50)

### Fixed

- Fall back to a fresh session when resume fails instead of dropping to a bare shell (#52)
- Enable "Copy session (resume)" by serializing the session id on state sync (#55)

## [0.1.1] - 2026-08-19

First public release. macOS (Apple Silicon).

### Added

- In-session terminal search — a `Cmd+F` find bar (#35)
- One-line `curl` installer that avoids the Gatekeeper "damaged" quarantine (#31)
- Outdated-bundle notice in the NOTIFICATION panel (#26)
- `POST /api/focus` to focus a session from outside the app (#5)

### Changed

- Migrated hardcoded Unicode glyphs to Material Symbols icons (#9)
- Localized session context-menu labels (#7)

### Fixed

- Reliably restore full session scrollback and keep the scrollbar visible (#41)
- Fall back to the org name in session-list rows until the title resolves (#39)
- Tab drag-and-drop in the packaged app (#38)
- Render the terminal via the WebGL addon to fix intermittent blank sessions in the packaged app (#33)
- Strip terminal query replies that leak as input at a bare shell prompt (#23)
- Isolate git status per repo so one bad repo can't blank the panel (#13)
- Session rename by keying titles on a stable `windowId` (#8)

### Removed

- npm CLI distribution — Zashiki is now a desktop app only (#21)

[Unreleased]: https://github.com/kounetsuman/zashiki/compare/v0.18.0...HEAD
[0.18.0]: https://github.com/kounetsuman/zashiki/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/kounetsuman/zashiki/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/kounetsuman/zashiki/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/kounetsuman/zashiki/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/kounetsuman/zashiki/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/kounetsuman/zashiki/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/kounetsuman/zashiki/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/kounetsuman/zashiki/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/kounetsuman/zashiki/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/kounetsuman/zashiki/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/kounetsuman/zashiki/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/kounetsuman/zashiki/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/kounetsuman/zashiki/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/kounetsuman/zashiki/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/kounetsuman/zashiki/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/kounetsuman/zashiki/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/kounetsuman/zashiki/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/kounetsuman/zashiki/releases/tag/v0.1.1
