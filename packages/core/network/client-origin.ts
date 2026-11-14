/**
 * Where the browser talking to this bridge actually runs.
 *
 * The desktop app and a LAN / Tailscale browser hit the same Bun server, so
 * the only thing that tells them apart is the socket the connection arrived
 * on. A loopback peer is the app on this machine; anything else is a browser
 * on a *different* computer.
 *
 * That distinction matters to the agent: a dev server it starts binds to this
 * machine's localhost, so a remote viewer cannot open it. `./port-forward`
 * publishes such a port on every interface; this module is what decides
 * whether that is needed at all.
 */

const LOOPBACK_NAMES = new Set(['localhost', '::1', '0:0:0:0:0:0:0:1']);

/** Strip brackets, zone id, and the IPv4-mapped-IPv6 prefix. */
function normalizeAddress(address: string): string {
  return address
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '')
    .replace(/^::ffff:/i, '')
    .toLowerCase();
}

export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  const addr = normalizeAddress(address);
  if (LOOPBACK_NAMES.has(addr)) return true;
  // The whole 127.0.0.0/8 block is loopback, not just 127.0.0.1.
  return /^127\.\d+\.\d+\.\d+$/.test(addr);
}

/**
 * How a client reaches this bridge, which decides what links it can open.
 *
 * - `this-machine`: loopback with a local Host — the desktop app here.
 * - `lan`: a private (RFC 1918 / ULA / link-local) peer.
 * - `tailnet`: a Tailscale peer (100.64/10, fd7a:115c:a1e0::/48), or Tailscale
 *   Serve, which proxies from loopback but stamps `Tailscale-User-Login`.
 * - `tailscale-funnel`: loopback peer under a `*.ts.net` Host with no tailnet
 *   identity — the public internet through Funnel. Before this it looked like
 *   the desktop app, because tailscaled connects from 127.0.0.1.
 * - `internet`: any other public peer.
 */
export type ClientRoute = 'this-machine' | 'lan' | 'tailnet' | 'tailscale-funnel' | 'internet';

function isTailscaleAddress(addr: string): boolean {
  const v4 = addr.match(/^100\.(\d+)\.\d+\.\d+$/);
  if (v4) { const second = Number(v4[1]); return second >= 64 && second <= 127; }
  return addr.startsWith('fd7a:115c:a1e0:');
}

function isPrivateAddress(addr: string): boolean {
  if (/^10\.\d+\.\d+\.\d+$/.test(addr) || /^192\.168\.\d+\.\d+$/.test(addr) || /^169\.254\.\d+\.\d+$/.test(addr)) return true;
  const m = addr.match(/^172\.(\d+)\.\d+\.\d+$/);
  if (m) { const second = Number(m[1]); return second >= 16 && second <= 31; }
  return /^f[cd][0-9a-f]{2}:/.test(addr) || addr.startsWith('fe80:');
}

export function classifyRoute(
  address: string,
  host: string | null,
  headers?: { get(name: string): string | null } | null,
): ClientRoute {
  if (isLoopbackAddress(address)) {
    if (host && /\.ts\.net$/i.test(host)) {
      return headers?.get('tailscale-user-login') ? 'tailnet' : 'tailscale-funnel';
    }
    return 'this-machine';
  }
  if (isTailscaleAddress(address)) return 'tailnet';
  if (isPrivateAddress(address)) return 'lan';
  return 'internet';
}

export type ClientOrigin = {
  /** Peer address of the socket, e.g. "192.168.1.24". */
  address: string;
  /** False only when the client runs on this machine (see `route`). */
  remote: boolean;
  route: ClientRoute;
  /**
   * Hostname from the `Host` header the client used to reach the bridge, port
   * stripped. This is the name a forwarded port has to be advertised under:
   * an address the bridge sees locally is useless if the client got here
   * through a Tailscale name or a reverse proxy.
   */
  host: string | null;
};

export function describeClientOrigin(
  address: string | null | undefined,
  hostHeader: string | null | undefined,
  headers?: { get(name: string): string | null } | null,
): ClientOrigin {
  const addr = address ? normalizeAddress(address) : '';
  const host = (hostHeader || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '') || null;
  // No address at all (a test, an unusual transport) keeps the old answer.
  const route = addr ? classifyRoute(addr, host, headers) : 'internet';
  return { address: addr, remote: route !== 'this-machine', host, route };
}

// Keyed by the frontend ServerWebSocket. Entries are added on `open` and
// dropped on `close`, so the map only ever holds live clients.
const origins = new Map<unknown, ClientOrigin>();

export function registerClientOrigin(ws: unknown, origin: ClientOrigin): void {
  origins.set(ws, origin);
}

export function forgetClientOrigin(ws: unknown): void {
  origins.delete(ws);
}

export function clientOrigin(ws: unknown): ClientOrigin | null {
  return origins.get(ws) ?? null;
}

// The live `ws -> subscribed session ids` map owned by index.ts. Bound once at
// startup so viewer questions can be answered per session instead of only
// globally (a phone watching session A says nothing about session B).
let subscriptionsRef: Map<unknown, Set<string>> | null = null;

export function bindSubscriptionMap(map: Map<unknown, Set<string>>): void {
  subscriptionsRef = map;
}

export type ViewerLocation = 'local' | 'remote' | 'none';

/**
 * Where the clients watching `sessionId` are.
 *
 * A loopback viewer wins: if the desktop app is open on this machine then
 * `http://localhost:3000` opens fine and the agent should not be told to
 * forward anything, even when a phone happens to be connected too. Falls back
 * to every connected client when nobody is subscribed to this session yet,
 * which is the case while a session is still spawning.
 */
export function sessionViewerLocation(sessionId: string): ViewerLocation {
  let sawRemote = false;
  let sawAny = false;

  if (subscriptionsRef) {
    for (const [ws, subs] of subscriptionsRef) {
      if (!subs.has(sessionId)) continue;
      const origin = origins.get(ws);
      if (!origin) continue;
      sawAny = true;
      if (!origin.remote) return 'local';
      sawRemote = true;
    }
  }
  if (sawAny) return sawRemote ? 'remote' : 'local';

  // Nobody is subscribed yet — answer for the bridge as a whole.
  for (const origin of origins.values()) {
    sawAny = true;
    if (!origin.remote) return 'local';
    sawRemote = true;
  }
  if (!sawAny) return 'none';
  return sawRemote ? 'remote' : 'local';
}

/**
 * Hostnames remote clients used to reach this bridge, most useful first.
 * `ui_forward_port` builds the URL it hands back from these — falling back to
 * the peer address only when no `Host` header made it through.
 */
export function remoteViewerHosts(): string[] {
  const hosts: string[] = [];
  const funnel: string[] = [];
  for (const origin of origins.values()) {
    if (!origin.remote) continue;
    const candidate = origin.host || origin.address;
    // Funnel only carries 443 → the bridge, so `host:<port>` from it opens
    // only on tailnet devices; rank it after names that route directly.
    const bucket = origin.route === 'tailscale-funnel' ? funnel : hosts;
    if (candidate && !hosts.includes(candidate) && !funnel.includes(candidate)) bucket.push(candidate);
  }
  return [...hosts, ...funnel];
}
