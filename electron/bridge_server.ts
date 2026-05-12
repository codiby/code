/**
 * Bridge-server port discovery + sidecar spawn.
 *
 * Port of `src-tauri/src/lib.rs::{bridge_port_file, app_spawn_port_file,
 * spawn_sidecar, get_bridge_port}`. Three resolution steps, in order:
 *
 *   1. LaunchAgent / SCM-service port file (~/.codiby/server.port etc.)
 *   2. Previous app-spawned sidecar port file (app-server.port sibling)
 *   3. Spawn a fresh `bun server.js --spawned-by=app` and wait for it to
 *      announce `BRIDGE_SERVER_PORT:<n>` on stdout.
 *
 * The spawned child is tracked so `app.on('before-quit')` can kill it.
 */
import { app } from 'electron';
import { spawn, ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';

let cachedPort: number | null = null;
let sidecarChild: ChildProcess | null = null;

function bridgePortFile(): string {
  const plat = platform();
  if (plat === 'darwin') {
    return join(homedir(), '.codiby', 'server.port');
  }
  if (plat === 'win32') {
    const programData = process.env.PROGRAMDATA || 'C:\\ProgramData';
    return join(programData, 'codiby', 'server.port');
  }
  // Linux / other unix
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'codiby', 'port');
}

function appSpawnPortFile(): string {
  const p = bridgePortFile();
  return join(dirname(p), 'app-server.port');
}

function readPort(path: string): number | null {
  try {
    const raw = readFileSync(path, 'utf8').trim();
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

async function healthCheck(port: number): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2000);
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    return r.status === 200;
  } catch {
    return false;
  }
}

/**
 * Resolve absolute paths to the bundled `bun` binary and `server.js` script.
 * In dev, fall back to the host's `bun` (PATH lookup) and the source
 * `server/index.ts` so the watcher cycle works without a packaging step.
 */
function resolveSidecarPaths(): { bunPath: string; serverScript: string; dev: boolean } {
  const dev = !app.isPackaged;
  if (dev) {
    // Host `bun` is on PATH thanks to `run.sh` / the user's profile.
    // server/index.ts runs directly; bun handles TS natively.
    const projectRoot = join(__dirname, '..');
    return {
      bunPath: process.env.CODIBY_BUN_PATH || 'bun',
      serverScript: join(projectRoot, 'server', 'index.ts'),
      dev: true,
    };
  }
  const resources = process.resourcesPath;
  const bunBin = platform() === 'win32' ? 'bun.exe' : 'bun';
  return {
    bunPath: join(resources, bunBin),
    serverScript: join(resources, 'server.js'),
    dev: false,
  };
}

async function spawnSidecar(): Promise<number> {
  const portFile = appSpawnPortFile();
  try {
    mkdirSync(dirname(portFile), { recursive: true });
    if (existsSync(portFile)) rmSync(portFile, { force: true });
  } catch {}

  const { bunPath, serverScript } = resolveSidecarPaths();

  // `--spawned-by=app` makes the bridge skip the bulk session boot it
  // would do under launchd. The Electron shell drives spawning lazily
  // via the `active_tab_change` WS message instead.
  const child = spawn(
    bunPath,
    [serverScript, '--spawned-by=app'],
    {
      env: {
        ...process.env,
        CODIBY_CODE_PORT_FILE: portFile,
        CLAUDE_UI_PORT: '3111',
        CLAUDE_UI_HOST: '127.0.0.1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    },
  );

  if (sidecarChild && !sidecarChild.killed) {
    try { sidecarChild.kill(); } catch {}
  }
  sidecarChild = child;

  return new Promise<number>((resolve, reject) => {
    let lastStderr = '';
    let resolved = false;
    const deadline = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      reject(new Error(`Timed out waiting for bun sidecar. Last stderr: ${lastStderr}`));
    }, 15_000);

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('BRIDGE_SERVER_PORT:')) continue;
        const rest = trimmed.slice('BRIDGE_SERVER_PORT:'.length);
        const port = Number.parseInt(rest, 10);
        if (Number.isFinite(port) && port > 0 && !resolved) {
          resolved = true;
          clearTimeout(deadline);
          // Drain stdout forever so the pipe never fills + blocks the server.
          child.stdout?.on('data', () => {});
          resolve(port);
          return;
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      lastStderr = chunk.toString('utf8');
    });

    child.on('exit', (code, signal) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(deadline);
      reject(new Error(`bun sidecar exited before announcing port (code=${code}, signal=${signal}). stderr: ${lastStderr}`));
    });

    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(deadline);
      reject(err);
    });
  });
}

export async function getBridgePort(): Promise<number> {
  if (cachedPort != null && await healthCheck(cachedPort)) {
    return cachedPort;
  }
  cachedPort = null;

  // 1. Externally-installed service (LaunchAgent / SCM service).
  const servicePort = readPort(bridgePortFile());
  if (servicePort && await healthCheck(servicePort)) {
    cachedPort = servicePort;
    return servicePort;
  }

  // 2. A sidecar from a previous run of this app that's still alive.
  const appPort = readPort(appSpawnPortFile());
  if (appPort && await healthCheck(appPort)) {
    cachedPort = appPort;
    return appPort;
  }

  // 3. Spawn one.
  const port = await spawnSidecar();
  // Verify health after announce — server emits the line before the
  // listener is fully up.
  for (let i = 0; i < 30; i++) {
    if (await healthCheck(port)) {
      cachedPort = port;
      return port;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Spawned bun sidecar on port ${port} but health check never passed`);
}

export function killSidecar(): void {
  if (sidecarChild && !sidecarChild.killed) {
    try { sidecarChild.kill(); } catch {}
  }
  sidecarChild = null;
  try { rmSync(appSpawnPortFile(), { force: true }); } catch {}
}
