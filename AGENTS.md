# AGENTS.md

## Seeing your changes

The desktop UI (`/`), the mobile UI (`/m/`), and the bridge server are all served by a macOS launchd service (`com.codiby.code.server`) installed at `~/.codiby/`. That directory holds its own copy of the bundled `server.js` and `dist/`, so edits under `src/`, `server/`, `public/`, or `scripts/build.ts` are **not live until you redeploy**.

Do **not** run `./scripts/install.sh` unless the user explicitly asks for it.

If the user asks to redeploy the launchd service, run:

```sh
./scripts/install.sh
```

`install.sh` rebuilds both frontends (desktop + mobile), bundles `server.js`, copies everything into `~/.codiby/`, and restarts the LaunchAgent.

To remove the service entirely: `./scripts/uninstall.sh`.

## Rebuilding the macOS app (Tauri)

This is the primary way to build and install the app locally: run the Tauri production build, then run the detached replace script so `/Applications/Codiby Code.app` is updated and relaunched.

The Tauri-bundled `/Applications/Codiby Code.app` is a separate distribution path from the launchd service flow above — `install.sh` does **not** touch it. To rebuild and reinstall the desktop app locally:

```sh
bun run tauri build
```

If you're invoking the build from inside a running Codiby Code session, the embedded Bun sidecar inherits launchd's minimal `PATH` and won't find `cargo`. Prefix with the user `PATH` so Homebrew + the Rust toolchain resolve:

```sh
PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH" bun run tauri build
```

Output bundle: `src-tauri/target/release/bundle/macos/Codiby Code.app`. A signed-but-unstapled `.dmg` lands next to it under `bundle/dmg/`.

### Self-replacing while the app is running

You cannot `cp -R` over the running `.app` from inside its own Bun sidecar — quitting the app kills the script doing the copy mid-step. `scripts/replace-app.sh` runs detached (orphaned to PID 1) so it survives the death of the very app it kills. After a successful build, spawn it like this:

```sh
nohup bash scripts/replace-app.sh </dev/null >/tmp/codiby-replace-bootstrap.log 2>&1 & disown
```

What it does, in order:

1. Sends a Quit AppleEvent via `osascript`, waits up to 12 s for graceful exit.
2. Escalates to `SIGTERM`, then `SIGKILL`, if the app is still alive.
3. Reaps the embedded Bun sidecar (`Contents/Resources/server.js`) so no zombie holds port 3111.
4. `rm -rf /Applications/Codiby Code.app`, then `cp -R` the freshly built bundle in.
5. `xattr -cr` to clear quarantine flags so Gatekeeper doesn't grumble on first launch.
6. Re-launches via `open`.

Live progress at `/tmp/codiby-replace.log`. Any in-flight chat session in the old app dies when it exits — open a fresh tab in the new build.

### TL;DR — one-shot rebuild + reinstall

Use this as the principal app build command when the user asks to build and replace the app:

```sh
bun run build:replace
```

## Bumping the app version

The version is hard-coded in four files that must stay in sync: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, and the `codiby-code` entry in `src-tauri/Cargo.lock`. Use the bump script instead of editing them by hand:

```sh
bun run version:bump patch    # 0.0.1 -> 0.0.2
bun run version:bump minor    # 0.0.1 -> 0.1.0
bun run version:bump major    # 0.1.2 -> 1.0.0
bun run version:bump 1.2.3    # explicit x.y.z
```

The script reads the current version from `package.json`, computes the next one, and rewrites all four files in place. It only touches the `codiby-code` package entry in `Cargo.lock`, so unrelated dependency versions are left alone.
