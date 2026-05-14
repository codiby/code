# Changelog

All notable changes to Codiby Code are listed here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.0] — 2026-05-13

### Added

- **Browser previews are now multi-tab and named.** A session can host any
  number of co-existing browser previews. `browser_open` (and every other
  `browser_*` SDK tool) takes a `name` parameter — reusing the same name
  navigates the existing preview in place, preserving scroll, form input,
  and authenticated cookies. Multiple opens render a Chrome-style tab strip
  in the panel; the chat header gets a chip per remembered name for
  one-click reopen.
- **External MCP server config.** The bridge now merges `mcpServers` from
  `~/.claude/settings.json` (user-level) and `<cwd>/.mcp.json`
  (project-level) into the available tool list. Built-in servers
  (`codiby-code`, `codiby-code-sdk`) keep precedence on name collisions.
- **Tab bar: split "+" into new-session and restore buttons.** The `+`
  creates a new session directly. A new History-icon button next to it
  opens a popover listing closed sessions, with a search input pinned to
  the top that filters by session title.
- **Electron deploy scripts.** `bun run electron:build:replace` does a full
  clean → build → bundle → package → swap that ships a fresh
  `/Applications/Codiby Code.app` and relaunches it. `bun run
  electron:replace` is the no-rebuild self-replace path spawned from
  inside the running app.

### Changed

- **Composer.** Pixel-matches the Linear-style mockup; glass frame with
  ambient color spots.

### Fixed

- **Build watcher.** Serializes rebuilds — a burst of file changes used to
  fire concurrent `buildOnce()` runs that raced on the `dist/` clean and
  left a half-written tree. The watcher now keeps a single build in flight
  and re-runs exactly once if changes arrived during the build.

## [0.6.0] — 2026-05-12

- Electron rewrite. The desktop app now ships as an Electron bundle
  (electron-builder DMG) instead of Tauri. See git history for the full
  set of changes.

[0.7.0]: https://github.com/jovaz/taskr/releases/tag/v0.7.0
[0.6.0]: https://github.com/jovaz/taskr/releases/tag/v0.6.0
