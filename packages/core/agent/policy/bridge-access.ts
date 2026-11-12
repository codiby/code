/**
 * Calls the agent makes to this very bridge.
 *
 * The bridge trusts loopback callers without a token — the desktop app
 * depends on that — so `curl localhost:3111/…` from the agent's shell, a
 * WebFetch or its browser would walk around every rule in this folder:
 * answer its own approvals, rewrite its rules, read saved logins through
 * /agent/secrets, pair a new phone. A bridge call therefore always asks, and
 * the endpoints that hand out secrets, access or the policy itself are
 * denied outright.
 *
 * Detection is textual and deliberately broad (any loopback spelling curl
 * accepts, a port taken from a variable, raw sockets, a spoofed Host
 * header): a false "ask" costs the owner a tap, a miss costs the guardrails.
 */

import { PORT } from '../../config/config';

export type BridgeAccess = { level: 'secret' | 'bridge'; reason: string };

/** Endpoints that reveal secrets, grant access or change the agent's own policy. */
const SECRET_PATHS: { re: RegExp; what: string }[] = [
  { re: /^\/agent\/config(?:[/?#]|$)/, what: "the agent's config" },
  { re: /^\/agent\/secrets(?:[/?#]|$)/, what: 'saved logins' },
  { re: /^\/agent\/(?:rules|policy|approvals)(?:[/?#]|$)/, what: "the agent's own rules and approvals" },
  { re: /^\/agent\/channels\/[^/]+\/(?:pairings|secret)(?:[/?#]|$)/, what: 'channel pairing and tokens' },
  { re: /^\/mobile\/pair(?:[/?#]|$)/, what: 'the mobile pairing token' },
  { re: /^\/pairings(?:[/?#]|$)/, what: 'host pairings' },
  { re: /^\/telegram\/settings(?:[/?#]|$)/, what: 'the Telegram bot token' },
  { re: /^\/providers\/[^/]+\/(?:auth|login|logout)(?:[/?#]|$)/, what: 'provider logins' },
];

/** Paths only this bridge serves: a loopback request to one of them is a bridge call whatever the port. */
const BRIDGE_PATH = /^\/(?:agent|sessions|mobile|peer|mcp|ws|phone|pairings|automations|providers|telegram)(?:[/?#]|$)/;

/** Every loopback spelling curl, wget and friends resolve: names, dotted/short/decimal/hex IPv4, IPv6. */
const LOOPBACK_HOST = String.raw`(?:(?:[a-z0-9-]+\.)*localhost\.?|127(?:\.\d{1,3}){1,3}|0\.0\.0\.0|2130706433|0x7f0*1|\[(?:0{0,4}:){2,7}0{0,3}1?\]|\[::ffff:127(?:\.\d{1,3}){3}\]|::1)`;
const PATH_CHARS = String.raw`[^\s'"<>|;&)\\]*`;
/** host, then an optional port (a number or a shell variable), then an optional path. `//0` is 0.0.0.0. */
const LOOPBACK_URL = new RegExp(
  String.raw`(?:(?:https?|wss?):\/\/(?:[^\s/@'"]*@)?(${LOOPBACK_HOST}|0)|(?<![\w.:@-])(${LOOPBACK_HOST}))(?::(\d{1,5}|\$\{?\w+\}?))?(\/${PATH_CHARS})?`,
  'gi',
);
/** Raw sockets carry the request line in their input instead of a URL. */
const RAW_SOCKET = /(?:^|[\s;&|(`])(?:nc|ncat|netcat|socat|telnet|openssl\s+s_client)\b|\/dev\/(?:tcp|udp)\//;
const REQUEST_LINE = new RegExp(String.raw`\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/${PATH_CHARS})`, 'g');
/** A Host header naming loopback makes any address that resolves to 127.0.0.1 look local to the bridge. */
const SPOOFED_HOST = /\bHost\s*:\s*(?:(?:[a-z0-9-]+\.)*localhost|127\.|\[?::1\]?|0\.0\.0\.0)/i;

/** Decode, resolve dot segments and collapse slashes, so `/agent/./%63onfig` reads as `/agent/config`. */
function normalisePath(raw: string): string {
  let p = raw;
  try { p = decodeURIComponent(p); } catch { /* keep it encoded */ }
  p = p.replace(/\/{2,}/g, '/');
  try { p = new URL(p, 'http://bridge.invalid').pathname; } catch { /* keep as is */ }
  return p.toLowerCase();
}

function secretOf(path: string): string | null {
  const p = normalisePath(path);
  return SECRET_PATHS.find(s => s.re.test(p))?.what ?? null;
}

const isBridgePath = (path: string) => BRIDGE_PATH.test(normalisePath(path));

/** IPv4 dotted form of an IPv4-mapped IPv6 address (`::ffff:7f00:1` → `127.0.0.1`), else null. */
function mappedIPv4(host: string): string | null {
  const m = /^::ffff:(.+)$/i.exec(host);
  if (!m) return null;
  const rest = m[1]!;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(rest)) return rest;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(rest);
  if (!hex) return null;
  const hi = parseInt(hex[1]!, 16);
  const lo = parseInt(hex[2]!, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** A canonical URL hostname (as `new URL` returns it) that reaches this machine. */
export function isLocalHostname(hostname: string): boolean {
  let h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  h = mappedIPv4(h) ?? h;
  // The URL parser already compressed IPv6 (`0:0:…:1` → `::1`).
  if (h === '::1' || h === '::') return true;
  return /^127\.\d+\.\d+\.\d+$/.test(h) || h === '0.0.0.0';
}

/**
 * URL-like words of `text`, parsed with the WHATWG URL parser — the same
 * parser browsers use and close to what curl accepts — so every spelling of
 * an address (octal or hex IPv4 parts, shortened forms, a port with leading
 * zeros) is compared in its canonical form rather than as text.
 */
function canonicalUrls(text: string): URL[] {
  const out: URL[] = [];
  for (const raw of text.split(/[\s'"<>|;&()`\\]+/)) {
    let word = raw.replace(/^[^\w[]+/, '');
    if (!word) continue;
    const eq = word.indexOf('=');
    if (eq > 0 && !word.includes('://')) word = word.slice(eq + 1);
    // curl and httpie take a bare `host[:port][/path]`; only words that look
    // like an address (a digit-and-dot host, an IPv6 literal, a *localhost name) qualify.
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(word)
      ? word
      : /^(?:\[[0-9a-f:.]+\]|[0-9a-fx.]+|(?:[a-z0-9-]+\.)*localhost\.?)(?::\d+)?(?:\/|$)/i.test(word) ? `http://${word}` : null;
    if (!candidate) continue;
    try { out.push(new URL(candidate)); } catch { /* not a URL */ }
  }
  return out;
}

/** The shell builds the host or the port of a URL (`http://$H:…`, `:$((3000+111))`, `:\`cmd\``): it can't be checked. */
const COMPUTED_ADDRESS = /:\/\/(?:[^\s/@'"]*@)?(?:\$|`)|:\$\(|:`/;
const NETWORK_CLIENT = /(?:^|[\s;&|(`])(?:curl|wget|http|https|xh|aria2c|fetch|nc|ncat|netcat|socat|telnet|openssl)\b|\/dev\/(?:tcp|udp)\//;

/**
 * What `text` (a shell command, a URL) does to this bridge, if anything.
 * `port` defaults to the port this bridge listens on.
 */
export function bridgeAccess(text: string, port: number = PORT): BridgeAccess | null {
  if (!text) return null;
  const portWord = new RegExp(String.raw`(?<![\w.-])${port}(?![\w.])`);
  const anyHostWithPort = new RegExp(String.raw`(?:https?|wss?):\/\/[^\s/'"]+:${port}(\/${PATH_CHARS})?`, 'gi');
  let bridge: string | null = null;
  let loopback = false;

  for (const m of text.matchAll(LOOPBACK_URL)) {
    loopback = true;
    const urlPort = m[3];
    const path = m[4];
    if (path) {
      const secret = secretOf(path);
      if (secret) return { level: 'secret', reason: `Calls this bridge's ${normalisePath(path)} endpoint (${secret})` };
    }
    if (urlPort === String(port)) bridge ??= `Calls this Codiby bridge (port ${port})`;
    else if (urlPort?.startsWith('$')) bridge ??= `Calls a local port taken from ${urlPort}, which may be this bridge`;
    else if (path && isBridgePath(path)) bridge ??= `Calls a bridge endpoint on this machine (${normalisePath(path)})`;
  }

  // httpie / xh shorthand: `http :3111/sessions` means localhost.
  for (const m of text.matchAll(new RegExp(String.raw`(?:^|[\s'"=])(?:https?:\/\/)?:${port}(?!\d)(\/${PATH_CHARS})?`, 'g'))) {
    const path = m[1];
    const secret = path ? secretOf(path) : null;
    if (secret) return { level: 'secret', reason: `Calls this bridge's ${normalisePath(path!)} endpoint (${secret})` };
    bridge ??= `Calls this Codiby bridge (port ${port})`;
  }

  // Any host on the bridge's port: numeric loopback forms, names resolved
  // to 127.0.0.1 with --resolve, this machine's own hostname.
  for (const m of text.matchAll(anyHostWithPort)) {
    const path = m[1];
    if (!path) continue;
    const secret = secretOf(path);
    if (secret) return { level: 'secret', reason: `Calls a bridge's ${normalisePath(path)} endpoint (${secret})` };
    if (isBridgePath(path)) bridge ??= `Calls a Codiby bridge endpoint (${normalisePath(path)})`;
  }

  if (RAW_SOCKET.test(text) && (loopback || portWord.test(text))) {
    for (const m of text.matchAll(REQUEST_LINE)) {
      const secret = secretOf(m[1]!);
      if (secret) return { level: 'secret', reason: `Sends a raw request for this bridge's ${normalisePath(m[1]!)} endpoint (${secret})` };
      if (isBridgePath(m[1]!)) bridge ??= 'Sends a raw request to a bridge endpoint';
    }
    if (loopback && portWord.test(text)) bridge ??= `Opens a raw connection to this bridge (port ${port})`;
  }

  // Canonical pass: whatever spelling the address uses, compare the parsed form.
  for (const u of canonicalUrls(text)) {
    if (!isLocalHostname(u.hostname)) continue;
    const path = u.pathname || '/';
    const secret = secretOf(path);
    if (secret) return { level: 'secret', reason: `Calls this bridge's ${normalisePath(path)} endpoint (${secret})` };
    const urlPort = Number(u.port || (u.protocol === 'https:' || u.protocol === 'wss:' ? 443 : 80));
    if (urlPort === port) bridge ??= `Calls this Codiby bridge (port ${port})`;
    else if (isBridgePath(path)) bridge ??= `Calls a bridge endpoint on this machine (${normalisePath(path)})`;
  }

  if (NETWORK_CLIENT.test(text) && COMPUTED_ADDRESS.test(text)) {
    bridge ??= 'Calls an address the shell computes at run time, which may be this bridge';
  }

  if (SPOOFED_HOST.test(text)) bridge ??= 'Sends a request claiming to come from localhost';
  return bridge ? { level: 'bridge', reason: bridge } : null;
}
