#!/usr/bin/env bash
# Builds the installer for Windows from WSL/Linux (nothing gets installed on
# Windows) and copies the .exe over to Windows. Same setup as Flow.
#
# Requirements (inside WSL): rustup with the x86_64-pc-windows-msvc target
# and cargo-xwin:
#   rustup target add x86_64-pc-windows-msvc
#   cargo install --locked cargo-xwin
#
# Usage: ./build.sh [destination-folder-on-windows]
set -euo pipefail
. "$HOME/.cargo/env" 2>/dev/null || true
cd "$(dirname "$0")"

cargo xwin build --release --target x86_64-pc-windows-msvc 2>&1 \
  | grep -vE '^\s+(Compiling|Downloading|Downloaded)'

WIN_USER="$(cmd.exe /c 'echo %USERNAME%' 2>/dev/null | tr -d '\r')"
DEST="${1:-/mnt/c/Users/$WIN_USER/CodibyInstaller}"
mkdir -p "$DEST"
cp target/x86_64-pc-windows-msvc/release/codiby-installer.exe "$DEST/codiby-installer.exe"
echo "Done: $DEST/codiby-installer.exe"
