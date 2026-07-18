#!/usr/bin/env bun
/**
 * Standalone reproducer for the "remote session hangs on waiting for
 * connection" bug. Mirrors ssh-tunnel.ts + gateway.ts behavior exactly,
 * with verbose timing logs at every step, so we can see precisely where
 * the flow stalls.
 *
 * Usage:
 *   bun run scripts/test-remote-tunnel.ts [remoteId]
 *
 * Defaults to the first remote in ~/.codiby/ui-remotes.json.
 */

import { spawn, type ChildProcess } from 'child_process';
import { readFileSync, existsSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { connect as netConnect, createServer } from 'net';

const HOME = homedir();
const REMOTES_FILE = join(HOME, '.codiby/ui-remotes.json');
const CONTROL_DIR = join(HOME, '.codiby/ssh-control');

const START = Date.now();
function ts(): string {
  const elapsed = ((Date.now() - START) / 1000).toFixed(3);
  return `+${elapsed.padStart(7, ' ')}s`;
}
function log(...args: unknown[]) {
  console.log(`[${ts()}]`, ...args);
}
function logErr(...args: unknown[]) {
  console.error(`[${ts()}] ERROR:`, ...args);
}

type Remote = { id: string; name: string; alias: string; bunPort: number };

function loadRemotes(): Remote[] {
  return JSON.parse(readFileSync(REMOTES_FILE, 'utf-8'));
}

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close();
        reject(new Error('Could not pick a free port'));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

/** Poll the local port with a short connect; logs every attempt. */
function waitForPort(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  return new Promise<void>((resolve, reject) => {
    const tryOnce = () => {
      attempt++;
      const sock = netConnect(port, '127.0.0.1');
      let done = false;
      const finish = (ok: boolean, err?: Error) => {
        if (done) return;
        done = true;
        try { sock.destroy(); } catch {}
        if (ok) {
          log(`waitForPort: 127.0.0.1:${port} accepted on attempt #${attempt}`);
          resolve();
        } else if (Date.now() > deadline) {
          logErr(`waitForPort: deadline exceeded after ${attempt} attempts. Last error:`, err?.message);
          reject(err || new Error('Tunnel ready timeout'));
        } else {
          if (attempt % 10 === 0) {
            log(`waitForPort: still polling 127.0.0.1:${port} (attempt #${attempt}, last err: ${err?.message || 'n/a'})`);
          }
          setTimeout(tryOnce, 200);
        }
      };
      sock.once('connect', () => finish(true));
      sock.once('error', (e: Error) => finish(false, e));
    };
    tryOnce();
  });
}

interface TunnelState {
  proc: ChildProcess;
  localPort: number;
  controlSocket: string;
  stderrBuf: string;
}

async function spawnMaster(remote: Remote): Promise<TunnelState> {
  mkdirSync(CONTROL_DIR, { recursive: true });
  const controlSocket = join(CONTROL_DIR, `${remote.id}.test.sock`);
  // Wipe any stale socket
  if (existsSync(controlSocket)) {
    log(`Cleaning stale control socket ${controlSocket}`);
    try { unlinkSync(controlSocket); } catch {}
  }

  const localPort = await pickFreePort();
  log(`Picked free local port ${localPort}`);

  const args = [
    '-N',
    '-M', '-S', controlSocket,
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'BatchMode=yes',
    '-v',                                       // verbose so we see what SSH is doing
    '-L', `${localPort}:localhost:${remote.bunPort}`,
    remote.alias,
  ];

  log(`Spawning: ssh ${args.join(' ')}`);
  const proc = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  const state: TunnelState = { proc, localPort, controlSocket, stderrBuf: '' };

  proc.stderr?.on('data', (chunk) => {
    const s = chunk.toString();
    state.stderrBuf += s;
    // Print only the most informative SSH verbose lines
    for (const line of s.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      if (
        t.includes('Authenticated to') ||
        t.includes('Local connections to') ||
        t.includes('Permission denied') ||
        t.includes('Connection closed') ||
        t.includes('Connection refused') ||
        t.includes('forwarding to') ||
        t.includes('mux_client') ||
        t.startsWith('debug1:') && (t.includes('forward') || t.includes('Authenticated') || t.includes('Connection to')) ||
        t.toLowerCase().includes('error') ||
        t.toLowerCase().includes('warning')
      ) {
        log(`ssh stderr: ${t}`);
      }
    }
  });

  proc.on('exit', (code, signal) => {
    log(`ssh master exited: code=${code} signal=${signal}`);
    if (state.stderrBuf) log(`ssh full stderr:\n${state.stderrBuf}`);
  });
  proc.on('error', (err) => {
    logErr(`ssh spawn error: ${err.message}`);
  });

  // Wait for the local port to be accepting connections.
  log(`Waiting for 127.0.0.1:${localPort} to accept connections (timeout 15s)…`);
  await waitForPort(localPort, 15_000);
  log(`Tunnel is up on 127.0.0.1:${localPort}`);
  return state;
}

function closeMaster(state: TunnelState, remote: Remote) {
  log(`Closing tunnel…`);
  try {
    // Best-effort: use ssh -O exit to close cleanly via control socket
    spawn('ssh', ['-S', state.controlSocket, '-O', 'exit', remote.alias], { stdio: 'ignore' });
  } catch {}
  try { state.proc.kill('SIGTERM'); } catch {}
}

async function fetchWithDeadline(url: string, init?: RequestInit, timeoutMs = 10_000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`fetch deadline ${timeoutMs}ms exceeded`)), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const remotes = loadRemotes();
  const remoteId = process.argv[2] || remotes[0]?.id;
  const remote = remotes.find(r => r.id === remoteId);
  if (!remote) {
    logErr(`Remote not found: ${remoteId}`);
    process.exit(1);
  }
  log(`Using remote: ${remote.name} (${remote.alias}) bunPort=${remote.bunPort}`);

  let state: TunnelState | null = null;
  try {
    // Step 1: bring up the tunnel
    state = await spawnMaster(remote);

    // Step 2: health check through tunnel
    const healthUrl = `http://127.0.0.1:${state.localPort}/health`;
    log(`GET ${healthUrl} (10s deadline)…`);
    const t0 = Date.now();
    const resp = await fetchWithDeadline(healthUrl, undefined, 10_000);
    const body = await resp.text();
    log(`health → ${resp.status} in ${Date.now() - t0}ms — body: ${body.slice(0, 200)}`);

    // Step 3: simulate a POST /sessions like the bridge does
    const sessionsUrl = `http://127.0.0.1:${state.localPort}/sessions`;
    log(`POST ${sessionsUrl} (10s deadline)…`);
    const t1 = Date.now();
    const resp2 = await fetchWithDeadline(sessionsUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp', name: 'test-from-script', provider: 'claude' }),
    }, 10_000);
    const body2 = await resp2.text();
    log(`POST /sessions → ${resp2.status} in ${Date.now() - t1}ms — body: ${body2.slice(0, 300)}`);

    log(`\n✅ ALL OK — tunnel + HTTP through tunnel both work.`);
  } catch (err) {
    logErr(`Flow failed: ${err instanceof Error ? err.message : err}`);
    if (state?.stderrBuf) log(`Full ssh stderr at failure:\n${state.stderrBuf}`);
    process.exitCode = 1;
  } finally {
    if (state) closeMaster(state, remote);
    // give ssh a moment to exit cleanly before the script returns
    await new Promise(r => setTimeout(r, 500));
  }
}

main().catch(err => {
  logErr(`Unhandled: ${err}`);
  process.exit(1);
});
