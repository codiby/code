# Codiby Code

A native desktop and mobile UI for Claude Code. The desktop app ships as a [Tauri 2](https://tauri.app/) build for macOS; the mobile experience is a PWA served from the same bundle. Both talk to a local [Bun](https://bun.sh/) bridge server that drives the Claude Agent SDK, MCP tools, a PTY-backed terminal, and an optional Telegram bot.

## Features

- Native macOS build (Tauri 2) with transparent title bar
- React + Tailwind + HeroUI frontend bundled directly with `Bun.build`
- Local Bun bridge server with MCP tools for session and tab-group management
- Built-in xterm.js terminal backed by `Bun.Terminal`
- Mobile PWA mode with ambient blob, shell, terminal, and archive flow
- Optional Telegram bot integration

## Roadmap

- **Codex backend** — alternative agent runtime alongside the Claude Agent SDK
- **Windows support** — coming soon

## Requirements

- [Bun](https://bun.sh/) >= 1.3.5 (required for `Bun.Terminal` PTY support)
- [Rust](https://www.rust-lang.org/tools/install) stable toolchain (for `tauri build`)
- **macOS**: Xcode Command Line Tools

## Getting Started

Install dependencies:

```sh
bun install
```

Watch and rebuild the frontend bundle (`./dist/`) on change:

```sh
bun run dev
```

Run the full Tauri desktop app in dev mode:

```sh
bun run tauri:dev
```

## Project Structure

```text
/
├── public/                 # Static assets (favicon, manifest, service worker)
├── scripts/                # Frontend build driver + install / bundle helpers
├── server/                 # Bun bridge server (Claude Agent SDK, MCP, PTY)
├── src/                    # React frontend (desktop + mobile entries)
├── src-tauri/              # Tauri (Rust) shell
│   ├── src/                # lib.rs / main.rs
│   ├── icons/              # App icons
│   ├── sidecar/            # Bundled Bun runtime + server.js (generated)
│   └── tauri.conf.json
└── package.json
```

## Scripts

| Command              | Action                                               |
| :------------------- | :--------------------------------------------------- |
| `bun install`        | Install dependencies                                 |
| `bun run dev`        | Watch and rebuild the frontend bundle into `./dist/` |
| `bun run build-server` | One-shot production build of the frontend          |
| `bun run bridge`     | Run the Bun bridge server directly                   |
| `bun run tauri:dev`  | Run the Tauri desktop app in dev mode                |
| `bun run tauri`      | Invoke the Tauri CLI directly (e.g. `tauri build`)   |

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
bun run tauri build --bundles dmg
# → src-tauri/target/release/bundle/dmg/Codiby Code_<version>_aarch64.dmg
```

## License

Copyright (c) 2026 Codiby

Licensed under the [PolyForm Noncommercial License 1.0.0](./LICENSE). You may use, modify, and share the software for any noncommercial purpose. Commercial use requires a separate license — contact the maintainers.
