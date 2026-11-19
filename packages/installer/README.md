# @codiby/installer

Codiby Code's installer for Windows, built with [NSH](https://nsh.dev) in Rust. It installs or updates the app and asks which host is the **base**, the one that runs Codiby's server:

- **Windows**: the server runs on Windows. WSL distros can be added as remotes (Settings → Remotes).
- **WSL**: the server runs inside a distro and the Windows app is only its window. SSH remotes work there; on Windows they don't, because Windows OpenSSH has no ControlMaster.

It checks the machine silently and only shows what applies: it installs WSL when it is missing (administrator prompt, one restart, then it reopens by itself), installs Ubuntu 24.04 or Debian when there is no distro, creates the Linux user, and offers Windows only when virtualization is off.

The UI is in Spanish and English (`locales/app.yml`). It follows the system language, and the first screen switches it.

## How the WSL base works

The app reads `CODIBY_BRIDGE_PORT_OVERRIDE`: when a Codiby server already answers `/health` on that port, the app uses it instead of starting its own. The installer:

1. Copies the app's `resources\server.js` to `~/.codiby/wsl-bridge/` in the distro and writes the same `start.sh` that Settings → Remotes → Install WSL writes (`assets/bridge-install.sh`).
2. Sets `CODIBY_BRIDGE_PORT_OVERRIDE` (3112 by default) for the user.
3. Adds `%LOCALAPPDATA%\codiby-base\bridge.ps1` (`assets/bridge.ps1`) to `HKCU\…\Run` and a **Codiby Code (WSL)** Start menu shortcut. The script keeps a hidden `wsl.exe` alive so WSL doesn't shut the distro down, and copies `server.js` again after the app updates.

Choosing Windows later undoes all three. With the Windows base, each chosen distro is added to `~/.codiby/ui-remotes.json` with its own port, because every WSL 2 distro shares one network.

## Develop

You need the `nsh` CLI and Rust. Install `nsh` on Windows with `irm https://nsh.dev/install.ps1 | iex`, or on macOS and Linux with `curl -fsSL https://nsh.dev/install.sh | sh`.

```sh
cargo test                                  # the plan's logic and the flows (headless, both languages)
CODIBY_INSTALLER_SIM=nowsl nsh run          # the screens on a pretend machine, on any desktop
nsh package --target windows                # .nsh/out/Codiby Installer/… (Windows only)
```

`CODIBY_INSTALLER_SIM` takes `ok`, `nodistro`, `nowsl`, `novirt` or `fail`. `CODIBY_INSTALLER_SIM_MS` sets how long each pretend step takes. Without the variable, on Windows, the work is real.

A Rust NSH app only builds for Windows on Windows. CI builds it on `windows-latest` (`.github/workflows/installer.yml`).

## Layout

| Path | What |
|---|---|
| `src/lib.rs` | The root: the current screen centered, the stage dots |
| `src/screens.rs` | One function per screen |
| `src/store.rs` | The wizard's state, its navigation and the `Plan` |
| `src/ui.rs` | Buttons, options, notes, the progress bar |
| `src/system/` | `mod.rs` the plan and its steps, `windows.rs` the real work, `sim.rs` the pretend machine |
| `assets/` | The scripts it installs |
| `locales/app.yml` | Spanish and English |
| `tests/flows.rs` | The user's flows, headless |

Bun only runs this package's scripts (`bun run --cwd packages/installer check`). Cargo builds it, in a workspace of its own.
