import { homedir, networkInterfaces } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { randomBytes } from 'crypto';
import { execSync } from 'child_process';

// Enrich `process.env.PATH` so anything we spawn downstream — the Claude SDK's
// `claude` binary, the Bash tool's child processes, `git`, `sudo`, `bun`, etc.
// — can resolve user-installed binaries. When the bridge is launched from the
// Tauri app (Finder/Dock) it inherits launchd's minimal PATH
// (`/usr/bin:/bin:/usr/sbin:/sbin`); user paths from `/opt/homebrew/bin`,
// `~/.local/bin`, `~/.cargo/bin`, etc. are missing. The PTY shell handles its
// own login-mode profile load (see `pty.ts`), but Bun.spawn / Node spawn
// invocations from the bridge inherit `process.env.PATH` directly — so we
// enrich it here once at module load.
//
// Skipped when PATH already looks rich (running outside Tauri, e.g. `bun run`
// from a real terminal) so we don't pay the shell-spawn cost unnecessarily.
(function enrichPathFromUserShell() {
  const cur = process.env.PATH || '';
  if (/\/opt\/homebrew\/bin|\.local\/bin|\.cargo\/bin|\.bun\/bin/.test(cur)) return;
  const shell = process.env.SHELL || '/bin/zsh';
  try {
    const out = execSync(`${shell} -lic 'printf "<<<PATH>>>%s<<</PATH>>>" "$PATH"'`, {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = out.match(/<<<PATH>>>([^<]*)<<<\/PATH>>>/);
    if (m && m[1] && m[1].length > cur.length) {
      process.env.PATH = m[1];
    }
  } catch {}
})();

export const PORT = parseInt(process.env.CLAUDE_UI_PORT || '3111', 10);
/**
 * Hostname to bind on. Defaults to 0.0.0.0 so phones on the same WiFi can
 * reach the bridge server. Set CLAUDE_UI_HOST=127.0.0.1 to lock back down to
 * localhost only.
 */
export const HOST = process.env.CLAUDE_UI_HOST || '0.0.0.0';
// Resolve claude binary — check common locations if not in PATH
const findClaude = (): string => {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const home = process.env.HOME || '';
  const candidates = [
    `${home}/.local/bin/claude`,
    `${home}/.claude/bin/claude`,
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
  for (const p of candidates) {
    try { if (require('fs').existsSync(p)) return p; } catch {}
  }
  return 'claude';
};
export const CLAUDE_BIN = findClaude();
export const CWD = process.env.CLAUDE_CWD || process.cwd();
export const SESSIONS_FILE = join(homedir(), '.claude', 'ui-sessions.json');

export const ACCEPT_EDITS_TOOLS = new Set(['Edit', 'Write', 'Read', 'Glob', 'Grep', 'NotebookEdit']);
export const PLAN_READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep']);
export const PLAN_DENY_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'Bash']);

/**
 * In-process SDK MCP tools that are always auto-approved regardless of
 * permission mode. These are safe, UI-only operations (no filesystem or
 * network side effects) that the model should be able to trigger freely.
 */
export const ALWAYS_AUTO_APPROVE_TOOLS = new Set([
  'mcp__codiby-code-sdk__rename_session',
]);

export const MAIN_SESSION_ID = 'main-session';
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
export const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ---------------------------------------------------------------------------
// Mobile pairing token
// ---------------------------------------------------------------------------

/**
 * File holding the bearer token used to authenticate mobile clients.
 * Generated on first server start; persisted with mode 0600.
 */
export const MOBILE_TOKEN_FILE = join(homedir(), '.claude', 'ui-mobile-token');

// ---------------------------------------------------------------------------
// TLS — auto-enabled when cert + key files exist under ~/.claude/tls/.
// The recommended way to generate them is mkcert (https://mkcert.dev):
//
//   brew install mkcert nss
//   mkcert -install                               # installs local root CA
//   mkdir -p ~/.claude/tls && cd ~/.claude/tls
//   mkcert <lan-ip> localhost 127.0.0.1 <mac>.local
//   mv <lan-ip>+3.pem cert.pem && mv <lan-ip>+3-key.pem key.pem
//
// Then restart the service and install the root CA on your phone:
//   mkcert -CAROOT           # prints the path on your Mac
// AirDrop the rootCA.pem to your iPhone or copy to Android, install as
// a profile, and mark it as trusted.
// ---------------------------------------------------------------------------
export const TLS_CERT_FILE = process.env.CLAUDE_UI_TLS_CERT || join(homedir(), '.claude', 'tls', 'cert.pem');
export const TLS_KEY_FILE  = process.env.CLAUDE_UI_TLS_KEY  || join(homedir(), '.claude', 'tls', 'key.pem');

/** Returns `{ cert, key }` when both TLS files are readable, or null. */
export function resolveTls(): { cert: string; key: string } | null {
  try {
    if (!existsSync(TLS_CERT_FILE) || !existsSync(TLS_KEY_FILE)) return null;
    return {
      cert: readFileSync(TLS_CERT_FILE, 'utf-8'),
      key: readFileSync(TLS_KEY_FILE, 'utf-8'),
    };
  } catch {
    return null;
  }
}

let _mobileTokenCache: string | null = null;

/**
 * Load the mobile auth token from disk, generating a fresh one if missing.
 * Token is 32 random bytes hex-encoded (64 chars). The file is chmod 0600.
 */
export function loadOrCreateMobileToken(): string {
  if (_mobileTokenCache) return _mobileTokenCache;
  try {
    if (existsSync(MOBILE_TOKEN_FILE)) {
      const t = readFileSync(MOBILE_TOKEN_FILE, 'utf-8').trim();
      if (t.length >= 32) {
        _mobileTokenCache = t;
        return t;
      }
    }
  } catch {}
  // Generate + write
  const fresh = randomBytes(32).toString('hex');
  try {
    mkdirSync(join(homedir(), '.claude'), { recursive: true });
    writeFileSync(MOBILE_TOKEN_FILE, fresh, { encoding: 'utf-8', mode: 0o600 });
    try { chmodSync(MOBILE_TOKEN_FILE, 0o600); } catch {}
  } catch {}
  _mobileTokenCache = fresh;
  return fresh;
}

/** Force-rotate the mobile token. Returns the new token. */
export function regenerateMobileToken(): string {
  _mobileTokenCache = null;
  try {
    if (existsSync(MOBILE_TOKEN_FILE)) {
      // Remove so loadOrCreateMobileToken generates a fresh one
      const fresh = randomBytes(32).toString('hex');
      writeFileSync(MOBILE_TOKEN_FILE, fresh, { encoding: 'utf-8', mode: 0o600 });
      try { chmodSync(MOBILE_TOKEN_FILE, 0o600); } catch {}
      _mobileTokenCache = fresh;
      return fresh;
    }
  } catch {}
  return loadOrCreateMobileToken();
}

/**
 * Best-effort LAN IP discovery. Returns the first non-internal IPv4 from any
 * interface, or '127.0.0.1' as a fallback.
 */
export function getLanIp(): string {
  try {
    const ifaces = networkInterfaces();
    // Prefer en0/en1/wlan0/eth0 ordering, then anything else
    const order = (name: string) => {
      if (/^en0/.test(name)) return 0;
      if (/^en1/.test(name)) return 1;
      if (/^wlan/i.test(name)) return 2;
      if (/^eth/i.test(name)) return 3;
      return 4;
    };
    const names = Object.keys(ifaces).sort((a, b) => order(a) - order(b));
    for (const name of names) {
      const addrs = ifaces[name] || [];
      for (const a of addrs) {
        if (a.family === 'IPv4' && !a.internal) return a.address;
      }
    }
  } catch {}
  return '127.0.0.1';
}
