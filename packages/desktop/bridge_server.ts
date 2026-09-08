/**
 * Bridge-server port discovery + sidecar spawn. Three resolution steps,
 * in order:
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
 * Health check that tolerates a stalled event loop.
 *
 * The bridge is single-threaded: a synchronous burst (planning file watches
 * over a large cwd, a big git call) can hold it long enough for one 2s probe
 * to time out on a server that is perfectly alive. Declaring it dead on that
 * one probe is expensive — the caller replaces the sidecar and every live
 * session dies with it — so only a run of failures counts as dead.
 */
async function healthCheckPersistent(port: number, attempts = 3): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await healthCheck(port)) return true;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** Wait for a killed sidecar to actually exit, so its replacement doesn't race
 *  it for the port. Bounded — a wedged process shouldn't block startup. */
async function waitForExit(child: ChildProcess, timeoutMs = 3000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, timeoutMs);
    child.once('exit', () => { clearTimeout(t); resolve(); });
  });
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
    // packages/core/index.ts runs directly; bun handles TS natively.
    const projectRoot = join(__dirname, '..');
    return {
      bunPath: process.env.CODIBY_BUN_PATH || 'bun',
      serverScript: join(projectRoot, 'packages', 'core', 'index.ts'),
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

  const { bunPath, serverScript, dev } = resolveSidecarPaths();

  // Retire the previous sidecar BEFORE its replacement starts, and wait for it
  // to go. Spawning first leaves both alive at once: the newcomer loses the
  // race for the port, logs "Is port 3111 in use?", and — because the bridge
  // keeps itself alive through uncaught exceptions — stays up as a process with
  // no listener. We then kill the one process that was actually serving, and
  // the app is left pointing at a bridge that answers nothing.
  if (sidecarChild && !sidecarChild.killed) {
    const previous = sidecarChild;
    sidecarChild = null;
    try { previous.kill(); } catch {}
    await waitForExit(previous);
  }

  // In a packaged build the ripgrep binary lives next to `bun` and `server.js`
  // in `process.resourcesPath`. In dev the handler resolves it through the
  // `@vscode/ripgrep` npm package, so we leave the env var unset.
  const rgPath = dev
    ? undefined
    : join(process.resourcesPath, platform() === 'win32' ? 'rg.exe' : 'rg');

  // Swagger UI assets live next to bun/server.js in a packaged build; in dev the
  // docs server resolves them from node_modules, so leave the var unset.
  const swaggerDist = dev ? undefined : join(process.resourcesPath, 'swagger-ui-dist');

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
        // Abierto a la red por decisión explícita, igual que el resto de las
        // máquinas: el cliente móvil entra por la IP LAN sin intermediarios.
        // Ojo con lo que implica: `authCheck` trata como confiable cualquier
        // petición cuyo header `Host` sea 127.0.0.1, y ese header lo pone el
        // cliente, así que en red abierta el token deja de ser una barrera.
        // CLAUDE_UI_HOST=127.0.0.1 vuelve a encerrarlo en loopback.
        CLAUDE_UI_HOST: process.env.CLAUDE_UI_HOST || '0.0.0.0',
        ...(rgPath ? { CODIBY_RG_PATH: rgPath } : {}),
        ...(swaggerDist ? { CODIBY_SWAGGER_DIST: swaggerDist } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    },
  );

  sidecarChild = child;

  return new Promise<number>((resolve, reject) => {
    let lastStderr = '';
    let resolved = false;
    // A sidecar that never announces its port is useless but not necessarily
    // dead — it keeps running after an uncaught exception. Reap it, or it lives
    // on holding sessions and file watches nobody can reach.
    function abandon(err: Error, alreadyExited = false) {
      if (resolved) return;
      resolved = true;
      clearTimeout(deadline);
      if (sidecarChild === child) sidecarChild = null;
      if (!alreadyExited) { try { child.kill(); } catch {} }
      reject(err);
    }
    const deadline = setTimeout(() => {
      abandon(new Error(`Timed out waiting for bun sidecar. Last stderr: ${lastStderr}`));
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
      abandon(
        new Error(`bun sidecar exited before announcing port (code=${code}, signal=${signal}). stderr: ${lastStderr}`),
        true,
      );
    });

    child.on('error', (err) => {
      abandon(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

export async function getBridgePort(): Promise<number> {
  // Dev escape hatch: when `run.sh` is already running the bridge on a fixed
  // port (typically 3111), point the renderer at that one instead of
  // spawning a second sidecar that would race for the same port files.
  const override = process.env.CODIBY_BRIDGE_PORT_OVERRIDE;
  if (override) {
    const n = Number.parseInt(override, 10);
    if (Number.isFinite(n) && n > 0 && await healthCheck(n)) {
      cachedPort = n;
      return n;
    }
  }

  // The port we already resolved gets the benefit of the doubt: replacing a
  // live sidecar costs every session running inside it, so one timed-out probe
  // isn't enough to condemn it.
  if (cachedPort != null && await healthCheckPersistent(cachedPort)) {
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
  // It announced a port and then never served on it. Don't leave it running —
  // the next attempt would find the port taken by a bridge that answers nothing.
  killSidecar();
  throw new Error(`Spawned bun sidecar on port ${port} but health check never passed`);
}

export function killSidecar(): void {
  if (sidecarChild && !sidecarChild.killed) {
    try { sidecarChild.kill(); } catch {}
  }
  sidecarChild = null;
  try { rmSync(appSpawnPortFile(), { force: true }); } catch {}
}
