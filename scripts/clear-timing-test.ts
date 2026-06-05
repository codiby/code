#!/usr/bin/env bun
/**
 * clear-timing-test.ts — reproduce y cronometra el "waiting for connection"
 * que aparece al hacer /clear en una sesión.
 *
 * Abre un socket de prueba al bridge (igual que el frontend), se suscribe a la
 * sesión, manda el clear por HTTP y mide cuánto tarda en volver a 'connected'.
 *
 * Uso:
 *   bun scripts/clear-timing-test.ts [sessionId] [--no-spawn] [--port 3111]
 *
 * Por defecto apunta a `main-session`. El clear deja la sesión en 'disconnected';
 * el provider se respawnea cuando el frontend manda `active_tab_change` (spawn
 * perezoso), así que el script lo simula salvo que pases --no-spawn.
 */

const args = process.argv.slice(2);
const sessionId = args.find((a) => !a.startsWith('--')) ?? 'main-session';
const noSpawn = args.includes('--no-spawn');
// --cold: fuerza arranque en frío (POST /stop antes del spawn) para medir el
// "waiting for connection" real, no el happy-path con provider caliente.
const cold = args.includes('--cold');
const port = Number(args[args.indexOf('--port') + 1]) || 3111;

function countMainProcs(): number {
  try {
    const out = Bun.spawnSync(['pgrep', '-fc', `x-session-id...${sessionId}`]).stdout.toString().trim();
    return Number(out) || 0;
  } catch { return -1; }
}

const base = `http://localhost:${port}`;
const wsUrl = `ws://localhost:${port}/ws`;

const t0 = performance.now();
const ms = () => `+${(performance.now() - t0).toFixed(0)}ms`.padStart(9);
const log = (...a: unknown[]) => console.log(ms(), ...a);

let clearAt = 0;
let firstDisconnectAfterClear = 0;
let connectedAt = 0;

const ws = new WebSocket(wsUrl);

ws.addEventListener('open', () => {
  log(`ws open → ${wsUrl}`);
  ws.send(JSON.stringify({ type: 'subscribe', sessionId }));
  log(`→ subscribe ${sessionId}`);
});

ws.addEventListener('error', (e) => log('ws ERROR', (e as ErrorEvent).message ?? e));
ws.addEventListener('close', () => log('ws close'));

ws.addEventListener('message', (ev) => {
  let msg: any;
  try { msg = JSON.parse(ev.data as string); } catch { return; }
  if (msg.sessionId && msg.sessionId !== sessionId) return;

  switch (msg.type) {
    case 'session_state':
      log(`← session_state (ready=${msg.state?.ready ?? '?'})`);
      break;
    case 'status':
      log(`← status: ${msg.status}`);
      if (clearAt && msg.status === 'disconnected' && !firstDisconnectAfterClear) {
        firstDisconnectAfterClear = performance.now();
      }
      if (clearAt && msg.status === 'connected') {
        connectedAt = performance.now();
        report();
      }
      break;
    case 'init_info':
      log(`← init_info (model=${msg.info?.model}, ${msg.info?.tools?.length ?? 0} tools)`);
      break;
    default:
      // ruido: message/partial/etc — descomentar para ver todo
      // log(`← ${msg.type}`);
      break;
  }
});

function report() {
  const total = connectedAt - clearAt;
  console.log('\n──────── RESULTADO ────────');
  console.log(`clear → connected:        ${total.toFixed(0)} ms`);
  if (firstDisconnectAfterClear)
    console.log(`clear → disconnected:     ${(firstDisconnectAfterClear - clearAt).toFixed(0)} ms`);
  console.log(`spawn → connected (boot): ${(connectedAt - spawnAt).toFixed(0)} ms  ← acá entra el arranque de claude + MCP`);
  console.log(`procesos "${sessionId}" después: ${countMainProcs()}  (si sube, hay leak de procesos)`);
  console.log('───────────────────────────');
  ws.close();
  process.exit(0);
}

let spawnAt = 0;

async function run() {
  // Esperá a que el ws abra y mande el primer status.
  await Bun.sleep(500);

  log(`procesos "${sessionId}" antes: ${countMainProcs()}`);

  if (cold) {
    // Mata el provider del SDK primero, así el active_tab_change hace un boot
    // real (claude + MCP) en vez de un no-op sobre un provider caliente.
    log(`POST /sessions/${sessionId}/stop  (--cold)`);
    const s = await fetch(`${base}/sessions/${sessionId}/stop`, { method: 'POST' });
    log(`stop → HTTP ${s.status}`);
    await Bun.sleep(500);
  }

  log(`POST /sessions/${sessionId}/clear`);
  clearAt = performance.now();
  const res = await fetch(`${base}/sessions/${sessionId}/clear`, { method: 'POST' });
  log(`clear → HTTP ${res.status} (${((performance.now() - clearAt)).toFixed(0)}ms)`);

  if (noSpawn) {
    log('(--no-spawn) no disparo el respawn; quedará disconnected hasta que abras la tab');
    return;
  }

  // Simulá lo que hace el frontend al enfocar la tab: dispara el spawn perezoso.
  await Bun.sleep(200);
  spawnAt = performance.now();
  ws.send(JSON.stringify({ type: 'active_tab_change', sessionId }));
  log(`→ active_tab_change ${sessionId} (dispara respawn del provider)`);

  // timeout de seguridad
  setTimeout(() => {
    if (!connectedAt) {
      log('⏱  TIMEOUT 60s sin connected — el boot quedó colgado');
      ws.close();
      process.exit(1);
    }
  }, 60_000);
}

run();
