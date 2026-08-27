/**
 * Session-scoped port forwarding for remote viewers.
 *
 * When the browser runs on a different machine than the bridge (see
 * ./client-origin), anything the agent starts — a Vite dev server, a Storybook,
 * an API — binds to *this* machine's loopback and is invisible from there.
 * A forward is a plain TCP proxy: it binds `publicPort` on every interface and
 * pipes each connection to `targetHost:targetPort` locally, so the remote
 * browser can dial `http://<this-host>:<publicPort>`.
 *
 * Raw TCP on purpose — HTTP, WebSocket upgrades and TLS all pass through
 * untouched, which an HTTP-level reverse proxy would have to special-case.
 *
 * Forwards live in memory only. They belong to the process that owns the dev
 * servers behind them, so surviving a bridge restart would just leave open
 * ports pointing at nothing.
 *
 * Note this is an unauthenticated listener on 0.0.0.0 — that is the point (the
 * remote browser has to reach it), but it also means anyone who can route to
 * this machine can. Tool descriptions say so; keep it that way.
 */

import { createServer, connect, type Server, type Socket } from 'net';
import { randomUUID } from 'crypto';
import { log, logError } from '../lib/logger';

/** A live forward. Named to avoid colliding with the SSH-remote `PortForward`
 *  in ../types.ts, which describes something else entirely. */
export type SessionPortForward = {
  id: string;
  sessionId: string;
  /** Port on this machine traffic is delivered to. */
  targetPort: number;
  /** Interface the target is dialled on. Almost always loopback. */
  targetHost: string;
  /** Port bound on every interface — what a remote browser actually dials. */
  publicPort: number;
  label: string | null;
  createdAt: number;
  /** Cumulative accepted connections, for `ui_list_port_forwards`. */
  connections: number;
};

/** Thrown when `publicPort` cannot be bound. Carries the port so callers can
 *  render "already in use" without string-matching an error message. */
export class PortInUseError extends Error {
  readonly port: number;
  /** Set when *we* already forward this port, with the owning session id. */
  readonly heldBySessionId: string | null;

  constructor(port: number, heldBySessionId: string | null = null) {
    super(
      heldBySessionId
        ? `Port ${port} is already in use — this bridge is already forwarding it for session ${heldBySessionId}.`
        : `Port ${port} is already in use by another process on this machine.`,
    );
    this.name = 'PortInUseError';
    this.port = port;
    this.heldBySessionId = heldBySessionId;
  }
}

type Entry = {
  info: SessionPortForward;
  server: Server;
  /** Live client sockets, so closing a forward actually drops them instead of
   *  waiting for every keep-alive connection to end on its own. */
  sockets: Set<Socket>;
};

// Keyed by publicPort — a bound port is globally unique, which makes conflict
// detection a map lookup rather than a scan.
const forwards = new Map<number, Entry>();

const BIND_HOST = '0.0.0.0';

// Set by index.ts. Fires whenever a session's forwards change so the popover
// updates live — the agent opens most of these, not the user, so without this
// the UI would only ever be right after a manual refresh.
let onChange: ((sessionId: string) => void) | null = null;

export function setPortForwardListener(fn: ((sessionId: string) => void) | null): void {
  onChange = fn;
}

function notify(sessionId: string): void {
  try { onChange?.(sessionId); } catch (err) { logError(`[port-forward] listener threw: ${err}`); }
}

function assertValidPort(port: unknown, field: string): number {
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError(`${field} must be an integer between 1 and 65535 (got ${String(port)}).`);
  }
  return port;
}

/**
 * Resolve true if something is accepting connections on `host:port` right now.
 * Used as a warning, never a hard failure — a dev server that is still booting
 * is a normal reason for this to be false a second after the agent started it.
 */
export function isTargetListening(host: string, port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const sock = connect({ host, port });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch {}
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => finish(false));
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
  });
}

export type OpenPortForwardOptions = {
  sessionId: string;
  /** Local port the service is listening on. */
  targetPort: number;
  /** Interface to dial the service on. Defaults to loopback. */
  targetHost?: string;
  /**
   * Port to bind publicly. Omit to let the forward choose: it prefers
   * `targetPort` for a memorable URL and silently falls back to a free port
   * when that is taken. Pass one explicitly and a conflict is an error instead
   * — the caller asked for that number, so quietly using another would produce
   * a URL it did not expect.
   */
  publicPort?: number;
  label?: string | null;
};

/** Bind `server` on the public interface, translating errno into our errors. */
function listen(server: Server, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener('listening', onListening);
      if (err.code === 'EADDRINUSE') reject(new PortInUseError(port));
      else if (err.code === 'EACCES') {
        reject(new Error(`Cannot bind port ${port}: permission denied (ports below 1024 need root).`));
      } else reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, BIND_HOST);
  });
}

/**
 * Bind a public port and start piping it to `targetHost:targetPort`.
 * Throws `PortInUseError` when an explicitly requested public port is taken,
 * `RangeError` on a malformed port, and a plain Error for anything else
 * (EACCES on ports below 1024, etc).
 */
export async function openPortForward(opts: OpenPortForwardOptions): Promise<SessionPortForward> {
  const targetPort = assertValidPort(opts.targetPort, 'port');
  const targetHost = opts.targetHost?.trim() || '127.0.0.1';
  const explicitPort = opts.publicPort === undefined
    ? null
    : assertValidPort(opts.publicPort, 'public_port');
  const preferredPort = explicitPort ?? targetPort;

  const existing = forwards.get(preferredPort);
  if (existing) {
    if (explicitPort !== null) throw new PortInUseError(preferredPort, existing.info.sessionId);
  }

  const sockets = new Set<Socket>();
  // Mutated once the bind lands, since the chosen port may not be the
  // preferred one when we were left to pick.
  const info: SessionPortForward = {
    id: randomUUID(),
    sessionId: opts.sessionId,
    targetPort,
    targetHost,
    publicPort: preferredPort,
    label: opts.label?.trim() || null,
    createdAt: Date.now(),
    connections: 0,
  };

  const server = createServer((client) => {
    info.connections += 1;
    sockets.add(client);

    const upstream = connect({ host: targetHost, port: targetPort });
    sockets.add(upstream);

    const teardown = () => {
      sockets.delete(client);
      sockets.delete(upstream);
      client.destroy();
      upstream.destroy();
    };
    client.once('error', teardown);
    upstream.once('error', teardown);
    client.once('close', teardown);
    upstream.once('close', teardown);

    client.pipe(upstream);
    upstream.pipe(client);
  });

  const preferredTaken = existing !== undefined;
  if (preferredTaken) {
    // Already ours — skip straight to the fallback below.
    await listen(server, 0);
  } else {
    try {
      await listen(server, preferredPort);
    } catch (err) {
      // Mirroring the target port is only a nicety, and on Linux it fails
      // outright whenever the service holds the same number on loopback. When
      // the caller did not name a port, take any free one rather than refuse.
      if (explicitPort !== null || !(err instanceof PortInUseError)) throw err;
      await listen(server, 0);
    }
  }

  const address = server.address();
  info.publicPort = address && typeof address !== 'string' ? address.port : preferredPort;

  // Past the bind, a socket-level error must not take the process down.
  server.on('error', (err) => logError(`[port-forward] :${info.publicPort} server error: ${err}`));

  forwards.set(info.publicPort, { info, server, sockets });
  log(
    `[port-forward] ${opts.sessionId.slice(0, 8)} published ${BIND_HOST}:${info.publicPort}` +
      ` -> ${targetHost}:${targetPort}${info.label ? ` (${info.label})` : ''}`,
  );
  notify(opts.sessionId);
  return { ...info };
}

/** Every live forward, newest last. Pass a session id to scope it to one. */
export function listPortForwards(sessionId?: string): SessionPortForward[] {
  const all = [...forwards.values()].map(e => ({ ...e.info }));
  const scoped = sessionId ? all.filter(f => f.sessionId === sessionId) : all;
  return scoped.sort((a, b) => a.createdAt - b.createdAt);
}

export function getPortForward(publicPort: number): SessionPortForward | null {
  const entry = forwards.get(publicPort);
  return entry ? { ...entry.info } : null;
}

function destroy(entry: Entry): void {
  for (const sock of entry.sockets) {
    try { sock.destroy(); } catch {}
  }
  entry.sockets.clear();
  try { entry.server.close(); } catch {}
  forwards.delete(entry.info.publicPort);
}

/**
 * Take down the forward on `publicPort`. When `sessionId` is given, a forward
 * owned by a different session is left alone and this answers false — one
 * session must not close another's port by guessing a number.
 */
export function closePortForward(publicPort: number, sessionId?: string): boolean {
  const entry = forwards.get(publicPort);
  if (!entry) return false;
  if (sessionId && entry.info.sessionId !== sessionId) return false;
  const owner = entry.info.sessionId;
  destroy(entry);
  log(`[port-forward] closed :${publicPort}`);
  notify(owner);
  return true;
}

/** Drop every forward a session owns. Called when the session goes away. */
export function closeSessionPortForwards(sessionId: string): number {
  let closed = 0;
  for (const entry of [...forwards.values()]) {
    if (entry.info.sessionId !== sessionId) continue;
    destroy(entry);
    closed += 1;
  }
  if (closed) {
    log(`[port-forward] closed ${closed} forward(s) for session ${sessionId.slice(0, 8)}`);
    notify(sessionId);
  }
  return closed;
}

/** Drop every forward. Used on shutdown. */
export function closeAllPortForwards(): number {
  const count = forwards.size;
  for (const entry of [...forwards.values()]) destroy(entry);
  return count;
}
