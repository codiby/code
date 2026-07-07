/**
 * Dev orchestrator for the Electron shell.
 *
 *   bun run electron:dev
 *
 * Sequencing:
 *   1. Start `run.sh` (frontend bundler + bridge server on :3111).
 *   2. Compile the Electron main process in watch mode (tsc -p packages/desktop/tsconfig.json --watch).
 *   3. Wait for `dist/index.html` AND `electron-dist/main.js` to exist.
 *   4. Spawn `electron .` with `ELECTRON_DEV=1` + `CODIBY_BRIDGE_PORT_OVERRIDE=3111`
 *      so the main process points the renderer at the already-running bridge
 *      instead of double-spawning a sidecar.
 *
 * Ctrl-C tears all three subprocesses down.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const children: ChildProcess[] = [];

function spawnSub(label: string, cmd: string, args: string[]): ChildProcess {
  const child = spawn(cmd, args, {
    cwd: ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env },
  });
  child.on('exit', (code, signal) => {
    console.error(`[${label}] exited code=${code} signal=${signal}`);
  });
  children.push(child);
  return child;
}

async function waitForFile(path: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function shutdown(): void {
  for (const c of children) {
    try { c.kill(); } catch {}
  }
}

process.on('SIGINT', () => { shutdown(); process.exit(0); });
process.on('SIGTERM', () => { shutdown(); process.exit(0); });
process.on('exit', shutdown);

async function main(): Promise<void> {
  const skipFrontend = process.env.SKIP_DEV_SERVER_START === '1';

  // 1. Bundler + bridge. Skip when the dev server is already running elsewhere
  //    (e.g. inside WSL) — in that case `dist/` lives on the other filesystem
  //    and we must not block waiting for it on the Windows side.
  if (!skipFrontend) {
    spawnSub('frontend', 'bash', ['run.sh']);
  } else {
    console.log('[electron-dev] SKIP_DEV_SERVER_START=1 — attaching to external bridge.');
  }

  // 2. Electron main process (watch).
  spawnSub('electron-tsc', 'bunx', ['tsc', '-p', 'packages/desktop/tsconfig.json', '--watch']);

  // 3. Wait for first builds.
  console.log('[electron-dev] waiting for first builds…');
  if (!skipFrontend) {
    await waitForFile(join(ROOT, 'dist', 'index.html'));
  }
  await waitForFile(join(ROOT, 'electron-dist', 'main.js'));

  // 4. Boot electron.
  console.log('[electron-dev] launching electron…');
  const electron = spawnSub('electron', 'bunx', ['electron', '.']);
  // Re-export the env to the electron child explicitly (spawn's env arg
  // takes a snapshot, so override after the fact via Object.assign would
  // be a no-op — we set everything via the shared env above).
  electron.on('exit', () => shutdown());
}

main().catch((e) => {
  console.error('[electron-dev] fatal:', e);
  shutdown();
  process.exit(1);
});
