#!/usr/bin/env bun
/**
 * End-to-end reproducer for the "remote session shows but the chat
 * never arrives" bug. Hits the LOCAL bridge running inside Codiby Code,
 * which is what the desktop UI talks to.
 *
 * Flow (mirrors what the React UI does):
 *   1. POST /sessions   with remoteId → bridge proxies to remote, returns sessionId.
 *   2. WS /ws            → frontend connection.
 *   3. subscribe msg     → bridge should reply with `session_state` + `status`.
 *   4. active_tab_change → bridge should spawn the remote provider lazily,
 *                          remote should start streaming `init_info`, `status`.
 *
 * Pass criteria: a `session_state` AND a `status` for the new sessionId
 * arrive within 8s of subscribe.
 *
 * Usage:
 *   bun run scripts/test-remote-ws.ts [remoteId]
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const HOME = homedir();
const REMOTES_FILE = join(HOME, '.codiby/ui-remotes.json');
const LOCAL_BRIDGE = process.env.LOCAL_BRIDGE_URL || 'http://localhost:3111';
const LOCAL_WS = LOCAL_BRIDGE.replace(/^http/, 'ws') + '/ws';

const START = Date.now();
function ts(): string {
  return `+${((Date.now() - START) / 1000).toFixed(3).padStart(7, ' ')}s`;
}
function log(...args: unknown[]) { console.log(`[${ts()}]`, ...args); }
function logErr(...args: unknown[]) { console.error(`[${ts()}] ERROR:`, ...args); }

type Remote = { id: string; name: string; alias: string; bunPort: number };

function loadRemotes(): Remote[] {
  return JSON.parse(readFileSync(REMOTES_FILE, 'utf-8'));
}

async function fetchWithDeadline(url: string, init?: RequestInit, timeoutMs = 10_000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`fetch deadline ${timeoutMs}ms`)), timeoutMs);
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
  log(`Target: ${LOCAL_BRIDGE} ; remote=${remote.name} (${remoteId})`);

  // 1. Probe local bridge is up
  log(`Probing ${LOCAL_BRIDGE}/health…`);
  const health = await fetchWithDeadline(`${LOCAL_BRIDGE}/health`, undefined, 5_000);
  if (!health.ok) {
    logErr(`Local bridge not healthy: ${health.status}`);
    process.exit(1);
  }
  log(`Local bridge up: ${await health.text()}`);

  // 2. Create a remote session via the local bridge
  log(`POST ${LOCAL_BRIDGE}/sessions with remoteId…`);
  const t0 = Date.now();
  const resp = await fetchWithDeadline(`${LOCAL_BRIDGE}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      cwd: '/tmp',
      name: `repro-${Date.now()}`,
      provider: 'claudeAgent',
      remoteId: remote.id,
    }),
  }, 15_000);
  if (!resp.ok) {
    logErr(`POST /sessions returned ${resp.status}: ${await resp.text()}`);
    process.exit(1);
  }
  const created = await resp.json() as { id: string; name: string; cwd: string };
  log(`Session created in ${Date.now() - t0}ms: ${created.id} (${created.name})`);

  // 3. Open the frontend WS and subscribe
  log(`Connecting to ${LOCAL_WS}…`);
  const ws = new WebSocket(LOCAL_WS);
  const received: Array<{ type: string; sessionId?: string; raw: any }> = [];

  let sawSessionState = false;
  let sawStatus = false;
  let sawInitInfo = false;

  ws.addEventListener('open', () => {
    log(`WS open. Subscribing to ${created.id}…`);
    ws.send(JSON.stringify({ type: 'subscribe', sessionId: created.id }));
    // Mark this session as the focused tab so the bridge spawns the
    // provider lazily (same thing ChatApp does on session click).
    setTimeout(() => {
      log(`Sending active_tab_change for ${created.id}`);
      ws.send(JSON.stringify({ type: 'active_tab_change', sessionId: created.id }));
    }, 100);
  });

  ws.addEventListener('message', (ev) => {
    let msg: any;
    try { msg = JSON.parse(ev.data as string); }
    catch { return; }
    received.push({ type: msg.type, sessionId: msg.sessionId, raw: msg });
    const sidShort = msg.sessionId ? ` sid=${String(msg.sessionId).slice(0, 8)}` : '';
    log(`WS ← ${msg.type}${sidShort}`);
    if (msg.sessionId === created.id) {
      if (msg.type === 'session_state') sawSessionState = true;
      if (msg.type === 'status')        sawStatus = true;
      if (msg.type === 'init_info')     sawInitInfo = true;
    }
  });

  ws.addEventListener('close', (ev) => {
    log(`WS closed: code=${(ev as any).code} reason=${(ev as any).reason}`);
  });
  ws.addEventListener('error', () => {
    logErr(`WS error`);
  });

  // 4. Wait up to 8s for the bridge to respond to subscribe + active_tab_change
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (sawSessionState && sawStatus) break;
    await new Promise(r => setTimeout(r, 100));
  }

  log('');
  log(`====== Result ======`);
  log(`session_state for our sessionId received? ${sawSessionState ? '✅' : '❌'}`);
  log(`status for our sessionId received?        ${sawStatus ? '✅' : '❌'}`);
  log(`init_info for our sessionId received?     ${sawInitInfo ? '✅' : '❌ (may need more time)'}`);
  log(`Total WS messages received: ${received.length}`);
  if (received.length > 0) {
    log(`Types: ${[...new Set(received.map(r => r.type))].join(', ')}`);
  }
  try { ws.close(); } catch {}

  if (!sawSessionState || !sawStatus) {
    logErr(`BUG REPRODUCED — bridge does not respond to subscribe for remote sessionId.`);
    process.exitCode = 2;
  } else {
    log(`PASS — bridge responds to subscribe for remote sessionId.`);
  }

  // Brief delay for clean shutdown
  await new Promise(r => setTimeout(r, 300));
}

main().catch(err => {
  logErr(`Unhandled: ${err}`);
  process.exit(1);
});
