# Changelog

All notable changes to Codiby Code are listed here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.20.0] — 2026-06-05

### Added

- **Manage MCP servers from the panel.** A new MCP card in the file sidebar's
  icon rail lists every configured server — the built-in bridge servers (shown
  locked) alongside your own from `~/.claude/settings.json` and the project's
  `.mcp.json`. Add a `stdio`, `http`, or `sse` server through an inline form
  (choosing Global or Project scope) or remove one in a click; the changes are
  written straight to the matching config file.
- **Restart suggestion when MCP servers change.** Because servers are only read
  when the session's provider spawns, adding or removing one raises a
  bottom-right banner listing exactly what changed (`+ added` / `− removed`).
  Accepting restarts the session in place — the provider re-spawns with the new
  server set while the conversation history is preserved.

### Fixed

- **Mobile home list ordering counts tool activity.** Sessions in the mobile
  home list now sort by genuine last activity: a session mid-run streaming
  Read/Bash/Edit no longer sinks down the list while it waits for a final text
  reply. Only system bookkeeping notes are ignored.
- **No accidental text selection in the file panel.** Dragging in the panel no
  longer selects label text.

## [0.19.0] — 2026-06-05

### Added

- **Automatic updates from GitHub releases.** The app checks for a newer
  release on launch and every few hours. When one is available, a banner offers
  to update: it downloads the matching `.dmg`, shows a native authentication
  prompt, then quits, swaps the bundle in `/Applications`, and relaunches —
  back on the new version in one click.

## [0.18.0] — 2026-06-05

### Added

- **The file sidebar is now a column of cards.** Processes, Changes, Pull
  Requests, Tools, and Files each live in their own independent, collapsible
  card. A compact icon rail sits at the top — one shortcut per visible card
  (with live counts) plus a collapse toggle that folds the whole panel down to
  a slim strip, leaving just that button.
- **Per-file diff counts in Changes.** Every entry shows its added/removed line
  totals (`+48 −6`) from `git numstat`, with a footer summarizing the whole set
  (`12 files · +387 −132`). The Changes card is also vertically resizable —
  drag the grip to grow or shrink the list, and the size sticks.
- **Search as a card.** Hitting the rail's search icon (or `Cmd+Shift+F`) swaps
  the cards for an in-panel search card; closing it brings them back.
- **Focus ring follows the terminal.** The blue focus border now moves between
  the chat and the terminals dock depending on where you're working, instead of
  staying pinned to the chat.

### Changed

- **A more professional card design.** Flat surfaces, hairline borders, and
  minimal shadow replace the heavy drop-shadow look. Headers are quieter — a
  thin line-glyph in the accent color, restrained typography, and a calm count
  in place of the bright candy-dot pill.
- **Settings moved to the title bar.** The gear now sits next to the layout
  switcher; the old vertical activity bar is gone.
- **Compare against the base branch.** The Changes panel gains a segmented
  "Uncommitted / vs &lt;base&gt;" toggle that lists everything the branch
  introduced relative to its merge-base, not just working-tree edits.
- **The terminals dock is a rounded minicard** in both its collapsed and
  expanded states, aligned to the panel edges.

### Removed

- **Plugins sidebar panel.** The plugins entry point was retired along with the
  activity bar.

## [0.17.0] — 2026-06-03

### Added

- **Pick which chats fill a workspace.** Entering the Chat Focus layout no
  longer drops every open session into the grid — a workspace now starts with
  empty placeholder panes. Click a pane to choose its chat from a searchable
  picker, add more panels with the side button, and unused slots stay put as
  placeholders. Newly-opened chats no longer auto-appear, so you decide exactly
  what goes where.
- **Per-session and per-group accent colors.** Each chat can carry an accent
  color that tints its message bubbles in both the standard and Chat Focus
  layouts. A session inherits its tab group's color or takes an explicit
  override — picked from the pane header in focus mode or the session tab's
  right-click menu. Turn it on under Settings → General with a live preview, and
  optionally extend the tint to the whole chat background.
- **Open a focus pane in full view.** Every pane in the Chat Focus layout gains
  a button that selects its session and switches back to the standard layout
  with the sidebar.

## [0.16.2] — 2026-06-01

### Added

- **Cross-file Go to Definition.** Cmd+Click (or F12) on a symbol now jumps to
  its definition even when it lives in another file — the target opens as a
  preview tab with the cursor placed on the exact line and column. Definitions
  in dependencies (`node_modules`) or outside the project (TypeScript lib
  `.d.ts` files) open read-only, and language intelligence stays active on them
  so you can keep chaining jumps from one declaration to the next.

## [0.16.1] — 2026-06-01

### Fixed

- **Chat no longer renders blank when switching sessions.** Selecting a session
  that shared the previous one's tab layout (e.g. moving between two sessions
  that each had only the chat open) could leave the workspace empty because the
  layout for the newly-selected session was never seeded. Switching sessions now
  always reconciles the layout, so the chat pane shows up reliably.

## [0.16.0] — 2026-06-01

### Added

- **Multiple files open at once, VSCode-style.** The editor is no longer a
  single-file slot — every file you open becomes its own tab and they coexist.
  Opening a file from chat or a diff shows it as an italic *preview* tab that
  the next file replaces in place; double-clicking the tab (or editing the
  file) pins it so it sticks around. Open tabs and the active one are
  remembered per session.
- **Chat-left / resources-right by default.** New tabs now place themselves by
  zone: the chat stays on the left and editors, browser previews, mockups,
  diffs, and terminals land in a panel to the right. Opening the first such
  resource splits a fresh panel automatically; later ones join the panel that
  already owns their zone.

### Changed

- **Browser previews are first-class workspace tabs.** Each open browser
  preview is now a regular panel tab that can sit alongside editors and other
  previews, be reordered, split off, or dragged across panels — replacing the
  bespoke in-panel browser tab strip. The visible preview drives focus-mode
  and the header chips automatically.
- **Todo panel driven by the incremental Task tools.** The Claude Code preset
  now manages todos through `TaskCreate` / `TaskUpdate` / `TaskList` rather
  than snapshot-style `TodoWrite`. These are reconstructed into the full todo
  list and surfaced in the dedicated panel, and are kept out of the chat
  transcript and session previews (the legacy `TodoWrite` path still works for
  older sessions).
- **Browser screenshots are saved to disk.** `browser_take_screenshot` now
  writes a PNG under `~/.codiby/screenshots/<session>/` and returns its file
  path instead of inlining a large base64 data URL into the tool result.
- **Updated the Claude Agent SDK** to 0.3.159 and added the Anthropic SDK and
  Zod as direct dependencies.

## [0.15.1] — 2026-05-29

### Fixed

- **Browser/mockup no longer floats over the new-session composer.** When you
  focused a project group (showing the inline new-session composer) while a
  session had a browser preview or HTML mockup open, the preview kept rendering
  over the composer and the composer stayed squished. The right-side panel
  workspace is now hidden in composer mode, and the composer takes the full
  width.

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
