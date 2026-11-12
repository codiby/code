/**
 * Who is calling the bridge — the pure checks behind its two levels of trust.
 *
 * 1. **Localhost trust** (`isLocalhostRequest`): the desktop app on this
 *    machine works without the bearer token. Every other caller (LAN,
 *    Tailscale, Funnel) brings the token.
 * 2. **Owner-verified** (`isOwnerVerifiedRequest`): what changes to the
 *    owner's own settings need (who the agent obeys, its secrets, the phone
 *    token). Localhost trust is not enough there: the agent session runs
 *    shell commands on this very machine, so a `curl localhost:3111/...` from
 *    its Bash would pass it. Those routes also want either the bearer token
 *    or a browser page of the bridge's own UI.
 *
 * Kept free of `Request`/server state so every rule has a unit test
 * (local-trust.test.ts); index.ts feeds it the headers and the socket peer.
 */

import { timingSafeEqual } from 'crypto';
import { isLoopbackAddress } from './client-origin';

/** `localhost`, `127.x.x.x` or `::1`, from a Host header (port and brackets stripped). */
export function isLoopbackHost(hostHeader: string | null | undefined): boolean {
  if (!hostHeader) return false;
  let hostname = hostHeader.trim().toLowerCase();
  if (hostname.startsWith('[')) {
    // `[::1]:3111` → `::1`
    const end = hostname.indexOf(']');
    if (end < 0) return false;
    hostname = hostname.slice(1, end);
  } else if (hostname.split(':').length === 2) {
    // `localhost:3111` → `localhost`. Several colons is a bare IPv6, which
    // can't carry a port.
    hostname = hostname.replace(/:\d*$/, '');
  }
  return hostname === 'localhost' || isLoopbackAddress(hostname);
}

/**
 * No Origin (CLI, SDK, curl, native apps) or a page served from this
 * machine's loopback — the bridge's own UI, or the local UI of a laptop whose
 * tunnel reaches a remote bridge. `null` (sandboxed iframes, file://) and
 * garbage are not local.
 */
export function isLocalOrigin(origin: string | null | undefined): boolean {
  if (!origin) return true;
  return isLoopbackOrigin(origin);
}

/** An Origin that is present and served from loopback. */
export function isLoopbackOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false;
  try {
    const { protocol, hostname } = new URL(origin);
    if (protocol !== 'http:' && protocol !== 'https:') return false;
    return hostname === 'localhost' || isLoopbackAddress(hostname);
  } catch {
    return false;
  }
}

/**
 * Headers a reverse proxy adds. A loopback socket carrying them is a proxy
 * on this machine (Tailscale Funnel/Serve, ngrok, cloudflared, Caddy…)
 * relaying someone else's request; if that proxy also rewrote Host to
 * localhost, the Host and peer checks alone would hand that someone the
 * desktop's trust.
 */
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded', 'tailscale-funnel-request'];

export function isProxiedRequest(headers: Pick<Headers, 'has'>): boolean {
  return PROXY_HEADERS.some(h => headers.has(h));
}

export interface LocalhostInput {
  /** The Host header. */
  host: string | null | undefined;
  /** The socket's real peer address (`server.requestIP(req)?.address`). */
  peer: string | null | undefined;
  origin: string | null | undefined;
  /** See `isProxiedRequest`. */
  proxied?: boolean;
}

/**
 * The desktop app on this machine. All four must hold:
 * - Host is loopback — a page on evil.example whose DNS points at 127.0.0.1
 *   (DNS rebinding) still sends `Host: evil.example`.
 * - The socket itself is loopback — anyone on the LAN can send
 *   `Host: localhost` to <lan-ip>:3111.
 * - Origin is absent or loopback — a website open in the owner's browser can
 *   call http://localhost:3111 too, and CORS here is `*`.
 * - No reverse-proxy headers — see `isProxiedRequest`.
 */
export function isLocalhostRequest(input: LocalhostInput): boolean {
  return isLoopbackHost(input.host)
    && isLoopbackAddress(input.peer)
    && isLocalOrigin(input.origin)
    && !input.proxied;
}

/**
 * A browser page of the bridge's own UI, as opposed to a CLI on this machine.
 * Browsers send Origin on every cross-origin request and on same-origin ones
 * that aren't GET/HEAD; a same-origin GET carries only `Sec-Fetch-Site:
 * same-origin` (a header page scripts cannot set). Neither proves much
 * against a local process — curl can send both — so this only keeps an agent
 * that was told to "curl the bridge" from succeeding by accident. The real
 * line against a local process is the policy layer (see the report).
 */
export function isLocalUiRequest(origin: string | null | undefined, secFetchSite: string | null | undefined): boolean {
  if (origin) return isLoopbackOrigin(origin);
  return secFetchSite === 'same-origin';
}

/** Constant-time compare; false for empty strings. */
function sameSecret(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length === 0 || ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export interface TokenInput {
  authorization: string | null | undefined;
  /** `?t=` from the URL. */
  queryToken: string | null | undefined;
  /** `Sec-WebSocket-Protocol` — the only header a browser may set on a WS upgrade. */
  wsProtocol: string | null | undefined;
}

/** True when the request carries the bridge's bearer token in any of its accepted places. */
export function presentsToken(input: TokenInput, token: string): boolean {
  if (!token) return false;
  const m = input.authorization?.match(/^Bearer\s+(.+)$/i);
  if (m && sameSecret(m[1]!.trim(), token)) return true;
  if (input.queryToken && sameSecret(input.queryToken, token)) return true;
  if (input.wsProtocol && input.wsProtocol.split(',').map(s => s.trim()).some(p => sameSecret(p, token))) return true;
  return false;
}

export interface CallerInput extends LocalhostInput, TokenInput {
  secFetchSite: string | null | undefined;
}

/** Read everything the checks above need off a request. */
export function callerInput(req: Request, url: URL, peer: string | null | undefined): CallerInput {
  const h = req.headers;
  return {
    host: h.get('host'),
    peer,
    origin: h.get('origin'),
    proxied: isProxiedRequest(h),
    secFetchSite: h.get('sec-fetch-site'),
    authorization: h.get('authorization'),
    queryToken: url.searchParams.get('t'),
    wsProtocol: h.get('sec-websocket-protocol'),
  };
}

/** What a caller that fails `isOwnerVerifiedRequest` is told (403). */
export const OWNER_VERIFICATION_ERROR = 'This change must come from the Codiby app, or carry the bridge token';
/** The same refusal for a read (GETs that reveal the owner's identities or secret names). */
export const OWNER_READ_VERIFICATION_ERROR = 'This can only be read from the Codiby app, or with the bridge token';

/**
 * Owner settings, secrets and approvals: the bearer token, or the bridge's
 * own UI from this machine. A localhost caller without an Origin — curl, a
 * script, the agent's own shell — is turned away.
 */
export function isOwnerVerifiedRequest(input: CallerInput, token: string): boolean {
  if (presentsToken(input, token)) return true;
  return isLocalhostRequest(input) && isLocalUiRequest(input.origin, input.secFetchSite);
}
