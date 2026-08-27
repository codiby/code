# Changelog

All notable changes to Codiby Code are listed here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.29.0] — 2026-08-26

### Added

- **One previewer for everything a session holds.** Opening an image in the
  chat used to give you a bare fullscreen bitmap, and the Resources drawer had
  a second, unrelated lightbox beside it. Both are now the same previewer, and
  it renders whatever the item is: images keep pinch, drag and wheel zoom, PDFs
  and mockups render in a frame that owns its own scrolling, and anything else
  offers Save and Open. Whatever you opened brings the rest with it as a
  filmstrip along the bottom — the thread's images when you came from the chat,
  the whole drawer when you came from Resources — so the arrow keys, the
  chevrons and the thumbnails walk the set instead of making you close and
  reopen. Deleting or filtering away the item you are looking at closes the
  previewer rather than stranding it on a copy that no longer exists.
- **Right-click to copy an image.** The previewer has its own menu: Copy Image
  puts the bitmap on the clipboard rather than its address, re-encoding to PNG
  when the source is a JPEG or an SVG, since the clipboard takes nothing else.
  A mockup adds Copy HTML, and everything offers Save As, Open in Browser and
  Copy Address. It replaces the native menu on the desktop and is the only one
  the browser and phone builds have ever had.
- **Ports forwarded to a remote viewer.** When you reach the bridge from
  another machine, everything the agent starts binds to the bridge's loopback
  and is invisible from where you are sitting — and the agent had no way to
  know, so it kept handing over localhost URLs that could not open. It now
  detects a remote viewer from the frontend socket's peer address and gets
  `ui_forward_port`, `ui_list_port_forwards` and `ui_close_port_forward` to do
  something about it. The proxy is raw TCP, so WebSocket upgrades and TLS pass
  through untouched. A loopback viewer wins when both are open — with the
  desktop app on this machine localhost already works, and the briefing would
  only cost tokens.

## [0.28.0] — 2026-08-25

### Added

- **Diffs typeset inside the answer.** A ` ```diffdoc ` block renders a change
  as part of the explanation instead of as an attachment beside it — no tool
  header, no result footer, no card. Prose notes sit between the hunks, right
  against the lines they describe, and when a line is replaced one-for-one only
  the span that actually changed is tinted, so you read the edit rather than
  diffing two long lines by eye.
- **Answers you advance one step at a time.** A ` ```explain ` block shows a
  long or branching answer as a sequence of steps with the objective pinned
  above. Steps you have read collapse into a one-line rail instead of piling
  up, and the frame holds the height of the tallest step so the text and the
  button never jump between advances. A step can carry options, which makes it
  a decision that blocks until you pick one; your answer folds back into the
  same figure rather than starting a new bubble, so the thread stops growing.
  Nothing is stored — the state is derived from the transcript, so it survives
  a reload. Both the desktop and phone threads render them, in both themes.
- **Native deployment without a container.** A `process-compose.yaml` runs the
  bridge directly on a host: install, build the frontends once, then serve,
  gated on `/health` and restarted on failure. Replaces leaving `bun dev`
  attached to an ssh session.

### Changed

- **The chat sits on the page, not on a card.** The chat panel painted itself a
  shade lighter than everything around it, which read as a raised surface. It
  now shares the base background, and the terminal — whose palette lives in
  JavaScript, out of the stylesheet's reach — matches it too, including the
  glyph under a block cursor that used to flash the old tone while you typed.
  Panels with tabs keep the lighter fill so the active tab still cuts against
  it.

### Fixed

- **A monorepo no longer exhausts file descriptors.** The session watcher threw
  away events from `node_modules` and `.git`, but only after registering the
  watches — and the recursive watch on each top-level directory descended into
  every nested `node_modules` anyway. On a large monorepo that held tens of
  thousands of descriptors open to feed events nothing ever read, enough to hit
  `EMFILE` and take the provider process down. Ignored directories are now
  skipped before a watch is placed.

## [0.27.0] — 2026-08-12

### Added

- **Chat width control.** Three buttons beside the Resources chip set how wide
  the chat column grows: compact (896 px), standard (1152 px, the default) or
  full-bleed. The message thread, the composer and the empty-session headline
  all follow it, so the column stays aligned, and the choice persists with the
  rest of your preferences. The session accent tint still spans the whole pane,
  so narrowing the chat leaves no untinted stripe beside it.
- **Pinned sessions and search on mobile.** The home list gains a search field
  that ranks name matches above project and group matches — with a loose
  "letters in order" fallback for a phone keyboard — and highlights what
  matched. Long-pressing a row opens a sheet to pin or close that session.
  Pinned sessions lift into a block at the top and share the desktop's pin
  list, so a pin made on the phone shows up in the tab bar too.
- **Bare URLs, domains and emails become links.** Text an agent never wrote as
  Markdown now links anyway: `https://` URLs, `www.` hosts, plain domains and
  email addresses. Linking runs over the finished document rather than line by
  line, so it never touches existing links or code spans, and schemeless
  domains only link on a short TLD list that excludes file extensions —
  `bridge.ts`, `main.rs` and `README.md` stay plain text.
- **Copy Image in the desktop right-click menu.** Right-clicking an image
  copies the actual bitmap, the same for inline attachments, bridge-served
  files and remote URLs, with Copy Image Address alongside it for anything
  that isn't inline base64.

### Changed

- **Worktrees live inside their repo.** A new worktree is created at
  `<repo>/.worktrees/<branch>` instead of `<repo-parent>/.wt/<branch>`, so the
  owning repo is readable straight off the path and two projects sharing a
  parent directory can no longer collide. The directory is kept out of
  `git status` locally. Which repo owns a checkout is now answered by git
  rather than counting directory levels, which is what used to file a session
  spawned in a worktree under the wrong group. Worktrees created by older
  versions keep working everywhere.
- **Quieter tool and agent cards.** Tool rows inside a run card dropped their
  left rail and indent — the card already groups them. Agent cards start
  collapsed instead of expanded, and while a sub-agent runs its title sweeps
  with the same shimmer the reasoning blocks use, so a closed card still reads
  as alive.
- **The phone app no longer refreshes itself.** A new build used to take over a
  page that was already open and reload it mid-session. It now installs in the
  background and waits: settings shows an "Update ready" dot and "Force
  refresh" is the only thing that swaps it in.

### Fixed

- **One plan, one approval card.** An `ExitPlanMode` call waits for as long as
  you take to read the plan, and the server was closing the connection ten
  seconds in. The agent saw the drop, called the tool again, and a single plan
  turned into a queue of approval cards with the first one hung forever. Calls
  that block on a person now keep their connection alive while they wait, and a
  retry attaches to the card already on screen instead of opening another.
- **The production build can no longer ship a development React.** The browser
  bundles never had `NODE_ENV` defined, so the sideloaded ReactDOM runtime
  could go out as a dev build. It is now set per build mode, and the build
  fails outright if the production runtime still carries dev markers.
- **The process monitor no longer stalls the app.** Its port poll shelled out
  to `lsof` across the whole machine every 3 s and blocked the event loop while
  it ran — 1.9 s out of every 3 s on a host with one very busy process, which
  showed up as stuttering terminals and slow HTTP. It now resolves ports from
  the tracked pids only, asynchronously, and a slow poll can't stack on the
  next one.
- **The session watcher stops drowning in `node_modules`.** Watching a repo
  recursively registered an inotify watch per directory — about 8.5k on a
  typical project, nearly all of them under `node_modules` and `.git`, whose
  events were discarded anyway. Enough of them exhausted the system watch limit
  and file changes silently stopped being noticed.

## [0.26.0] — 2026-08-05

### Added

- **A blank session opens on the new-session screen.** A session with no
  messages now shows the composer centred under a "New session in *folder* with
  *provider*" headline, the same shape as the group's new-session screen,
  instead of a bare "Send a message to start". The first message docks it to the
  bottom: the headline and branch chip collapse away while the composer travels
  down and the opening exchange rises to meet it. The composer never changes
  parent — centred is a transform — so focus, caret and in-flight IME
  composition survive the move.
- **Messages rise into place.** Every new block in the thread — the message you
  just sent, the agent's reasoning, its tool runs, each finished text block —
  fades up instead of popping in. A growing streaming block animates once, not
  on every delta, and switching sessions or paging in history stays still.

### Changed

- **The reasoning block no longer resizes the chat.** It used to render fully
  expanded while arriving and collapse to a one-line chip when done, so every
  delta pushed the conversation down and the turn ended with a drop. It is now
  the same single truncated line in both states, with a gradient sweeping across
  the text while the model thinks. Measured over real turns, the chat moves 0 px
  where it previously moved hundreds. Clicking still expands the full reasoning.

### Fixed

- **Entrance animations no longer die a frame in.** A message changes `id`
  mid-life — an optimistic send is replaced by the server's echo, a streaming
  block by its permanent copy — and keying React off `id` remounted the node,
  tearing down the running animation. Messages now carry a stable UI key. This
  also stops the remount from discarding local component state at the end of
  every turn, so a tool card you expanded no longer collapses itself.

## [0.25.0] — 2026-08-04

### Added

- **Requirements: acceptance criteria the server checks, not the agent.** A
  session now carries a one-line Target plus a list of requirements, each one a
  shell command or a visual check against a screenshot. The agent declares
  them; you approve them; the bridge runs them and writes the result. Every row
  is HMAC-signed and hash-chained, so an agent that edits the database to claim
  a pass is flagged as tampered instead of believed. Visual checks are graded by
  a separate one-shot judge with no tools and none of the working session's
  context.
- **Loop mode.** Once requirements are approved, the loop re-prompts the agent
  after every turn until they all pass. It stops on its own budgets — 25
  iterations, $10, one hour by default — and pauses instead of spinning when the
  same set keeps failing with nothing changed on disk. A non-dismissible banner
  above the composer shows the phase, iteration and progress, with pause,
  resume and stop.
- **Automations: agent runs on a cron schedule.** Named automations carry their
  own prompt, working directory, provider, model, permission mode and effort,
  fire on a cron expression in the timezone you pick, and record every run —
  status, duration, cost, tokens, result — in a new SQLite store. Runs can be
  triggered by hand, cancelled mid-flight, and overlapping fires are skipped
  rather than stacked. Exposed over the bridge API.
- **Nested tab groups.** Groups now nest without a depth limit, and every
  per-project setting — env vars, portless actions, requirements config —
  resolves by walking from the session's group up to the root. A session inside
  `utilityprofit › Backend › Migraciones` still inherits the repo-level env.
- **Automatic worktree grouping.** When two or more sessions under the same
  parent share a working directory, a worktree group materialises around them
  and evaporates when they drop below two. These groups are derived, never
  persisted, so project settings keep resolving to the real group. You can drag
  a session out to opt it back into the flat list, and a switch in project
  settings turns the whole derivation off.
- **Drag a file from the explorer into the chat.** Dropping a file on the
  composer inserts a project-relative `@mention` instead of an absolute path.
- **Session deep-link chips.** When the agent references another session, the
  message renders a clickable chip showing that session's live name — renames
  are reflected automatically — instead of a raw UUID.
- **Reasoning-effort picker in the composer.** Pick low through max per message
  on the models that support it, or leave it on the provider default.
- **Native right-click menu on desktop.** Electron ships no default context
  menu; links now offer Copy Link and selections and inputs get the standard
  clipboard actions.
- **Session management over MCP.** Agents can archive, unarchive, update and
  delete sessions through four new `ui_*` tools.

### Changed

- **OpenCode sessions gained plan mode and inline questions.** OpenCode's
  `question` tool is mapped onto Codiby's AskUserQuestion, so it renders as the
  inline answer form rather than a generic tool card, with duplicate
  `question.asked` / `question.v2.asked` events collapsed into one prompt. MCP
  servers are bound per session through the server URL, working around
  OpenCode's dropped custom headers.
- **Action env vars stay in Actions.** Portless exports are injected only into
  processes launched as Actions. Ordinary terminals — the dock's "+", mobile,
  `/terminal`, restored terminals, the agent's `spawn_terminal` — get a plain
  shell again, instead of silently overriding whatever your own `.env` and rc
  files set.
- **Declaring requirements no longer prompts.** `set_target`,
  `add_requirements`, `edit_requirement` and `attach_requirement_image` are
  allowlisted, since a requirement only becomes binding once you approve it.
  `run_requirements` still goes through the normal permission flow — it
  executes shell commands. Invoking the plan tool no longer asks twice either;
  the approval that counts is the one carrying the plan markdown.

### Fixed

- **Terminals no longer open with a mangled line discipline.** `script` copied
  the outer PTY's raw settings onto the shell's controlling terminal; the shell
  now starts behind an `stty sane`.
- **Fullscreen images on mobile stay above the browser preview.** The native
  preview ignores DOM z-index, so the image viewer now tells it to hide while
  the overlay is open.
- **Replacing the dist no longer strands the old sidecar.** macOS `pgrep`
  doesn't reliably match argv paths with spaces, so a running "Codiby Code.app"
  went unnoticed and its previous bun sidecar survived the swap.

## [0.24.0] — 2026-07-18

### Added

- **Light and dark themes.** A toggle in the workspace titlebar (next to the
  terminal icon) switches the whole UI — chat, panels, editors and mobile —
  between the classic dark look and a new light theme. The choice persists
  across sessions.
- **Rebindable keyboard shortcuts.** Every global command now lives in a
  central registry with a shortcuts editor window; overrides persist to
  `~/.codiby/keybindings.json` and the command palette shows the live chords.
- **Markdown-native composer.** The chat input renders fenced code blocks with
  syntax highlighting as you type, auto-detects the language of pasted code,
  and keeps fence/selection behavior predictable while editing.
- **Session Resources drawer.** A chip in the chat header opens a panel listing
  everything the session produced or received — screenshots, mockups, posted
  images — so you can reopen any of them without scrolling the transcript.
- **Compose and retry on closed remote sessions.** Messages written to a
  disconnected session are staged with a "sending" indicator, ship on their own
  once the session reconnects, and offer a Retry button if delivery times out.
- **Clear button for terminals.** The Terminals dock toolbar can now wipe the
  active terminal's scrollback in one click.
- **Syntax highlighting for `.env` files.** Dotenv content is tokenized in code
  blocks and the editor like any other language.

### Changed

- **Browser panel chrome redesigned.** The preview's two stacked bars are now a
  single toolbar: round back/forward/reload buttons, an omnibox-style address
  pill with a focus ring, and one slot that morphs between Inspect and
  Send-comments as you work.
- **Command palette polish.** ⌘K commands and ⌘P session switching are two
  modes of one palette — you can hop between them from inside it, entries carry
  section icons and key-cap hints, and an empty query shows recent sessions
  instead of a blank list.
- **Windowed transcripts.** The chat keeps a working window of the conversation
  in memory and pages older messages in on demand ("Show older messages"),
  so long-running sessions no longer grow the renderer's memory without bound.
- **Git operations off the event loop.** Status and branch queries run outside
  the bridge's request path, so heavy repos no longer stall the UI.
- **Bridge crash forensics.** The sidecar now persists its stderr and traps
  fatal signals into the app log, so crashes leave a post-mortem trail instead
  of vanishing.
- **Internal restructure.** The repo is now a bun-workspaces monorepo
  (`core` / `ui` / `desktop` / `mobile`), the provider runtimes are adapter
  classes, and ChatApp state lives in a Zustand store.

### Fixed

- **Interrupting the agent no longer strands its thoughts.** Stopping a turn
  mid-stream used to pin the thinking bubbles to the bottom of the chat,
  duplicate them after a follow-up message, and silently drop the half-spoken
  text. The streamed thinking and text are now committed in place — in stream
  order, ahead of any barged-in message — and survive reloads and re-subscribes
  exactly where they happened.
- **WebSocket connection leak on duplicated terminals.** Re-subscribing a
  session could orphan its previous socket, piling up dead connections in the
  bridge. The connection layer now reconciles by key and closes the stale one.
- **Native browser preview no longer covers overlays.** The preview is a native
  view that ignores DOM z-index; it now hides beneath every full-screen surface
  (new-session modal, shortcuts, skills, bypass prompt, worktree picker) instead
  of floating over them.

## [0.23.0] — 2026-06-10

### Added

- **Pick an existing worktree, not just create one.** The worktree panel in
  the group composer now opens on a list of the repo's existing worktrees —
  with the main checkout pinned at the top and marked as the default — so you
  can drop a session straight into one. A "Use existing / New worktree" toggle
  switches over to the familiar creation form when you do want a fresh branch.
- **Delete a worktree inline.** Hovering a worktree in that list reveals a
  trash button; it asks for a one-tap confirmation, then removes the worktree
  via git and updates the list in place. The main checkout can't be deleted.

### Changed

- **API docs now live on the bridge at `/docs`.** Swagger UI is served from the
  bridge itself, on the same port as the API (default 3111) at `/docs`, instead
  of a separate server on port 3112. The standalone docs server remains for dev
  use, and the spec's server URL still tracks the live bridge port.

### Fixed

- **Branch dropdowns no longer overflow the window.** The Source and Existing
  Branch autocompletes in the worktree form rendered their popover at the width
  of the longest branch name, stretching across the whole window; they now
  match the field's width and truncate long names.

## [0.22.0] — 2026-06-10

### Added

- **Syntax highlighting in code blocks.** Fenced code blocks in agent messages
  are now color-tokenized by language — TypeScript, Python, Bash, JSON, YAML,
  Go, Rust, SQL and more — with the language shown in the block's top-left
  corner. Untagged or unknown blocks fall back to plain, unhighlighted text.

### Changed

- **Clearer markdown heading hierarchy.** Headings in agent messages used to
  render at nearly identical sizes, making structure hard to see. They now step
  down through a distinct scale — an underlined top-level title down to small
  uppercase sub-headings — so longer replies are easier to scan.
- **Agents structure replies with headings.** The chat now tells the agent it
  is rendering in a full Markdown UI rather than a terminal, so multi-part
  answers come back organized with headers, lists and tables whenever the
  content warrants it, instead of flat prose.

## [0.21.3] — 2026-06-09

### Added

- **Copy button on code blocks.** Hovering an agent code block now reveals a
  Copy button in its top-right corner; clicking it copies the block's contents
  to the clipboard and briefly confirms with a "Copied" label.

## [0.21.2] — 2026-06-09

### Fixed

- **File context menu stays on screen.** Right-clicking a file or folder near
  the bottom or right edge of the window used to open the menu at the cursor
  with no collision handling, clipping its lower items (Rename, Delete…) off
  screen with no way to reach them. The menu now measures itself and shifts
  back into view — flipping upward when there's no room below.

## [0.21.1] — 2026-06-09

### Fixed

- **Text selection no longer vanishes in the chat.** Selecting message text
  used to be wiped within a fraction of a second — a background session's
  streaming update would re-render the whole chat and rebuild each message's
  HTML, recreating its text nodes and dropping the selection. Message rendering
  is now memoized, so an unchanged message never touches the DOM and your
  selection stays put.

## [0.21.0] — 2026-06-09

### Added

- **Claude Fable 5.** Anthropic's new Fable 5 model now appears in the model
  picker. The bundled agent SDK was bumped to the first release that lists
  `claude-fable-5`, so it can be selected per session like any other model.
- **Built-in API docs.** The bridge now ships a Swagger UI docs server (default
  port 3112) that publishes a live OpenAPI spec for its HTTP API. It boots
  automatically alongside the bridge, and `scripts/swagger-docs.sh` runs it
  standalone, detached from the app.
- **Message timestamps on hover.** Hovering a chat message reveals a
  clock-style time (`9:41`), with the full date and time in a tooltip.
- **Reopen a mockup from its bubble.** The "Open in preview" bar on a mockup
  message now reopens that mockup in the active session's preview pane.

### Changed

- **The bridge API routes through Hono.** Its HTTP routing moved from a
  hand-rolled `Bun.serve` handler to the Hono framework — same endpoints and
  behavior, with a cleaner foundation for the new API docs.

### Fixed

- **One bad request or render error no longer takes the app down.** The Electron
  main process and the bridge sidecar now log uncaught exceptions and rejected
  promises instead of crashing, and the desktop and mobile UIs are wrapped in an
  error boundary that shows a fallback instead of a blank screen.

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
