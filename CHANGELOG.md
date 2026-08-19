# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/kounetsuman/zashiki/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/kounetsuman/zashiki/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/kounetsuman/zashiki/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/kounetsuman/zashiki/releases/tag/v0.1.1
