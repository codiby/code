/**
 * Gateway — the local bun server acts as a hub that proxies HTTP + WS for
 * sessions that live on a remote (Modelo D in REMOTES_TASKS.md).
 *
 * Resolution: each session is either local (in the `sessions` Map) or remote
 * (in `remoteSessionsIndex`, hydrated from `~/.codiby/ui-remote-sessions/`).
 * Once we know a `sessionId` is remote, we acquire the tunnel for its remote,
 * pick the locally-bound proxy port, and forward.
 *
 * HTTP: rewrite host+port, replay method/headers/body, return the response.
 * WS:   accept the upgrade locally, open a parallel WS to the remote bridge
 *       through the tunnel, then shovel bytes in both directions.
 */

import type { ServerWebSocket } from 'bun';
import { readdirSync } from 'fs';
import { log, logError } from './logger';
import { remotes } from './remotes';
import {
  REMOTE_SESSIONS_DIR,
  loadRemoteSessions,
  saveRemoteSessions,
  upsertRemoteSession,
  removeCachedRemoteSession,
  setCachedRemoteSessionStatus,
  type CachedRemoteSession,
} from './remote-sessions-cache';
import { loadRemoteGroups, saveRemoteGroups, type RemoteGroups } from './remote-groups-cache';
import { acquireTunnel, releaseTunnel, getTunnelLocalPort } from './ssh-tunnel';

// ---------------------------------------------------------------------------
// sessionId → remoteId index. Hydrated at startup from cache files.
// ---------------------------------------------------------------------------

const remoteSessionsIndex = new Map<string, string>();

export function hydrateRemoteSessionsIndex() {
  remoteSessionsIndex.clear();
  let total = 0;
  try {
    const files = readdirSync(REMOTE_SESSIONS_DIR);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const remoteId = f.slice(0, -'.json'.length);
      if (!remotes.has(remoteId)) continue; // stale cache for a removed remote
      const list = loadRemoteSessions(remoteId);
      for (const s of list) {
        remoteSessionsIndex.set(s.id, remoteId);
        total++;
      }
    }
  } catch {
    // Directory doesn't exist yet — fine.
  }
  log(`[gateway] hydrated index with ${total} remote sessions across ${remotes.size} remotes`);
}

export function resolveSessionRemote(sessionId: string): string | null {
  return remoteSessionsIndex.get(sessionId) ?? null;
}

export function registerRemoteSession(remoteId: string, entry: CachedRemoteSession) {
  remoteSessionsIndex.set(entry.id, remoteId);
  upsertRemoteSession(remoteId, entry);
}

export function unregisterRemoteSession(remoteId: string, sessionId: string) {
  remoteSessionsIndex.delete(sessionId);
  removeCachedRemoteSession(remoteId, sessionId);
}

/** Offline fallback for archive/unarchive: patch the cached UI status without
 *  reaching the remote. Returns true if the cached entry existed. */
export function setRemoteSessionStatusLocally(
  remoteId: string,
  sessionId: string,
  status: 'open' | 'archived',
): boolean {
  return setCachedRemoteSessionStatus(remoteId, sessionId, status);
}

export function listAllCachedRemoteSessions(): Array<CachedRemoteSession & { remoteId: string }> {
  const out: Array<CachedRemoteSession & { remoteId: string }> = [];
  for (const remoteId of remotes.keys()) {
    for (const s of loadRemoteSessions(remoteId)) {
      out.push({ ...s, remoteId });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Remote session reconciliation (pull)
//
// The remote owns its session list. Sessions spawned *on* the remote (e.g. an
// agent there calling `ui_spawn_session`) never touch our local cache, so the
// desktop client never sees them. We reconcile by pulling the remote's
// authoritative `GET /sessions` and overwriting our cache for that remote —
// this also reaps sessions deleted remotely, not just adds new ones.
// ---------------------------------------------------------------------------

/** Pull the remote's session list over the tunnel and overwrite the local
 *  cache for `remoteId`. Returns true if the cache actually changed. */
export async function refreshRemoteSessions(remoteId: string): Promise<boolean> {
  if (!remotes.has(remoteId)) return false;
  try {
    const resp = await proxyHttpToRemote(
      new Request('http://local/sessions', { method: 'GET' }),
      remoteId,
      '/sessions',
    );
    if (!resp.ok) return false;
    const list = (await resp.json()) as any[];
    if (!Array.isArray(list)) return false;
    // Keep only the remote's own local sessions — ignore its remote-of-remote
    // rows so we don't mirror a third machine's sessions under this remote.
    const mapped: CachedRemoteSession[] = list
      .filter((s) => !s.remoteId)
      .map((s) => ({
        id: s.id,
        name: s.name,
        cwd: s.cwd,
        createdAt: s.created_at,
        status: s.status ?? 'open',
        runtimeStatus: s.runtime_status ?? 'running',
        model: s.model ?? null,
        permissionMode: s.permission_mode ?? 'default',
        provider: s.provider ?? 'claudeAgent',
        claudeSessionId: s.claude_session_id ?? null,
        portForwards: [],
        cachedAt: Date.now(),
      }));

    const prev = loadRemoteSessions(remoteId);
    saveRemoteSessions(remoteId, mapped);
    // Rebuild this remote's slice of the id→remote index.
    for (const [sid, rid] of remoteSessionsIndex) {
      if (rid === remoteId) remoteSessionsIndex.delete(sid);
    }
    for (const s of mapped) remoteSessionsIndex.set(s.id, remoteId);

    // Cheap change detection so callers can skip a needless broadcast.
    const sig = (l: CachedRemoteSession[]) =>
      l.map((s) => `${s.id}:${s.name}:${s.status}:${s.runtimeStatus}`).sort().join('|');
    return sig(prev) !== sig(mapped);
  } catch (e) {
    logError(`[gateway] refreshRemoteSessions ${remoteId} failed: ${e}`);
    return false;
  }
}

/** Pull the remote's tab-group metadata (`GET /preferences`) and cache the
 *  subset its own sessions reference, so remote sessions group correctly in
 *  the local sidebar. Call *after* refreshRemoteSessions so the session list
 *  it filters against is current. Returns true if the cache changed. */
export async function refreshRemoteGroups(remoteId: string): Promise<boolean> {
  if (!remotes.has(remoteId)) return false;
  try {
    const resp = await proxyHttpToRemote(
      new Request('http://local/preferences', { method: 'GET' }),
      remoteId,
      '/preferences',
    );
    if (!resp.ok) return false;
    const prefs = (await resp.json()) as any;
    const allGroups = (prefs?.tabGroups ?? {}) as Record<string, unknown>;
    const allMap = (prefs?.tabGroupMap ?? {}) as Record<string, unknown>;

    // Restrict to this remote's own sessions — never mirror its remote-of-
    // remote group rows.
    const sessionIds = new Set(loadRemoteSessions(remoteId).map((s) => s.id));
    const tabGroupMap: Record<string, string> = {};
    const usedGroupIds = new Set<string>();
    for (const [sid, gid] of Object.entries(allMap)) {
      if (sessionIds.has(sid) && typeof gid === 'string') {
        tabGroupMap[sid] = gid;
        usedGroupIds.add(gid);
      }
    }
    const tabGroups: Record<string, unknown> = {};
    for (const gid of usedGroupIds) {
      if (allGroups[gid]) tabGroups[gid] = allGroups[gid];
    }

    const next: RemoteGroups = { tabGroups, tabGroupMap };
    const prevSig = JSON.stringify(loadRemoteGroups(remoteId));
    saveRemoteGroups(remoteId, next);
    return prevSig !== JSON.stringify(next);
  } catch (e) {
    logError(`[gateway] refreshRemoteGroups ${remoteId} failed: ${e}`);
    return false;
  }
}

/** Pull both a remote's session list and its group metadata. Returns true if
 *  either changed (i.e. the local sidebar should repaint). */
export async function reconcileRemote(remoteId: string): Promise<boolean> {
  const sessionsChanged = await refreshRemoteSessions(remoteId);
  const groupsChanged = await refreshRemoteGroups(remoteId);
  return sessionsChanged || groupsChanged;
}

// Local broadcaster, injected by index.ts to avoid a circular import.
let broadcastSessions: (() => void) | null = null;
export function setSessionListBroadcaster(fn: () => void) {
  broadcastSessions = fn;
}

// Debounced refresh — coalesces the burst of `sessions` frames a remote emits
// around a single spawn into one pull a few seconds later, then repaints the
// local sidebar if anything changed.
const refreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
export function scheduleRemoteRefresh(remoteId: string, delayMs = 3000) {
  const existing = refreshTimers.get(remoteId);
  if (existing) clearTimeout(existing);
  refreshTimers.set(
    remoteId,
    setTimeout(async () => {
      refreshTimers.delete(remoteId);
      if (await reconcileRemote(remoteId)) broadcastSessions?.();
    }, delayMs),
  );
}

// ---------------------------------------------------------------------------
// HTTP proxy
// ---------------------------------------------------------------------------

/**
 * Open the tunnel (without ref-counting — HTTP requests are short-lived) and
 * forward the request to the remote bun bridge.
 *
 * The caller passes a path/search string that should land on the remote.
 * Defaults to the incoming URL's pathname + search, which works for any
 * 1:1 endpoint that exists on both local and remote bun.
 */
export async function proxyHttpToRemote(
  req: Request,
  remoteId: string,
  pathOverride?: string,
): Promise<Response> {
  let localPort: number | null = getTunnelLocalPort(remoteId);
  if (localPort == null) {
    // Tunnel not up — bring it up transiently. We bump+drop the refcount so
    // the tunnel won't be torn down mid-request by a stray grace timer.
    const { localTunnelPort } = await acquireTunnel(remoteId);
    localPort = localTunnelPort;
    // We hand off the refcount asynchronously after the response settles.
    try {
      return await doProxyHttp(req, localPort, pathOverride);
    } finally {
      releaseTunnel(remoteId);
    }
  }
  return doProxyHttp(req, localPort, pathOverride);
}

async function doProxyHttp(req: Request, localPort: number, pathOverride?: string): Promise<Response> {
  const original = new URL(req.url);
  const path = pathOverride ?? (original.pathname + original.search);
  const target = `http://127.0.0.1:${localPort}${path}`;

  // Drop hop-by-hop headers; replay everything else (Authorization,
  // Content-Type, custom X-* headers like `x-codiby-remote`).
  const headers = new Headers();
  req.headers.forEach((v, k) => {
    const lk = k.toLowerCase();
    if (lk === 'host' || lk === 'connection' || lk === 'content-length') return;
    headers.set(k, v);
  });

  const init: RequestInit & { duplex?: 'half' } = {
    method: req.method,
    headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer(),
  };

  try {
    const upstream = await fetch(target, init);
    // Replay status + headers as-is.
    const respHeaders = new Headers(upstream.headers);
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: respHeaders,
    });
  } catch (e: any) {
    logError(`[gateway] proxy ${req.method} ${target} failed: ${e?.message || e}`);
    return Response.json({ error: 'Gateway: remote unreachable', detail: String(e?.message || e) }, { status: 502 });
  }
}

// ---------------------------------------------------------------------------
// WebSocket proxy
// ---------------------------------------------------------------------------

/**
 * Open an outbound WS connection to the remote bridge and wire it
 * bidirectionally to the local client ws. Stored on `ws.data.remoteSocket`
 * so the close handler can shut it down.
 */
export async function startWsProxy(
  ws: ServerWebSocket<any>,
  remoteId: string,
  path: string,
): Promise<void> {
  const data = ws.data as {
    remoteId: string;
    remoteSocket?: WebSocket;
    proxyClosed?: boolean;
    refcountHeld?: boolean;
  };
  data.remoteId = remoteId;
  data.proxyClosed = false;

  let localPort: number;
  try {
    const acquired = await acquireTunnel(remoteId);
    localPort = acquired.localTunnelPort;
    data.refcountHeld = true;
  } catch (e: any) {
    try { ws.send(JSON.stringify({ type: 'gateway.error', error: e?.message || String(e) })); } catch {}
    try { ws.close(4011, 'Tunnel unavailable'); } catch {}
    return;
  }

  const remoteUrl = `ws://127.0.0.1:${localPort}${path}`;
  let outbound: WebSocket;
  try {
    outbound = new WebSocket(remoteUrl);
  } catch (e: any) {
    if (data.refcountHeld) {
      releaseTunnel(remoteId);
      data.refcountHeld = false;
    }
    try { ws.close(4012, `Cannot open WS to remote (${e?.message || e})`); } catch {}
    return;
  }

  data.remoteSocket = outbound;
  outbound.binaryType = 'arraybuffer';

  outbound.addEventListener('open', () => {
    log(`[gateway] WS open ${remoteUrl}`);
  });
  outbound.addEventListener('message', (ev) => {
    if (data.proxyClosed) return;
    try {
      ws.send(ev.data as any);
    } catch {}
  });
  outbound.addEventListener('close', (ev) => {
    if (data.proxyClosed) return;
    data.proxyClosed = true;
    try { ws.close(ev.code || 1000, ev.reason || 'Remote WS closed'); } catch {}
    if (data.refcountHeld) {
      releaseTunnel(remoteId);
      data.refcountHeld = false;
    }
  });
  outbound.addEventListener('error', (ev) => {
    log(`[gateway] WS error → ${remoteUrl}: ${(ev as any)?.message || 'unknown'}`);
  });
}

/** Forward a message from the local client to the remote WS. */
export function relayWsMessage(ws: ServerWebSocket<any>, message: string | Buffer | ArrayBuffer) {
  const data = ws.data as { remoteSocket?: WebSocket; proxyClosed?: boolean };
  const out = data.remoteSocket;
  if (!out || data.proxyClosed) return;
  if (out.readyState !== WebSocket.OPEN) return;
  try {
    if (typeof message === 'string') out.send(message);
    else if (message instanceof ArrayBuffer) out.send(message);
    else out.send(new Uint8Array(message).buffer); // Buffer → ArrayBuffer
  } catch {}
}

// ---------------------------------------------------------------------------
// Multiplexed frontend WS proxy for remote sessions
//
// The frontend opens a single `/ws` connection to the local bridge and
// expects all session-keyed messages to round-trip there — local AND remote.
// For each remote session it subscribes to, we lazily open one outbound
// `/ws` to that remote's bridge (per local-ws), forward subscribe/send_message
// /etc. there, and relay all messages tagged with a sessionId back to the
// frontend. Without this, remote sessions never get a `status` or `init_info`
// and the UI hangs on "waiting for connection".
// ---------------------------------------------------------------------------

type RemoteFrontendData = {
  remoteFrontendSockets?: Map<string, WebSocket>;
  remoteFrontendPending?: Map<string, Promise<WebSocket>>;
  remoteFrontendQueues?: Map<string, string[]>;
  /** Set of sessionIds the frontend ws has subscribed to over each outbound,
   *  used to filter inbound messages so we don't relay unrelated broadcasts
   *  (the remote bridge also emits `preferences`, `sessions`, etc.). */
  remoteFrontendSubs?: Map<string, Set<string>>;
};

/** Lazily open (or reuse) an outbound `/ws` to the named remote, anchored on
 *  the given local frontend ws. Inbound messages are filtered to the set of
 *  remote sessionIds this frontend ws has subscribed to via the proxy. */
async function getOrOpenRemoteFrontendWs(
  ws: ServerWebSocket<any>,
  remoteId: string,
): Promise<WebSocket> {
  const data = ws.data as RemoteFrontendData;
  data.remoteFrontendSockets ||= new Map();
  data.remoteFrontendPending ||= new Map();
  data.remoteFrontendQueues ||= new Map();
  data.remoteFrontendSubs ||= new Map();

  const existing = data.remoteFrontendSockets.get(remoteId);
  if (existing && existing.readyState === WebSocket.OPEN) return existing;

  const inflight = data.remoteFrontendPending.get(remoteId);
  if (inflight) return inflight;

  const pending = (async (): Promise<WebSocket> => {
    const { localTunnelPort } = await acquireTunnel(remoteId);
    const url = `ws://127.0.0.1:${localTunnelPort}/ws`;
    const out = new WebSocket(url);
    out.binaryType = 'arraybuffer';

    await new Promise<void>((resolve, reject) => {
      out.addEventListener('open', () => resolve(), { once: true });
      out.addEventListener('error', () => reject(new Error(`Failed to connect to ${url}`)), { once: true });
      out.addEventListener('close', () => reject(new Error(`Closed before open: ${url}`)), { once: true });
    });

    log(`[gateway] frontend-ws → remote ${remoteId.slice(0, 12)} open`);

    out.addEventListener('message', (ev) => {
      let msg: any;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer)); }
      catch { return; }
      // Filter: only relay messages whose sessionId is one this frontend ws
      // has subscribed to via this outbound. Drops the remote's unrelated
      // broadcasts (welcome/preferences/sessions/etc.) so they don't clobber
      // the local app's state.
      const subs = data.remoteFrontendSubs!.get(remoteId);
      const sid = msg?.sessionId;
      if (typeof sid === 'string' && subs?.has(sid)) {
        try { ws.send(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer)); }
        catch {}
      } else if (msg?.type === 'sessions') {
        // The remote re-broadcasts its full session list whenever it changes
        // (e.g. an agent there spawned a session). We don't forward the frame
        // — the local app's state is owned by *our* broadcastSessionList — but
        // we use it as a trigger to pull the remote's list into our cache a
        // few seconds later, so remote-spawned sessions surface in the sidebar.
        scheduleRemoteRefresh(remoteId);
      }
    });

    out.addEventListener('close', () => {
      log(`[gateway] frontend-ws → remote ${remoteId.slice(0, 12)} closed`);
      data.remoteFrontendSockets!.delete(remoteId);
      releaseTunnel(remoteId);
    });

    data.remoteFrontendSockets!.set(remoteId, out);
    data.remoteFrontendPending!.delete(remoteId);

    // Drain any messages that arrived while we were dialing.
    const queue = data.remoteFrontendQueues!.get(remoteId);
    if (queue?.length) {
      for (const msg of queue) {
        try { out.send(msg); } catch {}
      }
      data.remoteFrontendQueues!.delete(remoteId);
    }
    return out;
  })();

  data.remoteFrontendPending.set(remoteId, pending);
  pending.catch(() => {
    data.remoteFrontendPending!.delete(remoteId);
  });
  return pending;
}

/** Forward a frontend-issued message to the remote bridge that hosts the
 *  given sessionId. Tracks subscriptions so inbound messages are correctly
 *  routed back. Returns true if forwarded (caller should not handle locally). */
export async function proxyFrontendWsMessage(
  ws: ServerWebSocket<any>,
  remoteId: string,
  msg: any,
  rawText: string,
): Promise<boolean> {
  const data = ws.data as RemoteFrontendData;
  data.remoteFrontendSubs ||= new Map();
  if (msg?.type === 'subscribe' && typeof msg.sessionId === 'string') {
    let set = data.remoteFrontendSubs.get(remoteId);
    if (!set) { set = new Set(); data.remoteFrontendSubs.set(remoteId, set); }
    set.add(msg.sessionId);
  } else if (msg?.type === 'unsubscribe' && typeof msg.sessionId === 'string') {
    data.remoteFrontendSubs.get(remoteId)?.delete(msg.sessionId);
  }

  let out: WebSocket;
  try {
    out = await getOrOpenRemoteFrontendWs(ws, remoteId);
  } catch (e: any) {
    log(`[gateway] frontend-ws → remote ${remoteId.slice(0, 12)} dial failed: ${e?.message || e}`);
    // An unreachable remote is a connectivity condition (laptop asleep, tunnel
    // down), not a session error — surface it as `disconnected` so the tab
    // shows neutral/idle instead of a red error dot. Without this every session
    // on an offline remote turns red the moment we try to (re)subscribe.
    try {
      ws.send(JSON.stringify({
        type: 'status',
        sessionId: msg?.sessionId,
        status: 'disconnected',
        error: `Remote unreachable: ${e?.message || e}`,
      }));
    } catch {}
    return true;
  }

  if (out.readyState === WebSocket.CONNECTING) {
    // Buffer; getOrOpenRemoteFrontendWs drains the queue on open.
    data.remoteFrontendQueues ||= new Map();
    const q = data.remoteFrontendQueues.get(remoteId) ?? [];
    q.push(rawText);
    data.remoteFrontendQueues.set(remoteId, q);
  } else if (out.readyState === WebSocket.OPEN) {
    try { out.send(rawText); } catch {}
  }
  return true;
}

/** Close every outbound /ws this frontend ws had opened. Called when the
 *  frontend disconnects so we don't leak refcounts or sockets. */
export function closeFrontendRemoteSockets(ws: ServerWebSocket<any>) {
  const data = ws.data as RemoteFrontendData;
  if (!data.remoteFrontendSockets) return;
  for (const [, out] of data.remoteFrontendSockets) {
    try { out.close(); } catch {}
  }
  data.remoteFrontendSockets.clear();
  data.remoteFrontendSubs?.clear();
  data.remoteFrontendQueues?.clear();
  data.remoteFrontendPending?.clear();
}

/** Tear down the outbound WS and drop the tunnel refcount. */
export function closeWsProxy(ws: ServerWebSocket<any>) {
  const data = ws.data as {
    remoteId?: string;
    remoteSocket?: WebSocket;
    proxyClosed?: boolean;
    refcountHeld?: boolean;
  };
  if (data.proxyClosed) {
    if (data.refcountHeld && data.remoteId) {
      releaseTunnel(data.remoteId);
      data.refcountHeld = false;
    }
    return;
  }
  data.proxyClosed = true;
  try { data.remoteSocket?.close(1000, 'Client disconnected'); } catch {}
  if (data.refcountHeld && data.remoteId) {
    releaseTunnel(data.remoteId);
    data.refcountHeld = false;
  }
}
