/**
 * The bridge owns the SSH tunnels to remotes; the window only asks for them.
 *
 * The desktop app used to run its own `ssh` masters from the Electron main
 * process. Now the bridge runs them on its own host, with that host's
 * `~/.ssh/config`, keys and agent — on a WSL base that is the distro, not
 * Windows. A tunnel's local port is bound on the bridge's host; the window
 * connects to `127.0.0.1:<port>` directly (WSL publishes the distro's
 * loopback listeners on Windows' localhost), so traffic takes no extra hop.
 *
 * These routes start processes and open ports, so they only answer a real
 * loopback connection (checked by the caller), never a bearer token.
 *
 *   POST   /remote-tunnels/:id/acquire     → { port }
 *   POST   /remote-tunnels/:id/release
 *   GET    /remote-tunnels/:id/status      → { status, lastError }
 *   POST   /remote-tunnels/:id/disconnect
 *   POST   /remote-tunnels/:id/probe       → probeRemoteHealth
 *   GET    /remote-tunnels/:id/forwards    → [{ localPort, remotePort }]
 *   POST   /remote-tunnels/:id/forwards    { remotePort, localPort?, label? } → { localPort }
 *   DELETE /remote-tunnels/:id/forwards?localPort=&remotePort=
 *   GET    /remote-tunnels/events          → text/event-stream of { remoteId, status, lastError, port }
 */

import { corsHeaders } from '../config/config';
import {
  acquireTunnel, addPortForward, disconnectTunnel, getTunnelLocalPort, getTunnelStatus,
  listActiveForwards, onTunnelStatus, probeRemoteHealth, releaseTunnel, removePortForward,
} from '../network/ssh-tunnel';

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: corsHeaders });

/** One status change as the window consumes it: the port rides along because
 *  it changes whenever an ssh master respawns. */
export interface TunnelStatusEvent { remoteId: string; status: string; lastError: string | null; port: number | null }

function events(req: Request): Response {
  const encoder = new TextEncoder();
  let stop = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => { try { controller.enqueue(encoder.encode(chunk)); } catch { stop(); } };
      const off = onTunnelStatus((remoteId, status, lastError) => {
        const event: TunnelStatusEvent = { remoteId, status, lastError, port: getTunnelLocalPort(remoteId) };
        send(`data: ${JSON.stringify(event)}\n\n`);
      });
      // A comment line every 25 s keeps idle connections from being reaped.
      const ping = setInterval(() => send(': ping\n\n'), 25_000);
      stop = () => { off(); clearInterval(ping); };
      req.signal.addEventListener('abort', () => { stop(); try { controller.close(); } catch {} });
      send(': ok\n\n');
    },
    cancel() { stop(); },
  });
  return new Response(stream, {
    headers: { ...corsHeaders, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
  });
}

/** Answers `/remote-tunnels/*`, or returns null for any other path. */
export async function handleRemoteTunnels(req: Request, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith('/remote-tunnels/')) return null;
  if (url.pathname === '/remote-tunnels/events' && req.method === 'GET') return events(req);

  const m = url.pathname.match(/^\/remote-tunnels\/([^/]+)\/(acquire|release|status|disconnect|probe|forwards)$/);
  if (!m) return json({ error: 'Not found' }, 404);
  const remoteId = decodeURIComponent(m[1]!);
  const action = m[2]!;

  try {
    switch (`${req.method} ${action}`) {
      case 'POST acquire': {
        const { localTunnelPort } = await acquireTunnel(remoteId);
        return json({ port: localTunnelPort });
      }
      case 'POST release':
        releaseTunnel(remoteId);
        return json({ ok: true });
      case 'GET status':
        return json(getTunnelStatus(remoteId));
      case 'POST disconnect':
        await disconnectTunnel(remoteId);
        return json({ ok: true });
      case 'POST probe':
        return json(await probeRemoteHealth(remoteId));
      case 'GET forwards':
        return json(listActiveForwards(remoteId));
      case 'POST forwards': {
        const body = await req.json().catch(() => ({})) as { remotePort?: unknown; localPort?: unknown; label?: unknown };
        const remotePort = Number(body.remotePort);
        if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) return json({ error: 'remotePort must be a port number' }, 400);
        const localPort = body.localPort == null ? null : Number(body.localPort);
        if (localPort !== null && (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535)) return json({ error: 'localPort must be a port number' }, 400);
        return json(await addPortForward(remoteId, remotePort, localPort, typeof body.label === 'string' ? body.label : undefined));
      }
      case 'DELETE forwards': {
        const localPort = Number(url.searchParams.get('localPort'));
        const remotePort = Number(url.searchParams.get('remotePort'));
        if (!Number.isInteger(localPort) || !Number.isInteger(remotePort)) return json({ error: 'localPort and remotePort are required' }, 400);
        await removePortForward(remoteId, localPort, remotePort);
        return json({ ok: true });
      }
      default:
        return json({ error: `${req.method} not allowed` }, 405);
    }
  } catch (e) {
    return json({ error: (e as Error).message || String(e) }, 500);
  }
}
