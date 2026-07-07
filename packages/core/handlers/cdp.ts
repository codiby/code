/**
 * Chrome DevTools Protocol (CDP) proxy.
 *
 * Connects to Node.js debug targets (--inspect / --inspect-brk) and relays
 * CDP messages between frontend WebSocket clients and the debug target.
 */

import { log, logError } from '../lib/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DebugTarget {
  id: string;
  title: string;
  url: string;
  type: string;
  webSocketDebuggerUrl: string;
  devtoolsFrontendUrl?: string;
}

interface CdpConnection {
  id: string;
  host: string;
  port: number;
  targetId: string;
  ws: WebSocket;
  clients: Set<any>; // downstream browser WS connections
  connected: boolean;
}

const connections = new Map<string, CdpConnection>();

function connKey(host: string, port: number, targetId: string): string {
  return `${host}:${port}:${targetId}`;
}

// ---------------------------------------------------------------------------
// Target discovery
// ---------------------------------------------------------------------------

export async function discoverTargets(host: string, port: number): Promise<DebugTarget[]> {
  try {
    const resp = await fetch(`http://${host}:${port}/json`);
    if (!resp.ok) return [];
    return await resp.json() as DebugTarget[];
  } catch (e) {
    logError('CDP', `Failed to discover targets at ${host}:${port}: ${e}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

export async function connectToTarget(host: string, port: number, targetId?: string): Promise<CdpConnection | null> {
  // Discover targets to find the WebSocket URL
  const targets = await discoverTargets(host, port);
  if (targets.length === 0) {
    log(`[CDP] No debug targets found at ${host}:${port}`);
    return null;
  }

  const target = targetId ? targets.find(t => t.id === targetId) : targets[0];
  if (!target) {
    log(`[CDP] Target ${targetId} not found`);
    return null;
  }

  const key = connKey(host, port, target.id);
  const existing = connections.get(key);
  if (existing?.connected) return existing;

  // Clean up dead connection
  if (existing) connections.delete(key);

  log(`[CDP] Connecting to ${target.webSocketDebuggerUrl}`);

  try {
    const ws = new WebSocket(target.webSocketDebuggerUrl);

    const conn: CdpConnection = {
      id: key,
      host,
      port,
      targetId: target.id,
      ws,
      clients: new Set(),
      connected: false,
    };

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        conn.connected = true;
        log(`[CDP] Connected to target ${target.id} (${target.title})`);
        resolve();
      };
      ws.onerror = (e) => {
        logError('CDP', `WebSocket error: ${e}`);
        reject(new Error('CDP WebSocket connection failed'));
      };
    });

    ws.onmessage = (event) => {
      // Relay messages from debug target to all subscribed clients
      const data = typeof event.data === 'string' ? event.data : '';
      for (const client of conn.clients) {
        try { client.send(data); } catch {}
      }
    };

    ws.onclose = () => {
      log(`[CDP] Connection closed for target ${target.id}`);
      conn.connected = false;
      connections.delete(key);
      // Notify clients
      const closeMsg = JSON.stringify({ method: '_cdp.disconnected', params: { reason: 'target closed' } });
      for (const client of conn.clients) {
        try { client.send(closeMsg); } catch {}
      }
    };

    ws.onerror = () => {
      conn.connected = false;
    };

    connections.set(key, conn);
    return conn;
  } catch (e) {
    logError('CDP', `Failed to connect: ${e}`);
    return null;
  }
}

export function getConnection(connectionId: string): CdpConnection | undefined {
  return connections.get(connectionId);
}

export function disconnectTarget(connectionId: string) {
  const conn = connections.get(connectionId);
  if (!conn) return;
  log(`[CDP] Disconnecting from target ${conn.targetId}`);
  try { conn.ws.close(); } catch {}
  conn.connected = false;
  connections.delete(connectionId);
}

// ---------------------------------------------------------------------------
// Client management
// ---------------------------------------------------------------------------

export function addCdpClient(conn: CdpConnection, ws: any) {
  conn.clients.add(ws);
}

export function removeCdpClient(conn: CdpConnection, ws: any) {
  conn.clients.delete(ws);
}

/** Forward a CDP message from a browser client to the debug target */
export function sendCdpMessage(conn: CdpConnection, message: string) {
  if (conn.connected && conn.ws.readyState === WebSocket.OPEN) {
    conn.ws.send(message);
  }
}

/** Disconnect all CDP connections (for shutdown) */
export function disconnectAll() {
  for (const [id, conn] of connections) {
    try { conn.ws.close(); } catch {}
    connections.delete(id);
  }
}
