# Changelog

All notable changes to Codiby Code are listed here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.15.0] — 2026-05-29

### Added

- **Unified panel workspace.** Each session's right side is now a single
  PanelsWorkspace instead of a one-at-a-time editor/preview slot. Open
  resources (file editor, browser preview, HTML mockup, plan, diff, PR,
  terminal) become tabs that can coexist across multiple panels. Panels
  resize by dragging the divider, tabs reorder within a panel, and a tab
  can be dragged across panels or split off into a new one (split-right /
  split-down). The layout is remembered per session.

### Fixed

- **Settings no longer blanks the whole app.** An incomplete earlier
  Portless merge had left part of the project Env-exports UI evaluating
  at module load with out-of-scope references, throwing on startup and
  rendering a blank window on fresh builds. The displaced code was
  removed and the affected action-row logic restored.

## [0.14.0] — 2026-05-28

### Added

- **Project actions with optional Portless wrap.** New Actions tab in
  Project Settings lets you declare named dev-server commands per
  project (name · command · hostname). A per-row globe toggle decides
  whether the action is launched through the `portless` CLI for a
  stable `https://<name>.<tld>` URL, or run raw. Includes Start all /
  Stop all, a leading status dot that toggles run/stop, and "Detect
  from package.json" to seed rows from existing `start` / `dev` /
  `serve` scripts. Replaces the older `portless_*` MCP tools with
  generic `actions_list` / `actions_run` / `actions_stop`.
- **Worktree-prefixed Portless subdomains.** With
  `worktreeSubdomains` enabled on the project, actions spawned from a
  worktree session serve at `<branch>.<slug>.<tld>` instead of the
  bare slug — you can keep two checkouts of the same project live on
  different URLs at once. The action's cwd now follows the session's
  worktree rather than always being the project root.
- **Cross-action env injection.** New `portless.exports` entries map an
  env var name to a source action with a format preset (`url` / `host`
  / `port`) or a free-form template (`{host}` / `{url}` / `{port}` /
  `{scheme}`). The bridge resolves these at spawn time and merges them
  into every taskr-spawned process — actions, `/terminal` shells,
  `spawn_terminal` MCP — so a consumer action on branch `feat-x`
  automatically gets `API_URL=https://feat-x.api.localhost` while one
  on `main` keeps the bare URL.
- **MCP-launched terminals are visible and tracked.** `actions_run`
  (and the legacy `portless_run`) now spawns into a PTY labelled
  `Action · <name>` so the user sees the full composite command in a
  live terminal bubble in the chat *and* in the Processes panel —
  same UX as a user-clicked launch. The launch toast still pops with
  the resolved URL.
- **Bundled ripgrep + VS Code-style search panel.** `@vscode/ripgrep`
  ships in `extraResources` so file search no longer falls back to a
  recursive `grep` when the host lacks rg. New `Aa` case toggle (off =
  smart-case, on = case-sensitive), a "files to exclude" input that
  forwards each comma-separated glob as `rg -g '!<glob>'`, results
  grouped by file under a collapsible chevron with per-file match
  counts, and a 150ms debounce with an `AbortController` so stale
  results don't overwrite fresh ones. On a 3.7 GB monorepo, search
  returns in ~60ms (previously multi-second via the grep fallback).
- **Global Portless proxy admin.** New "Portless Proxy" section under
  Settings shows a live status probe (TCP connect to :443, :80,
  :1355), a mode picker (default :1355 / HTTP :80 / HTTPS :443) that
  shells out via `osascript ... with administrator privileges` for
  privileged ports, plus start / stop / trust-CA. TLD is now a global
  preference (`portlessTld`) since the proxy serves one TLD at a time.
- **Dismissable terminals, persisted.** Closing a terminal bubble from
  the chat or shells dock now persists in
  `ui-processes/dismissed-shells.json` per session, with the bridge as
  the source of truth (`GET /sessions/:id/shells/dismissed`, `DELETE
  /sessions/:id/shells/:procId`, `shell_dismissed` WS event). A closed
  terminal stays closed across reloads, and a new procId graveyard
  short-circuits `exec_shell` on tombed procIds so reattached bubbles
  render as exited instead of resurrecting the action.
- **Resizable terminals panel.** Drag handle at the top of the panel
  with `terminalsPanelHeight` persisted in prefs (double-click to
  reset), an always-on bottom bar with a `+ new` affordance even when
  the dock is empty, restyled tab strip, right-click rename
  (`shellRenames`), and an `env · N` pill that popovers the env vars
  taskr injected at the terminal's spawn time.

### Changed

- **Worktree branch pickers virtualized.** The Source and
  Existing-branch Autocompletes in the worktree create form now wrap
  their ListBoxes in `Virtualizer` + `ListLayout` and use the dynamic
  `items` prop, so opening either popover renders only the visible
  rows instead of one DOM node per branch.

### Fixed

- **Portless CLI detection.** The bridge no longer caches a null
  result and walks the user's nvm / fnm / asdf / volta directories
  before falling back to a login-shell `command -v`, so
  launchd-spawned bridges find `portless` without a manual PATH
  override.
- **Build regressions from the portless merge.** A botched merge had
  dropped `PortlessProxySection` into the middle of `HooksEditor`'s
  JSX, broken the `./action-env` import in `server/index.ts`, scattered
  orphan import / type / JSX fragments across both files, and shadowed
  `tld` with a per-project local in `ProjectPortlessPane`. All
  restored so `bun run build-server` + `electron:bundle-resources`
  pass cleanly.

## [0.13.0] — 2026-05-23

### Added

- **Windows installer.** The release workflow now builds an NSIS
  installer for Windows (x64) alongside the macOS DMG. Both platforms
  build in parallel and publish to a single GitHub release.

### Fixed

- **Duplicate DMG in GitHub releases.** electron-builder auto-published
  artifacts when it detected `GH_TOKEN` in CI, then the release action
  uploaded the same files again with different name sanitisation. The
  builder now runs with `--publish never` so only one copy is uploaded.

## [0.12.0] — 2026-05-21

### Added

- **Interrupt-on-send.** New global toggle in Settings → General, on by
  default. When the agent is mid-response and you hit Enter, the current
  turn is cancelled and your new message ships right away — barging-in
  matches the typical "wait, do this instead" intent. Flip it off to
  keep the previous queue behavior, where follow-ups stack and drain in
  order after each turn finishes.

### Fixed

- **Embedded browser respects host zoom.** Cmd+= / Cmd+− on the main
  window no longer leaves a black band along the bottom or right edge of
  the browser preview. Bounds pushed to the native `BrowserView` are
  now multiplied by the host renderer's `webFrame.getZoomFactor()`, so
  the embedded surface tracks the visible div at any zoom level.

## [0.11.1] — 2026-05-21

### Added

- **Remote sessions, end-to-end.** Tab groups whose members all live on
  the same remote inherit that remote: sidebar row and horizontal
  tab-strip paint a colored pill, the GroupComposer wears a matching
  badge, and new sessions spawned from that group land on the right
  remote instead of falling through to local. The frontend WS proxy now
  multiplexes per-remote with merged session broadcasts, HTTP calls
  auto-inject the active `remoteId`, and a `Ctrl+Tab` cycle order
  follows sidebar position with sticky group labels.
- **Port forwards popover.** A chip in the chat header (visible only on
  remote sessions) lists live forwards with copy-URL / open / remove
  per row, plus an inline add form (remote port required, local port
  optional — server picks a free one — label optional).

### Fixed

- **Worktree branch checkout no longer fails when the branch is
  already in a worktree.** Picking such a branch from the
  GroupComposer's branch dropdown now switches the composer's cwd to
  the existing worktree (preserving the parent-repo group via
  `worktreeOrigin`) instead of surfacing git's "already used by
  worktree" error. The git-checkout HTTP handler also surfaces the
  destination path so other callers can react the same way.
- **Active remote no longer races child fetches** on group switch —
  it's synced during render rather than in an effect, so the very
  first request after a swap goes to the right remote.
- **SSH ControlMasters are killed on bun shutdown**, preventing
  orphaned masters from blocking subsequent connections.

## [0.11.0] — 2026-05-19

### Added

- **Per-jar browser cookies.** `browser_open` (and `ui_browser_open`)
  takes an optional `cookieJar` parameter. Previews sharing a jar name
  share cookies, localStorage, and cache; different jars are fully
  isolated via Electron `session.fromPartition()`. Omitting `cookieJar`
  uses the shared `"default"` jar so existing flows are unchanged. Lets
  the agent drive, e.g., a "qa-testing" identity and an "admin" identity
  side by side without cross-contamination.
- **Auto-focus browser preview on agent actions.** When the agent runs
  an action-style `browser_*` tool (click / hover / type / press_key /
  select_option / scroll / navigate / handle_dialog) on a preview that
  isn't the active tab, the panel switches to it so the user actually
  sees the action happen. Observational tools (snapshot, screenshot,
  evaluate, `wait_for`, console / network reads) never trigger a
  switch. Controlled by a new `autoFocusBrowserOnAction` setting —
  global default in Project Settings → General, with a per-project
  override (Inherit / Always / Never) on each tab group.
- **Ctrl+Tab session switcher.** A most-recently-used switcher with
  inline chat preview, mirroring the editor-style tab-switching the
  rest of the app already uses.
- **Worktree-aware autogroup.** New sessions opened in a worktree are
  bucketed under the parent repo's tab group instead of the worktree
  branch, and file mentions resolve against the same parent root.

### Changed

- **Model picker driven by the Claude SDK.** The default-model dropdown
  is populated from `supportedModels()` instead of a hardcoded list, so
  newly-released Claude models show up the moment the SDK exposes them.

## [0.10.1] — 2026-05-18

### Fixed

- **Browser preview in-page navigation.** Switching tabs no longer
  snaps the embedded browser back to its original URL — the host now
  mirrors the live URL into session state via the `url-changed` relay
  event, so a remount re-opens the preview at the current page rather
  than the one `browser_open` was first called with.

## [0.10.0] — 2026-05-16

### Added

- **Hooks editor.** Per-scope (user / project / local) UI for editing
  Claude Code hooks (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`,
  `Notification`, `Stop`, `SubagentStop`, `PreCompact`, `SessionStart`,
  `SessionEnd`), including matcher patterns and per-command timeouts.
- **Per-project env injection.** Tab groups grow `envVars` and the
  global `globalEnvVars` preference, layered (process.env → global →
  project) into every Bash tool call and user terminal.
- **Project Settings modal.** Sidebar-driven modal grouping global
  settings (general / telegram / deepgram / tailscale / mobile /
  remotes / plugins / hooks / environment / tab groups / about) and
  per-project overrides (identity, defaults, permissions, env,
  MCP, hooks) under one roof.
- **Per-project overrides on tab groups.** `TabGroupInfo` grows
  `autoClaim`, `defaultModel`, `defaultAgent`, `systemPromptAddition`,
  `envVars`, `autoApproveRules`, and `mcpOverrides` — each optional and
  layered over the global default.
- **Double-Esc interrupt.** Press Esc twice quickly to interrupt the
  current turn even in permission-bypass mode; user-interaction tools
  (`AskUserQuestion`, dialogs) keep prompting normally rather than
  being auto-approved.

### Changed

- **Tauri references removed.** The desktop shell is Electron-only;
  legacy `@tauri-apps/plugin-*` imports and `electron:replace` /
  `electron:build:replace` scripts retain their names for muscle
  memory but no longer touch Tauri.

### Fixed

- **Windows titlebar overlay.** Hide the native titlebar on Windows,
  align the custom overlay to the right height, and match its colour
  to the surrounding chrome so the window-controls strip blends in.

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

[0.14.0]: https://github.com/jovaz/taskr/releases/tag/v0.14.0
[0.13.0]: https://github.com/jovaz/taskr/releases/tag/v0.13.0
[0.12.0]: https://github.com/jovaz/taskr/releases/tag/v0.12.0
[0.11.1]: https://github.com/jovaz/taskr/releases/tag/v0.11.1
[0.11.0]: https://github.com/jovaz/taskr/releases/tag/v0.11.0
[0.10.1]: https://github.com/jovaz/taskr/releases/tag/v0.10.1
[0.10.0]: https://github.com/jovaz/taskr/releases/tag/v0.10.0
[0.9.0]: https://github.com/jovaz/taskr/releases/tag/v0.9.0
[0.8.0]: https://github.com/jovaz/taskr/releases/tag/v0.8.0
[0.7.0]: https://github.com/jovaz/taskr/releases/tag/v0.7.0
[0.6.0]: https://github.com/jovaz/taskr/releases/tag/v0.6.0
