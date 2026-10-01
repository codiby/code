/**
 * WSL distros as remotes (Windows only).
 *
 * A WSL remote runs the same bun bridge as an SSH remote, but inside a distro
 * on this PC. There is no SSH: WSL forwards the distro's localhost listeners
 * to Windows' localhost, so the bridge port is reachable directly. What stands
 * in for the SSH master is a long-lived `wsl.exe` process that runs the
 * distro's `start.sh` (launches the bridge if it isn't running) and then
 * sleeps — WSL shuts an idle distro down once no `wsl.exe` client is attached,
 * background services included, so something has to hold it open while panes
 * are using it.
 *
 * Install copies this app's own bundled `server.js` into the distro: no git
 * checkout and no build there, and the bridge always matches the app that
 * installed it. Reinstalling is how a WSL remote gets updated.
 */

import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';

export const WSL_DEFAULT_PORT = 3112;

/** Inside the distro, relative to $HOME. */
const BRIDGE_DIR = '.codiby/wsl-bridge';

export const isWslSupported = () => process.platform === 'win32';

/** WSL distro names: letters, digits, dot, dash, underscore. */
export function isValidDistroName(name: unknown): name is string {
  return typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name);
}

/** The process that keeps the distro and its bridge alive while the remote is in use. */
export function wslKeepaliveCommand(distro: string): { command: string; args: string[] } {
  return {
    command: 'wsl.exe',
    args: ['-d', distro, '--exec', 'sh', '-c', `$HOME/${BRIDGE_DIR}/start.sh && exec sleep infinity`],
  };
}

/** Turn the keepalive's stderr into something the remotes UI can show. */
export function classifyWslError(stderr: string, distro: string): string {
  const s = stderr.replace(/\0/g, '').toLowerCase();
  if (s.includes('no distribution') || s.includes('wsl_e_distro_not_found')) return `WSL distro "${distro}" not found.`;
  if (s.includes('start.sh') && (s.includes('not found') || s.includes('no such file'))) {
    return `Codiby isn't installed in ${distro} — use Install WSL in Settings → Remotes.`;
  }
  return stderr.replace(/\0/g, '').split('\n').find(l => l.trim()) || 'wsl.exe exited.';
}

/** wsl.exe prints UTF-16LE unless WSL_UTF8=1 is honored (newer builds); accept both. */
function decodeWslOutput(buf: Buffer): string {
  const nulls = buf.filter(b => b === 0).length;
  return (nulls > buf.length / 4 ? buf.toString('utf16le') : buf.toString('utf8')).replace(/^﻿/, '');
}

function run(command: string, args: string[], opts: { stdin?: string; timeoutMs?: number } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, WSL_UTF8: '1' }, windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    proc.stdout.on('data', d => out.push(d));
    proc.stderr.on('data', d => err.push(d));
    const timer = setTimeout(() => { try { proc.kill(); } catch {} }, opts.timeoutMs ?? 30_000);
    proc.on('error', e => { clearTimeout(timer); reject(e); });
    proc.on('close', code => {
      clearTimeout(timer);
      resolve({ code, stdout: decodeWslOutput(Buffer.concat(out)), stderr: decodeWslOutput(Buffer.concat(err)) });
    });
    proc.stdin.end(opts.stdin ?? '');
  });
}

/** Installed distros, minus Docker Desktop's internal ones. */
export async function listWslDistros(): Promise<string[]> {
  if (!isWslSupported()) return [];
  const { code, stdout, stderr } = await run('wsl.exe', ['--list', '--quiet']);
  if (code !== 0) throw new Error(stderr.trim() || stdout.trim() || `wsl.exe --list failed (code ${code})`);
  return stdout.split(/\r?\n/).map(l => l.trim())
    .filter(name => name && isValidDistroName(name) && !name.startsWith('docker-desktop'));
}

/**
 * The bundled bridge to copy into the distro. A packaged app runs from its
 * `server.js` already; from source, bundle the entrypoint the same way
 * `electron-bundle-resources.sh` does.
 */
async function bridgeBundlePath(): Promise<string> {
  if (Bun.main.endsWith('.js')) return Bun.main;
  const outdir = join(tmpdir(), 'codiby-wsl-bridge');
  const result = await Bun.build({ entrypoints: [Bun.main], outdir, target: 'bun', minify: true, naming: 'server.js' });
  if (!result.success) throw new Error(`Could not bundle the bridge: ${result.logs.map(l => l.message).join('; ')}`);
  return join(outdir, 'server.js');
}

/**
 * POSIX sh, fed to `sh -s` on stdin. Arguments: Windows path of server.js, port.
 * Progress goes to stdout as `STEP:<text>`; a fatal problem as `ERROR:<text>`.
 */
export const INSTALL_SCRIPT = String.raw`
set -eu
SRC_WIN="$1"
PORT="$2"
DIR="$HOME/${BRIDGE_DIR}"
step() { printf 'STEP:%s\n' "$1"; }
fail() { printf 'ERROR:%s\n' "$1"; exit 1; }

step "Checking curl and unzip"
missing=""
for tool in curl unzip; do command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"; done
[ -z "$missing" ] || fail "Missing:$missing. Install them inside the distro, e.g. sudo apt install -y$missing"

BUN="$HOME/.bun/bin/bun"
if [ ! -x "$BUN" ]; then
  step "Installing Bun"
  curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 || fail "Bun install failed"
fi
[ -x "$BUN" ] || fail "Bun not found at $BUN after install"

if [ ! -x "$HOME/.local/bin/claude" ] && ! command -v claude >/dev/null 2>&1; then
  step "Installing Claude Code"
  curl -fsSL https://claude.ai/install.sh | bash >/dev/null 2>&1 || fail "Claude Code install failed"
  [ -x "$HOME/.local/bin/claude" ] || fail "Claude Code not found at ~/.local/bin/claude after install"
fi

step "Copying bridge"
mkdir -p "$DIR"
if [ -f "$DIR/bridge.pid" ]; then
  pid="$(cat "$DIR/bridge.pid")"
  if grep -q server.js "/proc/$pid/cmdline" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    i=0
    while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 50 ]; do sleep 0.2; i=$((i + 1)); done
  fi
  rm -f "$DIR/bridge.pid"
fi
SRC="$(wslpath -u "$SRC_WIN")"
cp "$SRC" "$DIR/server.js.tmp"
mv "$DIR/server.js.tmp" "$DIR/server.js"

cat > "$DIR/start.sh" <<EOF
#!/bin/sh
# Run by Codiby on Windows each time it connects to this distro. Starts the
# bridge unless it is already running; safe to call any number of times.
DIR="\$HOME/${BRIDGE_DIR}"
PID_FILE="\$DIR/bridge.pid"
# The cmdline check guards against a PID reused after the WSL VM restarted.
if [ -f "\$PID_FILE" ] && grep -q server.js "/proc/\$(cat "\$PID_FILE")/cmdline" 2>/dev/null; then exit 0; fi
cd "\$HOME"
SHELL="\${SHELL:-/bin/bash}" CLAUDE_UI_PORT=$PORT CLAUDE_UI_HOST=127.0.0.1 CODIBY_CODE_PORT_FILE="\$DIR/server.port" \\
  setsid nohup "\$HOME/.bun/bin/bun" "\$DIR/server.js" --spawned-by=service >>"\$DIR/bridge.log" 2>&1 </dev/null &
echo \$! > "\$PID_FILE"
EOF
chmod +x "$DIR/start.sh"
step "Installed"
`;

export type WslInstallResult = { steps: string[] };

/** Install (or reinstall) the bridge into `distro`, stopping any bridge already running there. */
export async function installWslBridge(distro: string, port: number): Promise<WslInstallResult> {
  if (!isWslSupported()) throw new Error('WSL remotes are only available on Windows');
  if (!isValidDistroName(distro)) throw new Error('Invalid WSL distro name');
  const source = await bridgeBundlePath();
  const { code, stdout, stderr } = await run(
    'wsl.exe', ['-d', distro, '--exec', 'sh', '-s', '--', source, String(port)],
    { stdin: INSTALL_SCRIPT, timeoutMs: 10 * 60_000 },
  );
  const lines = stdout.split(/\r?\n/);
  const steps = lines.filter(l => l.startsWith('STEP:')).map(l => l.slice(5));
  const error = lines.find(l => l.startsWith('ERROR:'))?.slice(6);
  if (code !== 0) throw new Error(error || classifyWslError(stderr, distro) || `Install failed (code ${code})`);
  return { steps };
}
