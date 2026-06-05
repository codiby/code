#!/usr/bin/env bun
/**
 * coldboot-timing-test.ts — mide el arranque en frío REAL de un provider
 * (claude + todos los MCP), aislado de la contención de main-session.
 *
 * Crea una sesión desechable (POST /sessions → spawnea el provider al toque),
 * se suscribe y cronometra hasta el primer `status: connected`. Ese tramo es
 * exactamente el "waiting for connection" que ve el usuario. Después la borra.
 *
 * Uso: bun scripts/coldboot-timing-test.ts [--port 3111] [--keep]
 */

const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]) || 3111;
const keep = args.includes('--keep');
const base = `http://localhost:${port}`;

const t0 = performance.now();
const ms = () => `+${(performance.now() - t0).toFixed(0)}ms`.padStart(9);
const log = (...a: unknown[]) => console.log(ms(), ...a);

let createAt = 0;
let connectedAt = 0;
let sessionId = '';

// 1) Crear la sesión desechable — esto dispara startProviderSession() server-side.
log('POST /sessions  (crea sesión + spawnea provider)');
createAt = performance.now();
const res = await fetch(`${base}/sessions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'coldboot-test', cwd: process.env.HOME }),
});
const created = await res.json();
sessionId = created.id;
log(`creada ${sessionId.slice(0, 8)} (HTTP ${res.status})`);

// 2) Suscribirse al ws y cronometrar hasta 'connected'.
const ws = new WebSocket(`ws://localhost:${port}/ws`);

ws.addEventListener('open', () => {
  ws.send(JSON.stringify({ type: 'subscribe', sessionId }));
  log('→ subscribe + escuchando status…');
});

ws.addEventListener('message', (ev) => {
  let msg: any;
  try { msg = JSON.parse(ev.data as string); } catch { return; }
  if (msg.sessionId !== sessionId) return;
  if (msg.type === 'status') {
    log(`← status: ${msg.status}`);
    if (msg.status === 'connected' && !connectedAt) {
      connectedAt = performance.now();
      finish();
    }
  } else if (msg.type === 'init_info') {
    log(`← init_info (model=${msg.info?.model}, ${msg.info?.tools?.length ?? 0} tools, ${msg.info?.slashCommands?.length ?? 0} cmds)`);
  }
});

async function finish() {
  console.log('\n──────── ARRANQUE EN FRÍO ────────');
  console.log(`create → connected: ${(connectedAt - createAt).toFixed(0)} ms`);
  console.log('  = claude boot + MCP connect (codiby-code + chrome-devtools + …)');
  console.log('──────────────────────────────────');
  if (!keep) {
    await fetch(`${base}/sessions/${sessionId}`, { method: 'DELETE' });
    log(`borrada ${sessionId.slice(0, 8)}`);
  } else {
    log(`(--keep) dejo viva ${sessionId.slice(0, 8)}`);
  }
  ws.close();
  process.exit(0);
}

setTimeout(async () => {
  if (!connectedAt) {
    log('⏱  TIMEOUT 90s sin connected — el boot quedó colgado (probable MCP que no conecta)');
    if (!keep) await fetch(`${base}/sessions/${sessionId}`, { method: 'DELETE' });
    process.exit(1);
  }
}, 90_000);
