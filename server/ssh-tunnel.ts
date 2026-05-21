/**
 * SSH ControlMaster tunnel manager.
 *
 * One persistent `ssh` master per configured remote. The master:
 *   - opens a TCP forward `localhost:<localTunnelPort> → localhost:<bunPort>`
 *     on the remote, where <bunPort> is where the remote bun bridge listens.
 *   - holds a UNIX control socket so we can attach/cancel additional
 *     per-session port forwards without re-authenticating (`ssh -O forward`,
 *     `ssh -O cancel`). One handshake covers every forward.
 *
 * Lifecycle (lazy + ref-counted, decided in REMOTES_TASKS.md):
 *   - No master at startup. `acquireTunnel(remoteId)` brings one up on first
 *     use (e.g. the user clicks a remote session for the first time).
 *   - `releaseTunnel(remoteId)` decrements the refcount; when it hits zero,
 *     a 5-minute grace timer starts. If acquire happens before it fires,
 *     the timer is cancelled and the master stays. Otherwise the master is
 *     SIGTERM'd.
 *   - If the master dies unexpectedly while refcount > 0, we respawn with
 *     exponential backoff (1→2→4→8→15→30→60s capped).
 *
 * Auth assumptions (also in REMOTES_TASKS.md):
 *   - The user's ~/.ssh/config has a `Host <alias>` block. We never pass
 *     User/Port/IdentityFile on the command line — ssh resolves them.
 *   - ssh-agent is loaded; we do not pipe passphrase prompts. If ssh exits
 *     with "Permission denied" we surface the error and stay offline.
 */

import { spawn, type ChildProcess } from 'child_process';
import { createServer } from 'net';
import { mkdirSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { log } from './logger';
import { getRemote } from './remotes';
import { CODIBY_DIR } from './config';

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
  /** Forwards currently registered on the master, keyed by "localPort:remotePort". */
  activeForwards: Map<string, { localPort: number; remotePort: number; label?: string }>;
  /** Callers waiting for the master to reach `online`. */
  pendingReady: Array<{ resolve: (state: TunnelState) => void; reject: (e: Error) => void }>;
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

/** Wait until something is listening on 127.0.0.1:<port> (the forward is ready). */
function waitForPort(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise<void>((resolve, reject) => {
    const attempt = () => {
      const sock = require('net').connect(port, '127.0.0.1');
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
  return stderr.split('\n').find(l => l.trim()) || 'SSH master exited.';
}

// ---------------------------------------------------------------------------
// Spawn / health
// ---------------------------------------------------------------------------

async function spawnMaster(state: TunnelState): Promise<void> {
  const remote = getRemote(state.remoteId);
  if (!remote) throw new Error(`Remote ${state.remoteId} not found`);

  ensureControlDir();
  // Clean stale socket from a previous run / crash.
  try { if (existsSync(state.controlSocket)) unlinkSync(state.controlSocket); } catch {}

  const localPort = await pickFreePort();
  state.localTunnelPort = localPort;

  const args = [
    '-N',                                              // no remote command
    '-M', '-S', state.controlSocket,                   // control master + socket
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'BatchMode=yes',                             // never prompt; rely on ssh-agent
    '-L', `${localPort}:localhost:${remote.bunPort}`,
    remote.alias,
  ];

  log(`[ssh-tunnel:${remote.name}] spawn ssh ${args.join(' ')}`);
  const proc = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  state.master = proc;

  let stderrBuf = '';
  proc.stderr?.on('data', chunk => {
    const s = chunk.toString();
    stderrBuf += s;
    // Keep buffer bounded — only the last error window matters.
    if (stderrBuf.length > 4_000) stderrBuf = stderrBuf.slice(-4_000);
  });

  proc.on('exit', (code, signal) => {
    const wasOnline = state.status === 'online';
    state.master = null;
    state.activeForwards.clear();
    state.localTunnelPort = null;
    const err = code === 0 || signal === 'SIGTERM' ? null : classifySshError(stderrBuf);
    log(`[ssh-tunnel:${remote.name}] master exited code=${code} signal=${signal}`);
    // Reject any pending ready waiters.
    while (state.pendingReady.length) {
      const w = state.pendingReady.shift()!;
      w.reject(new Error(err || 'SSH master exited before tunnel was ready.'));
    }
    if (state.paneRefcount > 0 && signal !== 'SIGTERM') {
      // Unexpected death with active panes — schedule a reconnect.
      setStatus(state, 'reconnecting', err);
      scheduleReconnect(state);
    } else {
      setStatus(state, wasOnline && signal === 'SIGTERM' ? 'idle' : 'offline', err);
    }
  });

  // Wait for the local end of the forward to start accepting connections.
  await waitForPort(localPort, 15_000);
  state.reconnectAttempt = 0;
  setStatus(state, 'online', null);
  while (state.pendingReady.length) {
    const w = state.pendingReady.shift()!;
    w.resolve(state);
  }
}

function scheduleReconnect(state: TunnelState) {
  if (state.reconnectTimer) return;
  const delay = BACKOFF_SEQ_MS[Math.min(state.reconnectAttempt, BACKOFF_SEQ_MS.length - 1)];
  state.reconnectAttempt++;
  log(`[ssh-tunnel:${state.remoteId}] reconnect attempt ${state.reconnectAttempt} in ${delay}ms`);
  state.reconnectTimer = setTimeout(async () => {
    state.reconnectTimer = null;
    if (state.paneRefcount === 0) {
      // Nobody cares anymore — go idle.
      setStatus(state, 'idle', state.lastError);
      return;
    }
    try {
      await spawnMaster(state);
    } catch (e: any) {
      setStatus(state, 'reconnecting', e?.message || String(e));
      scheduleReconnect(state);
    }
  }, delay);
}

/**
 * Ensure the master is up and ready. Idempotent — multiple parallel callers
 * await the same spawn.
 */
async function ensureMaster(state: TunnelState): Promise<TunnelState> {
  if (state.status === 'online' && state.master) return state;
  if (state.master && state.status === 'connecting') {
    return new Promise<TunnelState>((resolve, reject) => {
      state.pendingReady.push({ resolve, reject });
    });
  }
  setStatus(state, 'connecting', null);
  try {
    await spawnMaster(state);
    return state;
  } catch (e: any) {
    setStatus(state, 'offline', e?.message || String(e));
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Bring the tunnel up if needed and bump the pane refcount. Returns the
 * local TCP port where the gateway should proxy HTTP/WS for this remote.
 */
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

/**
 * Decrement the pane refcount. When it hits zero, schedule the master to
 * be SIGTERM'd after a 5-minute grace period (so reopen-after-close is free).
 */
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

/**
 * Force-disconnect a remote (e.g. user removed it, or edited its alias/port).
 * Cancels any grace and reconnect timers, kills the master immediately.
 */
export async function disconnectTunnel(remoteId: string): Promise<void> {
  const state = tunnels.get(remoteId);
  if (!state) return;
  state.paneRefcount = 0;
  if (state.graceTimer) { clearTimeout(state.graceTimer); state.graceTimer = null; }
  closeMaster(state);
  // Drop the state so future acquire() picks a fresh local port etc.
  tunnels.delete(remoteId);
}

export function getTunnelStatus(remoteId: string): { status: TunnelStatus; lastError: string | null } {
  const state = tunnels.get(remoteId);
  if (!state) return { status: 'idle', lastError: null };
  return { status: state.status, lastError: state.lastError };
}

export function getTunnelLocalPort(remoteId: string): number | null {
  // Only expose the local port once the SSH master has confirmed the
  // forward is actually listening. During the `connecting` window the
  // port number is already assigned (we picked it before spawn) but no
  // listener is bound yet — callers must instead go through
  // `acquireTunnel`, which queues on `pendingReady` until `waitForPort`
  // resolves. Returning the port too early caused proxy fetches to hang
  // indefinitely against a dead socket with no timeout.
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
    proc.stderr?.on('data', d => { stderr += d.toString(); });
    proc.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`ssh -O ${op} failed (code ${code}): ${stderr.trim()}`));
    });
    proc.on('error', err => reject(err));
  });
}

/**
 * Add a port forward. Returns the local port actually used (relevant when
 * the caller passed `null`, asking us to pick one).
 */
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
  const localPort = localPortHint ?? await pickFreePort();
  const key = `${localPort}:${remotePort}`;
  if (state.activeForwards.has(key)) return { localPort };
  await runSshControlCommand(state, 'forward', localPort, remotePort);
  state.activeForwards.set(key, { localPort, remotePort, label });
  log(`[ssh-tunnel:${remoteId}] forward +L ${localPort}:localhost:${remotePort}`);
  return { localPort };
}

export async function removePortForward(
  remoteId: string,
  localPort: number,
  remotePort: number,
): Promise<void> {
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

/**
 * Verify that the remote bun bridge is reachable through this remote's tunnel.
 * Acquires (without bumping pane refcount), GETs /health, and reports the
 * result. Useful for the "Test Connection" button in Settings.
 */
export async function probeRemoteHealth(remoteId: string, timeoutMs = 8_000): Promise<
  | { ok: true; bridgeUp: true }
  | { ok: false; reason: string }
> {
  const remote = getRemote(remoteId);
  if (!remote) return { ok: false, reason: `Remote ${remoteId} not configured.` };

  const state = getOrCreateState(remoteId);
  // We don't want to mess with the user's refcount here. Use a transient
  // refcount bump so a parallel grace-timer can't kill us mid-probe.
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
    // Mirror releaseTunnel without double-decrement: the probe owns one ref.
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
    const fs = require('fs');
    for (const f of fs.readdirSync(CONTROL_DIR)) {
      if (!f.endsWith('.sock')) continue;
      try { fs.unlinkSync(join(CONTROL_DIR, f)); } catch {}
    }
  } catch {}
}
