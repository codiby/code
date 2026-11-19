/**
 * The window's SSH tunnels, run by the bridge.
 *
 * Electron used to run its own `ssh` masters (the former ssh_tunnel.ts). The
 * bridge now owns them (packages/core/handlers/remote-tunnels.ts), so they
 * run on the bridge's host with that host's SSH config — on a WSL base, the
 * distro. This module is the thin client the IPC handlers call; the renderer
 * still connects straight to `127.0.0.1:<port>`.
 */
import { logMain } from './diagnostics';
import { takeEvents } from './sse';

type Status = { status: string; lastError: string | null };
export type TunnelStatusEvent = Status & { remoteId: string; port: number | null };

let baseUrl: () => Promise<string> = async () => { throw new Error('bridge not configured'); };
export function configureBridgeTunnels(resolveBase: () => Promise<string>): void { baseUrl = resolveBase; }

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${await baseUrl()}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({})) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `${method} ${path} failed (${res.status})`);
  return data;
}

const tunnelPath = (remoteId: string, action: string) => `/remote-tunnels/${encodeURIComponent(remoteId)}/${action}`;

/** Refs this window holds, so quitting can give them back (the bridge outlives the window). */
const held = new Map<string, number>();

export async function acquireTunnel(remoteId: string): Promise<{ port: number }> {
  const out = await call<{ port: number }>('POST', tunnelPath(remoteId, 'acquire'));
  held.set(remoteId, (held.get(remoteId) ?? 0) + 1);
  return out;
}

export async function releaseTunnel(remoteId: string): Promise<void> {
  const n = held.get(remoteId) ?? 0;
  if (n <= 1) held.delete(remoteId); else held.set(remoteId, n - 1);
  await call('POST', tunnelPath(remoteId, 'release'));
}

/** Quitting: hand every ref back so the bridge's grace timer can close idle masters. */
export async function releaseAllTunnels(): Promise<void> {
  const refs = [...held.entries()];
  held.clear();
  await Promise.allSettled(refs.flatMap(([id, n]) => Array.from({ length: n }, () => call('POST', tunnelPath(id, 'release')))));
}

export const getTunnelStatus = (remoteId: string) => call<Status>('GET', tunnelPath(remoteId, 'status'));
export const disconnectTunnel = (remoteId: string) => call('POST', tunnelPath(remoteId, 'disconnect'));
export const probeRemoteHealth = (remoteId: string) =>
  call<{ ok: true; bridgeUp: true } | { ok: false; reason: string }>('POST', tunnelPath(remoteId, 'probe'));
export const addPortForward = (remoteId: string, remotePort: number, localPort: number | null, label?: string) =>
  call<{ localPort: number }>('POST', tunnelPath(remoteId, 'forwards'), { remotePort, localPort, label });
export const removePortForward = (remoteId: string, localPort: number, remotePort: number) =>
  call('DELETE', `${tunnelPath(remoteId, 'forwards')}?localPort=${localPort}&remotePort=${remotePort}`);
export const listActiveForwards = (remoteId: string) =>
  call<Array<{ localPort: number; remotePort: number }>>('GET', tunnelPath(remoteId, 'forwards'));

/**
 * Follow the bridge's tunnel status changes for as long as the app runs,
 * reconnecting when the bridge restarts. Returns a stop function.
 */
export function followTunnelStatus(onEvent: (e: TunnelStatusEvent) => void): () => void {
  let stopped = false;
  let ctrl: AbortController | null = null;
  void (async () => {
    let delay = 1000;
    while (!stopped) {
      ctrl = new AbortController();
      try {
        const res = await fetch(`${await baseUrl()}/remote-tunnels/events`, { signal: ctrl.signal });
        if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
        delay = 1000;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const parsed = takeEvents(buffer + decoder.decode(value, { stream: true }));
          buffer = parsed.rest;
          for (const raw of parsed.events) {
            try { onEvent(JSON.parse(raw) as TunnelStatusEvent); } catch {}
          }
        }
      } catch (e) {
        if (!stopped) logMain(`[tunnels] status stream: ${(e as Error).message}`);
      }
      if (stopped) break;
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(delay * 2, 15_000);
    }
  })();
  return () => { stopped = true; ctrl?.abort(); };
}
