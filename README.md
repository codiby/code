# Codiby Code

A native desktop and mobile UI for Claude Code. The desktop app ships as an [Electron](https://www.electronjs.org/) build for macOS and Windows; the mobile experience is a PWA served from the same bundle. Both talk to a local [Bun](https://bun.sh/) bridge server that drives the Claude Agent SDK, MCP tools, a PTY-backed terminal, and an optional Telegram bot.

## Features

- Native macOS and Windows builds (Electron) with transparent title bar
- React + Tailwind + HeroUI frontend bundled directly with `Bun.build`
- Local Bun bridge server with MCP tools for session and tab-group management
- Built-in xterm.js terminal backed by `Bun.Terminal`
- Mobile PWA mode with ambient blob, shell, terminal, and archive flow
- Optional Telegram bot integration

## Roadmap

- **Codex backend** — alternative agent runtime alongside the Claude Agent SDK
- **Remote sessions** — SSH-tunneled bun bridges (see `CHANGELOG.md` for the v0.9.0 entry)

## Requirements

- [Bun](https://bun.sh/) >= 1.3.5 (required for `Bun.Terminal` PTY support)
- **macOS**: Xcode Command Line Tools (for code signing during electron-builder)

## Getting Started

Install dependencies:

```sh
bun install
```

Watch and rebuild the frontend bundle (`./dist/`) on change:

```sh
bun run dev
```

Run the full Electron desktop app in dev mode:

```sh
bun run electron:dev
```

## Headless Deployment (Linux)

There is no Linux desktop package. On a server you run the bridge directly and
reach the UI over the network — the desktop app at `/`, the phone build at `/m/`.

[`process-compose.yaml`](./process-compose.yaml) is the entrypoint: it installs
dependencies, builds both frontends once, then serves, gating the bridge on
`dist/index.html` so the first request can't race an empty `dist/`.

```sh
process-compose up              # with TUI
process-compose up -t=false     # detached — systemd, CI, `ssh host ...`
```

To keep it running across reboots, install the bundled systemd **user** unit:

```sh
mkdir -p ~/.config/systemd/user
cp codiby-code.service ~/.config/systemd/user/
# edit WorkingDirectory if the repo is not at ~/codiby/code
systemctl --user daemon-reload
systemctl --user enable --now codiby-code.service
sudo loginctl enable-linger "$USER"   # otherwise it dies at logout
```

It has to be a user unit, not a system one: the bridge reads `~/.claude`, spawns
`claude` as you, and drives git worktrees under `$HOME`.

Deploying a new revision means restarting the unit, not just rebuilding `dist/`
— route handling and the static allowlist live inside the bridge process:

```sh
git pull && systemctl --user restart codiby-code.service
```

`bun` and `claude` must be on the unit's `PATH`, which systemd does **not**
inherit from your shell profile; the unit sets it explicitly.

## Project Structure

```text
/
├── public/                 # Static assets (favicon, manifest, service worker)
├── scripts/                # Frontend build driver + install / bundle helpers
├── server/                 # Bun bridge server (Claude Agent SDK, MCP, PTY)
├── src/                    # React frontend (desktop + mobile entries)
├── electron/               # Electron main + preload + browser-preview / CDP
│   ├── build/              # Icons, entitlements, notarize hook
│   └── resources/          # Bundled bun + server.js (generated)
└── package.json
```

## Scripts

| Command                       | Action                                               |
| :---------------------------- | :--------------------------------------------------- |
| `bun install`                 | Install dependencies                                 |
| `bun run dev`                 | Watch and rebuild the frontend bundle into `./dist/` |
| `bun run build-server`        | One-shot production build of the frontend            |
| `bun run bridge`              | Run the Bun bridge server directly                   |
| `bun run electron:dev`        | Run the Electron desktop app in dev mode             |
| `bun run electron:build`      | Build the desktop installer (mac DMG + win NSIS)     |
| `bun run electron:build:replace` | Build and atomically swap `/Applications/Codiby Code.app` |

## macOS: "Codiby Code is damaged and can't be opened"

Builds from GitHub Releases are not yet signed with an Apple Developer ID, so macOS Gatekeeper quarantines the download and shows a misleading "damaged" message. The app is fine — clear the quarantine attribute once after moving it to `/Applications`:

```sh
xattr -cr "/Applications/Codiby Code.app"
```

If that isn't enough on newer macOS versions:

```sh
sudo xattr -rd com.apple.quarantine "/Applications/Codiby Code.app"
```

Then open the app normally.

## Building Installers Locally

### macOS (`.dmg`)

```sh
bun install
bun run electron:build:mac
# → electron-out/Codiby Code-<version>-arm64.dmg
```

### Windows (`.exe`)

```sh
bun install
bun run electron:build:win
# → electron-out/Codiby Code Setup <version>.exe
```

## License

Copyright (c) 2026 Codiby

Licensed under the [PolyForm Noncommercial License 1.0.0](./LICENSE). You may use, modify, and share the software for any noncommercial purpose. Commercial use requires a separate license — contact the maintainers.
