import { homedir, networkInterfaces } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { randomBytes } from 'crypto';
import { execSync } from 'child_process';

// Enrich `process.env.PATH` so anything we spawn downstream — the Claude SDK's
// `claude` binary, the Bash tool's child processes, `git`, `sudo`, `bun`, etc.
// — can resolve user-installed binaries. When the bridge is launched from the
// desktop app (Finder/Dock) or a LaunchAgent it inherits launchd's PATH, which
// reads `/etc/paths(.d)/*` but never sources `~/.zshrc` / `~/.zprofile`. So
// per-user bin dirs added by shell rc files (`~/.opencode/bin`, `~/.local/bin`,
// `~/.cargo/bin`, …) are missing. The PTY shell handles its own login-mode
// profile load (see `pty.ts`), but Bun.spawn / Node spawn invocations from
// the bridge inherit `process.env.PATH` directly — so we enrich it here once
// at module load.
//
// When launched by the desktop app or a service (any `--spawned-by=…` flag,
// or CODIBY_SPAWN_MODE set) we always enrich: the launchd-inherited PATH can
// look superficially "rich" (e.g. it already has /opt/homebrew/bin from
// /etc/paths) yet still miss user-rc dirs. Spending ~100ms on a login-shell
// PATH probe at boot is cheap insurance. From a real terminal (`bun run` with
// no spawn flag) the PATH is already complete, so we skip the probe.
(function enrichPathFromUserShell() {
  const cur = process.env.PATH || '';
  const launchedAsService =
    process.argv.slice(2).some((a) => a === '--spawned-by' || a.startsWith('--spawned-by=')) ||
    !!process.env.CODIBY_SPAWN_MODE;
  if (!launchedAsService) return;
  const shell = process.env.SHELL || '/bin/zsh';
  try {
    const out = execSync(`${shell} -lic 'printf "<<<PATH>>>%s<<</PATH>>>" "$PATH"'`, {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = out.match(/<<<PATH>>>([^<]*)<<<\/PATH>>>/);
    if (m && m[1]) {
      // Prepend the user shell's PATH (don't drop the existing one — the SDK
      // and claude-plugins append their own bin dirs after first run, and
      // those need to stay reachable).
      process.env.PATH = `${m[1]}:${cur}`;
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
/** Root directory for all Codiby app data. We keep `~/.claude` reserved
 *  for the Claude CLI's own binary + settings (which our adapter still
 *  reads/writes — see ensure-mcp-config and mcp-config) and migrate
 *  everything we own to `~/.codiby/` on startup. */
export const CODIBY_DIR = join(homedir(), '.codiby');
export const SESSIONS_FILE = join(CODIBY_DIR, 'ui-sessions.json');

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
  // Invoking the plan tool is not the decision point — the tool's own handler
  // (mcp.ts) raises a second, richer permission request carrying the plan
  // markdown, and that's what the user actually approves or rejects. Prompting
  // for the invocation too would make every plan take two approvals: a bare
  // "run this tool?" followed by the real plan review.
  'mcp__codiby-code__ExitPlanMode',
  // Declaring a target or a requirement has no side effects outside the
  // requirements panel, and a requirement only becomes binding once the user
  // approves it. `run_requirements` is deliberately NOT here — it executes
  // shell commands and goes through the normal permission flow.
  'mcp__codiby-code-sdk__set_target',
  'mcp__codiby-code-sdk__add_requirements',
  'mcp__codiby-code-sdk__edit_requirement',
  'mcp__codiby-code-sdk__attach_requirement_image',
  'mcp__codiby-code-sdk__propose_change',
]);

/**
 * Paths the agent must never touch through a tool. The requirements database
 * and its signing key are the ledger the agent is being graded against —
 * signature verification catches edits after the fact, this stops the obvious
 * attempt up front and makes it visible in the transcript.
 */
export const PROTECTED_PATH_PATTERNS: RegExp[] = [
  /\.codiby\/database\.sqlite/,
  /\.codiby\/requirements\.key/,
];

/**
 * True when a tool invocation appears to read or write a protected path.
 * Deliberately crude and string-based: it runs over the raw tool input, so a
 * `bash -lc` one-liner mentioning the file trips it just as a Read would.
 */
export function touchesProtectedPath(input: unknown): boolean {
  let serialized: string;
  try {
    serialized = typeof input === 'string' ? input : JSON.stringify(input ?? '');
  } catch {
    return false;
  }
  return PROTECTED_PATH_PATTERNS.some(pattern => pattern.test(serialized));
}

/**
 * Tools whose entire purpose is to hand control back to the user. Even in
 * `bypassPermissions` mode we must prompt — auto-approving them would either
 * silently swallow the question (AskUserQuestion) or skip the plan review
 * step the user explicitly asked for (ExitPlanMode).
 */
export const USER_INTERACTION_TOOLS = new Set([
  'AskUserQuestion',
  'ExitPlanMode',
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
export const MOBILE_TOKEN_FILE = join(CODIBY_DIR, 'ui-mobile-token');

// ---------------------------------------------------------------------------
// TLS — auto-enabled when cert + key files exist under ~/.codiby/tls/.
// The recommended way to generate them is mkcert (https://mkcert.dev):
//
//   brew install mkcert nss
//   mkcert -install                               # installs local root CA
//   mkdir -p ~/.codiby/tls && cd ~/.codiby/tls
//   mkcert <lan-ip> localhost 127.0.0.1 <mac>.local
//   mv <lan-ip>+3.pem cert.pem && mv <lan-ip>+3-key.pem key.pem
//
// Then restart the service and install the root CA on your phone:
//   mkcert -CAROOT           # prints the path on your Mac
// AirDrop the rootCA.pem to your iPhone or copy to Android, install as
// a profile, and mark it as trusted.
// ---------------------------------------------------------------------------
export const TLS_CERT_FILE = process.env.CLAUDE_UI_TLS_CERT || join(CODIBY_DIR, 'tls', 'cert.pem');
export const TLS_KEY_FILE  = process.env.CLAUDE_UI_TLS_KEY  || join(CODIBY_DIR, 'tls', 'key.pem');

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
    mkdirSync(CODIBY_DIR, { recursive: true });
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
