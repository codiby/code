# Codiby Code

A native desktop and mobile UI for Claude Code. This repository contains the [Electron](https://www.electronjs.org/) app for macOS and Windows and the React Native app for iOS and Android. A mobile PWA is also served from the web bundle. The clients connect to a [Bun](https://bun.sh/) bridge server that drives the Claude Agent SDK, MCP tools, a PTY-backed terminal, and an optional Telegram bot.

## Features

- Native macOS and Windows builds (Electron) with transparent title bar
- Native iOS and Android app in `packages/mobile`, with automatic TestFlight uploads
- React + Tailwind + HeroUI frontend bundled directly with `Bun.build`
- Local Bun bridge server with MCP tools for session and tab-group management
- Built-in xterm.js terminal backed by `Bun.Terminal`
- Mobile PWA mode with ambient blob, shell, terminal, and archive flow
- Optional Telegram bot integration

## Roadmap

- **Codex backend** — alternative agent runtime alongside the Claude Agent SDK
- **Remote sessions** — SSH-tunneled bun bridges (see `CHANGELOG.md` for the v0.9.0 entry)

## Requirements

- [Bun](https://bun.sh/) >= 1.4.4 (see `.bun-version`; required for self-contained mobile dependencies)
- **macOS**: Xcode Command Line Tools (for code signing during electron-builder)
- **iOS**: full Xcode and Ruby/CocoaPods; see [mobile setup](packages/mobile/README.md)
- **Android**: Android Studio, Android SDK and JDK 17

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

For React Native, start Metro with `bun run mobile:start`, then run
`bun run mobile:ios` or `bun run mobile:android` in another terminal.
See [mobile setup](packages/mobile/README.md) and [TestFlight CI](docs/testflight.md).

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
├── packages/
│   ├── core/               # Bun bridge, agent runtimes and MCP tools
│   ├── ui/                 # React web frontend (desktop + mobile PWA)
│   ├── desktop/            # Electron main, preload, icons and bundle resources
│   └── mobile/             # React Native app, ios/, android/, Jest and Fastlane
├── scripts/                # Frontend build, install and Electron bundle helpers
├── .github/workflows/      # Desktop release + iOS TestFlight
├── bun.lock                # Shared dependency lockfile for all workspaces
└── package.json
```

`packages/mobile` is a Bun workspace with self-contained dependencies. A single
`bun install` at the root installs all apps while keeping React Native's React
and Tailwind versions inside `packages/mobile/node_modules`.

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
| `bun run mobile:start`        | Start React Native Metro                            |
| `bun run mobile:ios`          | Build and run the iOS app                            |
| `bun run mobile:android`      | Build and run the Android app                        |
| `bun run mobile:test --runInBand` | Run the React Native Jest suite                  |
| `bun run mobile:pods`         | Install locked iOS pods after Bundler setup          |
| `bun run mobile:testflight`   | Archive and upload iOS using Apple signing secrets   |

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
