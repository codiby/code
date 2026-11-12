/**
 * Path helpers for the classifier: where a tool call points, and whether that
 * place holds secrets.
 *
 * Detection is component-based (".ssh" anywhere in the path) as well as
 * absolute, because shell commands often reach secrets through relative
 * paths after a `cd`, which the classifier does not track.
 */

import { existsSync, realpathSync } from 'fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';

export interface PathContext {
  workspaceDir: string;
  home: string;
  /** `~/.codiby` — or the sandbox under tests. */
  codibyDir: string;
  /** Port this bridge listens on (config PORT); calls to it are policed. */
  bridgePort?: number;
}

/**
 * `agent_vault` — the agent's own vault, keys and config, the bridge's data
 * dir (tokens, database) and the logins the agent runs on (always denied).
 * `ssh` — SSH keys and authorized_keys (reads ask, writes are destructive).
 * `credentials` — other secret stores (ask).
 */
export type PathSensitivity = 'agent_vault' | 'ssh' | 'credentials';

/** The agent session's id (MAIN_SESSION_ID), kept literal so this module stays import-free. */
const AGENT_SESSION = 'main-session';

/**
 * What the agent may read under ~/.codiby: the attachments channels saved
 * for it, and the screenshots, mockups and app attachments of its own
 * session (the screenshot tool hands back a path to read). Everything else
 * there — tokens, the vault key, the database, pairings, other sessions — is
 * the bridge's, not the agent's.
 */
const CODIBY_READABLE = [join('agent', 'files'), join('screenshots', AGENT_SESSION), join('mockups', AGENT_SESSION), join('sessions', AGENT_SESSION)];

/** Files under ~/.codiby that hold secrets, for relative forms (`cd ~ && cat .codiby/ui-mobile-token`). */
const CODIBY_SECRET_FORM = /(^|\/)\.codiby\/(?:ui-mobile-token|database\.sqlite[^/]*|requirements\.key|vault\.key|tls|pairing|ui-telegram\.json|ui-deepgram\.json|personal-agent\.json|host-identity\.json|ui-remotes\.json|slack|ssh-control[^/]*|peer-receipts)(\/|$)/;
/** The Claude login (`~/.claude/.credentials.json` and its backups) and the WhatsApp CLI's session config. */
const RUNTIME_LOGIN_FORM = /(^|\/)\.claude\/\.credentials[^/]*$|(^|\/)\.wacli\/config\.json$/;

/** `~`, `$HOME` and `${HOME}` expanded; relative paths resolved against `base`. */
export function resolveToolPath(raw: string, base: string, home: string): string {
  let p = raw.trim();
  if (p.startsWith('"') && p.endsWith('"') && p.length >= 2) p = p.slice(1, -1);
  p = p.replace(/^(?:\$\{HOME\}|\$HOME)(?=\/|$)/, '~');
  if (p === '~') return home;
  if (p.startsWith('~/')) return join(home, p.slice(2));
  return isAbsolute(p) ? resolve(p) : resolve(base, p);
}

export function isInside(child: string, parent: string): boolean {
  if (!parent) return false;
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Resolve symlinks on the deepest existing ancestor, so a link inside the
 * workspace that points elsewhere is judged by where it really lands.
 */
export function realPathBestEffort(p: string): string {
  let current = p;
  const rest: string[] = [];
  for (let i = 0; i < 64; i++) {
    try {
      if (existsSync(current)) {
        const real = realpathSync(current);
        return rest.length ? join(real, ...rest.reverse()) : real;
      }
    } catch {
      return p;
    }
    const parent = dirname(current);
    if (parent === current) break;
    rest.push(basename(current));
    current = parent;
  }
  return p;
}

const CREDENTIAL_DIR_COMPONENTS = new Set(['.aws', '.gnupg', '.password-store', '.azure', 'Keychains', '.1password']);
const CREDENTIAL_FILES = new Set([
  '.netrc', '.pgpass', '.git-credentials', '.npmrc', '.pypirc', '.my.cnf', 'credentials.json',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'shadow', 'gshadow', 'sudoers', 'keychain-2.db',
]);
const CREDENTIAL_SUFFIXES = ['.pem', '.key', '.p12', '.pfx', '.keystore', '.jks', '.ppk', '.kdbx', '.asc'];
const CREDENTIAL_SUBPATHS = [
  '.docker/config.json', '.kube/config', '.config/gh/hosts.yml', '.config/gcloud', '.config/hub',
  'Library/Application Support/Google/Chrome', '.config/google-chrome', '.config/chromium',
  'Library/Cookies', '.mozilla/firefox', 'etc/ssh/ssh_host_',
];
const ENV_FILE = /^\.env(?:\.(?!example$|sample$|template$|dist$)[\w.-]+)?$/i;

/** Shell glob and brace characters: the literal checks below can't see what such a path expands to. */
const GLOB_CHARS = /[*?[\]{}]/;

/** Expand one level of `{a,b}` braces (enough for paths; nested braces are rare and stay literal). */
function expandBraces(p: string): string[] {
  const m = /\{([^{}]*,[^{}]*)\}/.exec(p);
  if (!m) return [p];
  return m[1]!.split(',').flatMap(alt => expandBraces(p.slice(0, m.index) + alt + p.slice(m.index + m[0].length)));
}

/** Glob → anchored regex: `*` and `?` stay within one path segment, `**` crosses segments. */
function globToRegex(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end < 0) { re += '\\['; continue; }
      re += '[' + glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']';
      i = end;
    } else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Known secret files a glob must not be able to reach. */
function secretSentinels(ctx: PathContext): { path: string; kind: PathSensitivity }[] {
  const h = ctx.home;
  const c = ctx.codibyDir;
  const vault = ['ui-mobile-token', 'database.sqlite', 'requirements.key', 'vault.key', 'ui-telegram.json', 'ui-deepgram.json', 'personal-agent.json', 'host-identity.json', 'ui-remotes.json', join('agent', 'vault.json'), join('agent', 'config.json'), join('agent', 'channels.json')];
  return [
    ...vault.flatMap(f => [join(c, f), join(h, '.codiby', f)]).map(path => ({ path, kind: 'agent_vault' as const })),
    { path: join(h, '.config', 'codiby', 'vault.key'), kind: 'agent_vault' },
    { path: join(h, '.claude', '.credentials.json'), kind: 'agent_vault' },
    { path: join(h, '.wacli', 'config.json'), kind: 'agent_vault' },
    ...['id_rsa', 'id_ed25519', 'id_ecdsa', 'config'].map(f => ({ path: join(h, '.ssh', f), kind: 'ssh' as const })),
    { path: join(h, '.aws', 'credentials'), kind: 'credentials' },
    { path: join(h, '.netrc'), kind: 'credentials' },
  ];
}

/**
 * A path written with glob or brace characters is checked by what it can
 * expand to: matching any known secret file counts as that file, and any
 * glob inside a home dot-folder is treated as credentials (asks).
 */
function globSensitivity(abs: string, ctx: PathContext): PathSensitivity | null {
  const variants = expandBraces(abs.replace(/\\/g, '/'));
  for (const v of variants) {
    const re = globToRegex(v);
    const hit = secretSentinels(ctx).find(s => re.test(s.path.replace(/\\/g, '/')));
    if (hit) return hit.kind;
  }
  // A glob that walks into a home dot-folder (`~/.c*/…`, `~/.*`) may reach
  // credentials no list names; globs elsewhere (`~/agent/*.md`) are fine.
  const home = ctx.home.replace(/\\/g, '/').replace(/\/$/, '');
  if (variants.some(v => GLOB_CHARS.test(v) && v.startsWith(`${home}/.`))) return 'credentials';
  return null;
}

function components(p: string): string[] {
  return p.split(/[\\/]+/).filter(Boolean);
}

/**
 * How sensitive a path is. `abs` must already be absolute (see
 * `resolveToolPath`); `raw` is the path as written, for component checks on
 * relative forms.
 */
export function pathSensitivity(abs: string, ctx: PathContext, raw = abs): PathSensitivity | null {
  if (GLOB_CHARS.test(raw) || GLOB_CHARS.test(abs)) {
    const viaGlob = globSensitivity(abs, ctx);
    if (viaGlob) return viaGlob;
  }
  const forms = [abs, raw.replace(/\\/g, '/')];
  const agentDir = join(ctx.codibyDir, 'agent');
  const homeAgentDir = join(ctx.home, '.codiby', 'agent');
  for (const dir of [agentDir, homeAgentDir]) {
    // Attachments the owner sent live under agent/files and must stay readable.
    if (isInside(abs, dir) && !isInside(abs, join(dir, 'files'))) return 'agent_vault';
  }
  if (isInside(abs, join(ctx.home, '.config', 'codiby'))) return 'agent_vault';
  if (abs === join(ctx.codibyDir, 'vault.key')) return 'agent_vault';
  if (isInside(abs, join(ctx.home, '.claude')) && basename(abs).startsWith('.credentials')) return 'agent_vault';
  if (abs === join(ctx.home, '.wacli', 'config.json')) return 'agent_vault';
  for (const form of forms) {
    if (/(^|\/)\.codiby\/agent(\/(?!files\/)|$)/.test(form) || /(^|\/)\.config\/codiby(\/|$)/.test(form)) return 'agent_vault';
    if (/(^|\/)vault\.(key|json)$/.test(form)) return 'agent_vault';
    if (CODIBY_SECRET_FORM.test(form) || RUNTIME_LOGIN_FORM.test(form)) return 'agent_vault';
  }

  for (const form of forms) {
    if (components(form).includes('.ssh')) return 'ssh';
  }

  for (const form of forms) {
    const parts = components(form);
    if (parts.some(c => CREDENTIAL_DIR_COMPONENTS.has(c))) return 'credentials';
    const name = parts[parts.length - 1] ?? '';
    if (CREDENTIAL_FILES.has(name) || ENV_FILE.test(name)) return 'credentials';
    if (/^id_(rsa|dsa|ecdsa|ed25519)/.test(name)) return 'credentials';
    if (CREDENTIAL_SUFFIXES.some(s => name.toLowerCase().endsWith(s))) return 'credentials';
    const joined = parts.join('/');
    if (CREDENTIAL_SUBPATHS.some(sub => joined.includes(sub))) return 'credentials';
    if (/^\/?proc\/[^/]+\/environ$/.test(joined)) return 'credentials';
  }

  // The rest of ~/.codiby (tokens, database, pairings, other sessions) is
  // denied — unless the workspace itself was placed inside it (the test
  // sandbox does this) or it is the agent's own output (CODIBY_READABLE).
  const codibyDirs = [ctx.codibyDir, join(ctx.home, '.codiby')];
  for (const dir of codibyDirs) {
    if (!isInside(abs, dir)) continue;
    if (isInside(ctx.workspaceDir, dir) && isInside(abs, ctx.workspaceDir)) continue;
    if (CODIBY_READABLE.some(sub => isInside(abs, join(dir, sub)))) continue;
    return 'agent_vault';
  }
  return null;
}

/** True for a path inside the agent's workspace (after resolving symlinks). */
export function isInWorkspace(abs: string, ctx: PathContext): boolean {
  const ws = resolve(ctx.workspaceDir);
  return isInside(abs, ws) && isInside(realPathBestEffort(abs), realPathBestEffort(ws));
}

/** Strip a trailing separator so `~/` and `~` compare equal. */
export function trimSep(p: string): string {
  return p.length > 1 && p.endsWith(sep) ? p.slice(0, -1) : p;
}
