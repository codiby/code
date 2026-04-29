# AGENTS.md

## Seeing your changes

The desktop UI (`/`), the mobile UI (`/m/`), and the bridge server are all served by a macOS launchd service (`com.codiby.code.server`) installed at `~/.codiby/`. That directory holds its own copy of the bundled `server.js` and `dist/`, so edits under `src/`, `server/`, `public/`, or `scripts/build.ts` are **not live until you redeploy**.

After any change to the frontend or the server, run:

```sh
./scripts/install.sh
```

`install.sh` rebuilds both frontends (desktop + mobile), bundles `server.js`, copies everything into `~/.codiby/`, and restarts the LaunchAgent. Safe to re-run at any time.

To remove the service entirely: `./scripts/uninstall.sh`.

## Bumping the app version

The version is hard-coded in four files that must stay in sync: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, and the `codiby-code` entry in `src-tauri/Cargo.lock`. Use the bump script instead of editing them by hand:

```sh
bun run version:bump patch    # 0.0.1 -> 0.0.2
bun run version:bump minor    # 0.0.1 -> 0.1.0
bun run version:bump major    # 0.1.2 -> 1.0.0
bun run version:bump 1.2.3    # explicit x.y.z
```

The script reads the current version from `package.json`, computes the next one, and rewrites all four files in place. It only touches the `codiby-code` package entry in `Cargo.lock`, so unrelated dependency versions are left alone.
