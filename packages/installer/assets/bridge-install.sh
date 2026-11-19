#!/bin/sh
# Installs Codiby's server ("bridge") in this distro, as the user it runs as.
# Writes the same start.sh as Settings -> Remotes -> Install WSL, so the
# Windows app can use the distro as a remote too.
#   $1  Windows path of the app's resources\server.js
#   $2  port the server listens on (127.0.0.1)
# curl and unzip come first, as root (the installer runs that part).
set -eu
SRC_WIN="$1"
PORT="$2"
DIR="$HOME/.codiby/wsl-bridge"

BUN="$HOME/.bun/bin/bun"
if [ ! -x "$BUN" ]; then
  echo "Installing Bun"
  curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1
fi
[ -x "$BUN" ] || { echo "Bun not found at $BUN"; exit 1; }

if [ ! -x "$HOME/.local/bin/claude" ] && ! command -v claude >/dev/null 2>&1; then
  echo "Installing Claude Code"
  curl -fsSL https://claude.ai/install.sh | bash >/dev/null 2>&1
fi

mkdir -p "$DIR"
if [ -f "$DIR/bridge.pid" ]; then
  pid="$(cat "$DIR/bridge.pid")"
  if grep -q server.js "/proc/$pid/cmdline" 2>/dev/null; then
    echo "Stopping the previous server"
    kill "$pid" 2>/dev/null || true
    i=0
    while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 50 ]; do sleep 0.2; i=$((i + 1)); done
  fi
  rm -f "$DIR/bridge.pid"
fi
cp "$(wslpath -u "$SRC_WIN")" "$DIR/server.js.tmp"
mv "$DIR/server.js.tmp" "$DIR/server.js"

cat > "$DIR/start.sh" <<EOF
#!/bin/sh
# Run by Codiby on Windows each time it connects to this distro. Starts the
# bridge unless it is already running; safe to call any number of times.
DIR="\$HOME/.codiby/wsl-bridge"
PID_FILE="\$DIR/bridge.pid"
# The cmdline check guards against a PID reused after the WSL VM restarted.
if [ -f "\$PID_FILE" ] && grep -q server.js "/proc/\$(cat "\$PID_FILE")/cmdline" 2>/dev/null; then exit 0; fi
cd "\$HOME"
SHELL="\${SHELL:-/bin/bash}" CLAUDE_UI_PORT=$PORT CLAUDE_UI_HOST=127.0.0.1 CODIBY_CODE_PORT_FILE="\$DIR/server.port" \\
  setsid nohup "\$HOME/.bun/bin/bun" "\$DIR/server.js" --spawned-by=service >>"\$DIR/bridge.log" 2>&1 </dev/null &
echo \$! > "\$PID_FILE"
EOF
chmod +x "$DIR/start.sh"
echo "Server copied to $DIR"
exit 0
