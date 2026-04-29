#!/bin/bash
# Rebuild the frontend and refresh only the dist/ files served by the running
# Codiby Code bridge service. Does NOT touch server.js, the pinned bun binary,
# or the LaunchAgent plist — use scripts/install.sh for those.
#
#   ./scripts/update-dist.sh           one-shot rebuild + atomic swap
#   ./scripts/update-dist.sh --watch   symlink ~/.codiby/dist -> $PROJECT/dist
#                                      and run build.ts --watch until Ctrl-C
#
# The server reads dist/ from disk per request, so no service reload is needed;
# reload the browser to pick up the new bundle.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

SERVICE_DIR="$HOME/.codiby"

WATCH=0
for arg in "$@"; do
    case "$arg" in
        --watch) WATCH=1 ;;
        *) echo "Unknown argument: $arg" >&2; exit 1 ;;
    esac
done

BUN_PATH="$(command -v bun || echo "$HOME/.bun/bin/bun")"
if [ ! -x "$BUN_PATH" ]; then
    echo "Error: bun not found. Install with:" >&2
    echo "  curl -fsSL https://bun.sh/install | bash" >&2
    exit 1
fi

if [ ! -d "$SERVICE_DIR" ]; then
    echo "Error: $SERVICE_DIR not found. Run scripts/install.sh first." >&2
    exit 1
fi

if [ "$WATCH" -eq 1 ]; then
    echo "=== Watching Codiby Code frontend ==="
    # Point the served dist at the project tree so build.ts --watch hot-updates
    # what the server reads from disk per request. On exit we restore a real
    # copy so the service keeps working after the watcher stops.
    if [ -L "$SERVICE_DIR/dist" ]; then
        rm -f "$SERVICE_DIR/dist"
    elif [ -d "$SERVICE_DIR/dist" ]; then
        rm -rf "$SERVICE_DIR/dist"
    fi
    ln -s "$PROJECT_DIR/dist" "$SERVICE_DIR/dist"
    echo "-- Symlinked $SERVICE_DIR/dist -> $PROJECT_DIR/dist"

    cleanup() {
        echo
        echo "-- Restoring real dist/ at $SERVICE_DIR/dist"
        rm -f "$SERVICE_DIR/dist"
        if [ -d "$PROJECT_DIR/dist" ]; then
            cp -R "$PROJECT_DIR/dist" "$SERVICE_DIR/dist"
        fi
    }
    trap cleanup EXIT INT TERM

    echo "-- Running build.ts --watch (Ctrl-C to stop)"
    cd "$PROJECT_DIR"
    "$BUN_PATH" run scripts/build.ts --watch
    exit 0
fi

echo "=== Updating Codiby Code frontend ==="

echo "-- Building frontend"
( cd "$PROJECT_DIR" && "$BUN_PATH" run scripts/build.ts ) >/dev/null

# Swap dist/ via a staging dir so the live server never sees a half-copied tree.
echo "-- Swapping dist/"
STAGE_DIR="$SERVICE_DIR/dist.new"
OLD_DIR="$SERVICE_DIR/dist.old"
rm -rf "$STAGE_DIR" "$OLD_DIR"
cp -R "$PROJECT_DIR/dist" "$STAGE_DIR"
if [ -L "$SERVICE_DIR/dist" ]; then
    rm -f "$SERVICE_DIR/dist"
elif [ -d "$SERVICE_DIR/dist" ]; then
    mv "$SERVICE_DIR/dist" "$OLD_DIR"
fi
mv "$STAGE_DIR" "$SERVICE_DIR/dist"
rm -rf "$OLD_DIR"

echo
echo "=== done ==="
echo "  Dist dir:  $SERVICE_DIR/dist"
echo "  Reload your browser to pick up the new bundle."
