# Changelog

All notable changes to Codiby Code are listed here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.9.0] — 2026-05-16

### Added

- **Remote sessions over SSH.** A session can now live on a remote
  machine: configure a remote with an SSH alias, a bridge port, and an
  optional accent color, and its sessions sit alongside local ones in the
  same window. The local server (port 3111) acts as a gateway and proxies
  HTTP + WebSockets to the remote bun bridge.
- **SSH ControlMaster tunnels.** One lazy master connection per remote,
  ref-counted, with exponential-backoff reconnect (1–60s) and live
  status badges (idle / connecting / online / reconnecting / offline).
  Stale control sockets in `~/.codiby/ssh-control/` are cleaned up on
  startup.
- **Per-session port forwards.** Add or remove SSH port forwards on a
  remote session from the HTTP API; they multiplex over the master and
  survive pane reopens.
- **Remotes management UI.** A new Settings section to add, edit, test,
  and delete configured remotes. Editing or deleting a remote tears down
  the active tunnel cleanly.
- **Remote sessions cache.** Metadata snapshots in
  `~/.codiby/ui-remote-sessions/` keep remote sessions visible (with a
  stale badge) even while the tunnel is down.
- **Tab groups.** Group sessions under a color-coded, collapsible header
  with an optional custom icon. The new Group Composer panel can bulk-
  spawn sessions into a focused group.
- **New Session modal: target picker.** Pick the target machine (Local
  or any configured remote) when creating a session; the last target is
  remembered per machine. Browse / git / recent endpoints automatically
  route to the right server.
- **Activity bar session actions.** Quick "+" and a history popover with
  a searchable list of closed sessions, hoisted into the Electron
  activity bar.
- **Session tab strip.** Horizontal mini-pill tab strip as an
  alternative to the vertical sidebar, with group headers, collapse, and
  scrollable overflow.
- **Worktree create form (shared).** The worktree-creation UI was
  extracted into a single component used by both the Worktree modal and
  the New Session modal — package manager picker, env copy, and
  dependency install/link in one place.
- **`~/.codiby/` migration.** First-run migration moves UI state from
  `~/.claude/ui-*` to `~/.codiby/`; the legacy Claude CLI state is left
  untouched.

### Changed

- **Lazy session spawn.** Persisted sessions show up in the UI
  immediately at startup, but the underlying Claude process is no longer
  resumed until the tab is focused or a message arrives. `SPAWN_MODE` is
  now only a PATH-enrichment hint.
- **Session type extended.** `remoteId` (null = local), `portForwards`,
  and `runtimeStatus` (starting / running / stopped) are now part of the
  Session shape.
- **Tab bar styling for remotes.** Remote sessions get a thin left-edge
  tint in the remote's accent color — no extra icon, just the strip.
- **Workspace state.** `tabGroups`, `tabGroupMap`, and
  `expandedGroupIds` are persisted across restarts.

## [0.8.0] — 2026-05-13

### Added

- **Chat-focus layout mode.** A single-pane focus view with a custom
  title bar; workspaces let you keep multiple focus sessions side by
  side and switch between them.
- **Per-pane chat history.** Each focus pane keeps its own message
  history; title-bar search jumps across panes.
- **Windows packaging.** electron-builder NSIS target produces a Windows
  installer.

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

[0.9.0]: https://github.com/jovaz/taskr/releases/tag/v0.9.0
[0.8.0]: https://github.com/jovaz/taskr/releases/tag/v0.8.0
[0.7.0]: https://github.com/jovaz/taskr/releases/tag/v0.7.0
[0.6.0]: https://github.com/jovaz/taskr/releases/tag/v0.6.0
