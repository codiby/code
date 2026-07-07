/**
 * SSH ControlMaster tunnel manager — Electron main process.
 *
 * Ported from server/ssh-tunnel.ts. Ownership of the SSH tunnels moved from
 * the bun sidecar into the Electron main process: main spawns one persistent
 * `ssh -N -M` master per remote (forwarding a free local port → the remote's
 * bun bridge port), and the renderer connects DIRECTLY to that local port for
 * every request/WS of sessions belonging to that remote. bun no longer proxies.
 *
 * The master also holds a UNIX control socket so per-session port forwards can
 * be attached/cancelled without re-authenticating (`ssh -O forward|cancel`).
 *
 * Lifecycle: lazy + ref-counted. `acquireTunnel(remoteId)` brings a master up
 * on first use and returns its local port; `releaseTunnel` decrements the
 * refcount and, at zero, closes the master after a 5-minute grace window.
 * Unexpected master death with active refs → reconnect with backoff.
 *
 * Auth: the user's ~/.ssh/config resolves User/Port/IdentityFile/ProxyJump for
 * the alias; ssh-agent supplies the key. We never prompt (`BatchMode=yes`).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { mkdirSync, existsSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { logMain } from './diagnostics';
import { getRemote, CODIBY_DIR } from './remotes';

const log = (msg: string) => logMain(msg);

export type TunnelStatus = 'idle' | 'connecting' | 'online' | 'reconnecting' | 'offline';

interface TunnelState {
  remoteId: string;
  status: TunnelStatus;
  master: ChildProcess | null;
  controlSocket: string;
  localTunnelPort: number | null;
  lastError: string | null;
  paneRefcount: number;
  graceTimer: NodeJS.Timeout | null;
  reconnectAttempt: number;
  reconnectTimer: NodeJS.Timeout | null;
  activeForwards: Map<string, { localPort: number; remotePort: number; label?: string }>;
  pendingReady: Array<{ resolve: (state: TunnelState) => void; reject: (e: Error) => void }>;
  /** Single-flight guard: set while a master spawn is in progress so neither a
   *  concurrent acquire nor the reconnect timer launches a second `ssh` master
   *  racing for the same control socket. */
  spawnInFlight: Promise<void> | null;
}

const tunnels = new Map<string, TunnelState>();

const CONTROL_DIR = join(CODIBY_DIR, 'ssh-control');
const GRACE_MS = 5 * 60 * 1000;
const BACKOFF_SEQ_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 60_000];

// ---------------------------------------------------------------------------
// Status event bus
// ---------------------------------------------------------------------------

type StatusListener = (remoteId: string, status: TunnelStatus, lastError: string | null) => void;
const statusListeners = new Set<StatusListener>();

export function onTunnelStatus(cb: StatusListener): () => void {
  statusListeners.add(cb);
  return () => statusListeners.delete(cb);
}

function emitStatus(state: TunnelState) {
  for (const cb of statusListeners) {
    try { cb(state.remoteId, state.status, state.lastError); } catch {}
  }
}

function setStatus(state: TunnelState, status: TunnelStatus, lastError: string | null = state.lastError) {
  if (state.status === status && state.lastError === lastError) return;
  state.status = status;
  state.lastError = lastError;
  emitStatus(state);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureControlDir() {
  try { mkdirSync(CONTROL_DIR, { recursive: true }); } catch {}
}

function controlSocketFor(remoteId: string): string {
  return join(CONTROL_DIR, `${remoteId}.sock`);
}

/** Pick an unused local TCP port by binding to :0 and reading the assigned port. */
function pickFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close();
        reject(new Error('Could not bind a free port'));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

/** Resolve true if the given local TCP port can be bound (i.e. is free). */
function isPortFree(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true));
    });
  });
}

/** Wait until something is listening on 127.0.0.1:<port> (the forward is ready). */
function waitForPort(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise<void>((resolve, reject) => {
    const attempt = () => {
      const sock = connect(port, '127.0.0.1');
      let done = false;
      const finish = (ok: boolean, err?: Error) => {
        if (done) return;
        done = true;
        try { sock.destroy(); } catch {}
        if (ok) resolve();
        else if (Date.now() > deadline) reject(err || new Error('Tunnel ready timeout'));
        else setTimeout(attempt, 200);
      };
      sock.once('connect', () => finish(true));
      sock.once('error', (e: Error) => finish(false, e));
    };
    attempt();
  });
}

function getOrCreateState(remoteId: string): TunnelState {
  let state = tunnels.get(remoteId);
  if (!state) {
    state = {
      remoteId,
      status: 'idle',
      master: null,
      controlSocket: controlSocketFor(remoteId),
      localTunnelPort: null,
      lastError: null,
      paneRefcount: 0,
      graceTimer: null,
      reconnectAttempt: 0,
      reconnectTimer: null,
      activeForwards: new Map(),
      pendingReady: [],
      spawnInFlight: null,
    };
    tunnels.set(remoteId, state);
  }
  return state;
}

/** Parse common ssh stderr lines into a friendly message. */
function classifySshError(stderr: string): string {
  const s = stderr.toLowerCase();
  if (s.includes('permission denied')) return 'Permission denied — check ssh-agent or IdentityFile.';
  if (s.includes('could not resolve hostname')) return 'Host not found — check the alias in ~/.ssh/config.';
  if (s.includes('connection refused')) return 'Connection refused — is sshd running on the remote?';
  if (s.includes('connection timed out') || s.includes('operation timed out')) return 'Connection timed out.';
  if (s.includes('host key verification failed')) return 'Host key changed — verify the remote, then remove the stale entry from known_hosts.';
  if (s.includes('no such file') && s.includes('config')) return 'Missing ~/.ssh/config entry.';
  return stderr.split('\n').find((l) => l.trim()) || 'SSH master exited.';
}

// ---------------------------------------------------------------------------
// Spawn / health
// ---------------------------------------------------------------------------

async function spawnMaster(state: TunnelState): Promise<void> {
  // Defensive: never launch a second master while one is already alive.
  if (state.master) return;
  const remote = getRemote(state.remoteId);
  if (!remote) throw new Error(`Remote ${state.remoteId} not found`);

  ensureControlDir();
  try { if (existsSync(state.controlSocket)) unlinkSync(state.controlSocket); } catch {}

  const localPort = await pickFreePort();
  state.localTunnelPort = localPort;

  const args = [
    '-N',
    '-M', '-S', state.controlSocket,
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10', // fail fast when the remote is unreachable
    '-L', `${localPort}:localhost:${remote.bunPort}`,
    remote.alias,
  ];

  log(`[ssh-tunnel:${remote.name}] spawn ssh ${args.join(' ')}`);
  const proc = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  state.master = proc;

  let stderrBuf = '';
  proc.stderr?.on('data', (chunk) => {
    const s = chunk.toString();
    stderrBuf += s;
    if (stderrBuf.length > 4_000) stderrBuf = stderrBuf.slice(-4_000);
  });

  proc.on('exit', (code, signal) => {
    const wasOnline = state.status === 'online';
    state.master = null;
    state.activeForwards.clear();
    state.localTunnelPort = null;
    const err = code === 0 || signal === 'SIGTERM' ? null : classifySshError(stderrBuf);
    log(`[ssh-tunnel:${remote.name}] master exited code=${code} signal=${signal}${stderrBuf ? ` stderr=${JSON.stringify(stderrBuf.slice(-800))}` : ' (no stderr)'}`);
    while (state.pendingReady.length) {
      const w = state.pendingReady.shift()!;
      w.reject(new Error(err || 'SSH master exited before tunnel was ready.'));
    }
    if (state.paneRefcount > 0 && signal !== 'SIGTERM') {
      setStatus(state, 'reconnecting', err);
      scheduleReconnect(state);
    } else {
      setStatus(state, wasOnline && signal === 'SIGTERM' ? 'idle' : 'offline', err);
    }
  });

  await waitForPort(localPort, 15_000);
  state.reconnectAttempt = 0;
  setStatus(state, 'online', null);
  while (state.pendingReady.length) {
    const w = state.pendingReady.shift()!;
    w.resolve(state);
  }
}

/** Launch a master, but only ever one at a time (single-flight). Both the
 *  acquire path and the reconnect timer funnel through here so they can never
 *  race two `ssh` processes onto the same control socket. */
function ensureSpawn(state: TunnelState): Promise<void> {
  if (state.spawnInFlight) return state.spawnInFlight;
  if (state.master) return Promise.resolve();
  const p = spawnMaster(state).finally(() => { state.spawnInFlight = null; });
  state.spawnInFlight = p;
  return p;
}

function scheduleReconnect(state: TunnelState) {
  if (state.reconnectTimer) return;
  const delay = BACKOFF_SEQ_MS[Math.min(state.reconnectAttempt, BACKOFF_SEQ_MS.length - 1)];
  state.reconnectAttempt++;
  log(`[ssh-tunnel:${state.remoteId}] reconnect attempt ${state.reconnectAttempt} in ${delay}ms`);
  state.reconnectTimer = setTimeout(async () => {
    state.reconnectTimer = null;
    if (state.paneRefcount === 0) {
      setStatus(state, 'idle', state.lastError);
      return;
    }
    // Someone already brought a master up (or is bringing one up) — don't race.
    if (state.master || state.spawnInFlight) return;
    setStatus(state, 'connecting', state.lastError);
    try {
      await ensureSpawn(state);
    } catch (e: any) {
      setStatus(state, 'reconnecting', e?.message || String(e));
      scheduleReconnect(state);
    }
  }, delay);
}

async function ensureMaster(state: TunnelState): Promise<TunnelState> {
  if (state.status === 'online' && state.master) return state;
  // A spawn is already in flight (status flips to 'connecting' synchronously
  // below, before the first `await`). Concurrent acquires must wait on it
  // instead of each launching their own `ssh` master — otherwise many masters
  // race for the same control socket and the tunnel thrashes.
  if (state.status === 'connecting') {
    return new Promise<TunnelState>((resolve, reject) => {
      state.pendingReady.push({ resolve, reject });
    });
  }
  setStatus(state, 'connecting', null);
  try {
    await ensureSpawn(state);
    return state;
  } catch (e: any) {
    setStatus(state, 'offline', e?.message || String(e));
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Bring the tunnel up if needed and bump the refcount. Returns the local port. */
export async function acquireTunnel(remoteId: string): Promise<{ localTunnelPort: number }> {
  const state = getOrCreateState(remoteId);
  if (state.graceTimer) {
    clearTimeout(state.graceTimer);
    state.graceTimer = null;
  }
  state.paneRefcount++;
  await ensureMaster(state);
  if (state.localTunnelPort == null) throw new Error('Tunnel is up but no local port assigned (internal error)');
  return { localTunnelPort: state.localTunnelPort };
}

/** Decrement the refcount; at zero, close the master after a grace period. */
export function releaseTunnel(remoteId: string) {
  const state = tunnels.get(remoteId);
  if (!state) return;
  state.paneRefcount = Math.max(0, state.paneRefcount - 1);
  if (state.paneRefcount > 0) return;
  if (state.graceTimer) clearTimeout(state.graceTimer);
  state.graceTimer = setTimeout(() => {
    state.graceTimer = null;
    if (state.paneRefcount > 0) return;
    log(`[ssh-tunnel:${state.remoteId}] grace expired — closing master`);
    closeMaster(state);
  }, GRACE_MS);
}

function closeMaster(state: TunnelState) {
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  if (state.master) {
    try { state.master.kill('SIGTERM'); } catch {}
  }
  state.activeForwards.clear();
  state.localTunnelPort = null;
  setStatus(state, 'idle', null);
}

/** Force-disconnect a remote (user removed it, or edited its alias/port). */
export async function disconnectTunnel(remoteId: string): Promise<void> {
  const state = tunnels.get(remoteId);
  if (!state) return;
  state.paneRefcount = 0;
  if (state.graceTimer) { clearTimeout(state.graceTimer); state.graceTimer = null; }
  closeMaster(state);
  tunnels.delete(remoteId);
}

/**
 * Tear down every live SSH master. Called from the app quit handler so we don't
 * leave orphaned `ssh -N -M` children after the app exits. Stays synchronous
 * (no awaits) because `process.on('exit')` can't wait on async work.
 */
export function closeAllTunnels(): void {
  let killed = 0;
  for (const state of tunnels.values()) {
    if (state.graceTimer) { clearTimeout(state.graceTimer); state.graceTimer = null; }
    if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
    state.paneRefcount = 0;
    if (state.master) {
      try { state.master.kill('SIGTERM'); } catch {}
      killed++;
    }
    state.master = null;
    state.activeForwards.clear();
    state.localTunnelPort = null;
  }
  tunnels.clear();
  if (killed > 0) log(`[shutdown] Closed ${killed} SSH tunnel${killed === 1 ? '' : 's'}`);
}

export function getTunnelStatus(remoteId: string): { status: TunnelStatus; lastError: string | null } {
  const state = tunnels.get(remoteId);
  if (!state) return { status: 'idle', lastError: null };
  return { status: state.status, lastError: state.lastError };
}

export function getTunnelLocalPort(remoteId: string): number | null {
  const state = tunnels.get(remoteId);
  if (!state || state.status !== 'online') return null;
  return state.localTunnelPort;
}

// ---------------------------------------------------------------------------
// Per-session port forwards (multiplexed over the master via `ssh -O`)
// ---------------------------------------------------------------------------

function runSshControlCommand(state: TunnelState, op: 'forward' | 'cancel', localPort: number, remotePort: number): Promise<void> {
  const remote = getRemote(state.remoteId);
  if (!remote) return Promise.reject(new Error(`Remote ${state.remoteId} not found`));
  if (!existsSync(state.controlSocket)) {
    return Promise.reject(new Error(`Master socket missing — tunnel not ready`));
  }
  return new Promise<void>((resolve, reject) => {
    const args = [
      '-S', state.controlSocket,
      '-O', op,
      '-L', `${localPort}:localhost:${remotePort}`,
      remote.alias,
    ];
    const proc = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ssh -O ${op} failed (code ${code}): ${stderr.trim()}`));
    });
    proc.on('error', (err) => reject(err));
  });
}

export async function addPortForward(
  remoteId: string,
  remotePort: number,
  localPortHint: number | null,
  label?: string,
): Promise<{ localPort: number }> {
  const state = tunnels.get(remoteId);
  if (!state || state.status !== 'online') {
    throw new Error('Cannot add port forward — tunnel is not online');
  }
  const localPort = localPortHint
    ?? ((await isPortFree(remotePort)) ? remotePort : await pickFreePort());
  const key = `${localPort}:${remotePort}`;
  if (state.activeForwards.has(key)) return { localPort };
  await runSshControlCommand(state, 'forward', localPort, remotePort);
  state.activeForwards.set(key, { localPort, remotePort, label });
  log(`[ssh-tunnel:${remoteId}] forward +L ${localPort}:localhost:${remotePort}`);
  return { localPort };
}

export async function removePortForward(remoteId: string, localPort: number, remotePort: number): Promise<void> {
  const state = tunnels.get(remoteId);
  if (!state) return;
  const key = `${localPort}:${remotePort}`;
  if (!state.activeForwards.has(key)) return;
  await runSshControlCommand(state, 'cancel', localPort, remotePort);
  state.activeForwards.delete(key);
  log(`[ssh-tunnel:${remoteId}] forward -L ${localPort}:localhost:${remotePort}`);
}

export function listActiveForwards(remoteId: string): Array<{ localPort: number; remotePort: number }> {
  const state = tunnels.get(remoteId);
  if (!state) return [];
  return [...state.activeForwards.values()];
}

// ---------------------------------------------------------------------------
// Health check (used by Test Connection and as a post-spawn sanity probe)
// ---------------------------------------------------------------------------

export async function probeRemoteHealth(remoteId: string, timeoutMs = 8_000): Promise<
  | { ok: true; bridgeUp: true }
  | { ok: false; reason: string }
> {
  const remote = getRemote(remoteId);
  if (!remote) return { ok: false, reason: `Remote ${remoteId} not configured.` };

  const state = getOrCreateState(remoteId);
  state.paneRefcount++;
  try {
    await ensureMaster(state);
    if (state.localTunnelPort == null) return { ok: false, reason: 'Tunnel did not open a local port.' };
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`http://127.0.0.1:${state.localTunnelPort}/health`, { signal: controller.signal });
      clearTimeout(t);
      if (!res.ok) return { ok: false, reason: `Bridge replied ${res.status} on /health` };
      return { ok: true, bridgeUp: true };
    } catch (e: any) {
      clearTimeout(t);
      return { ok: false, reason: `Bridge unreachable on :${remote.bunPort} — ${e?.message || String(e)}` };
    }
  } catch (e: any) {
    return { ok: false, reason: e?.message || String(e) };
  } finally {
    state.paneRefcount = Math.max(0, state.paneRefcount - 1);
    if (state.paneRefcount === 0) {
      if (state.graceTimer) clearTimeout(state.graceTimer);
      state.graceTimer = setTimeout(() => {
        state.graceTimer = null;
        if (state.paneRefcount > 0) return;
        closeMaster(state);
      }, GRACE_MS);
    }
  }
}

// ---------------------------------------------------------------------------
// Startup cleanup
// ---------------------------------------------------------------------------

/** Remove stale control sockets left behind by a previous run / crash. */
export function cleanupStaleControlSockets() {
  try {
    ensureControlDir();
    for (const f of readdirSync(CONTROL_DIR)) {
      if (!f.endsWith('.sock')) continue;
      try { unlinkSync(join(CONTROL_DIR, f)); } catch {}
    }
  } catch {}
}
