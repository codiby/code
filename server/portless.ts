/**
 * Portless action manager.
 *
 * Each tab group has zero or more "actions" (name + command + hostname).
 * Running an action spawns `portless <name> -- <command…>` in the group's
 * cwd so the dev server is reachable at `https://<hostname>` instead of
 * `http://localhost:<random-port>`.
 *
 * The manager tracks one ChildProcess per (groupId, actionId) pair and
 * exposes a tiny status bus so server/index.ts can rebroadcast changes to
 * connected frontends over WS.
 */

import { spawn, spawnSync, type ChildProcessByStdio } from 'child_process';
import type { Readable } from 'stream';
import { existsSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { log } from './logger';

// ---------------------------------------------------------------------------
// CLI detection
// ---------------------------------------------------------------------------

/** Static locations to probe before falling back to PATH walking. We
 *  enumerate the common Node-version-manager layouts (nvm + fnm + asdf +
 *  volta) because launchd-spawned Electron loses the user's shell PATH
 *  even after config.ts's enrichment when the user picked their default
 *  shell as zsh non-interactive. */
function nvmVersionDirs(): string[] {
  const root = join(homedir(), '.nvm', 'versions', 'node');
  try {
    return readdirSync(root)
      .map(v => join(root, v, 'bin', 'portless'))
      .sort()
      .reverse();
  } catch { return []; }
}

function fnmVersionDirs(): string[] {
  const root = join(homedir(), '.local', 'share', 'fnm', 'node-versions');
  try {
    return readdirSync(root)
      .map(v => join(root, v, 'installation', 'bin', 'portless'))
      .sort()
      .reverse();
  } catch { return []; }
}

function staticCandidates(): string[] {
  return [
    '/opt/homebrew/bin/portless',
    '/usr/local/bin/portless',
    '/usr/bin/portless',
    join(homedir(), '.bun', 'bin', 'portless'),
    join(homedir(), '.volta', 'bin', 'portless'),
    join(homedir(), '.asdf', 'shims', 'portless'),
    ...nvmVersionDirs(),
    ...fnmVersionDirs(),
  ];
}

/** Walk `process.env.PATH` (which config.ts pre-enriches from the user's
 *  login shell). Picks the first directory containing an executable
 *  `portless`. */
function searchEnvPath(): string | null {
  const path = process.env.PATH || '';
  for (const dir of path.split(':')) {
    if (!dir) continue;
    const candidate = join(dir, 'portless');
    try {
      const stat = statSync(candidate);
      if (stat.isFile() && (stat.mode & 0o111)) return candidate;
    } catch {}
  }
  return null;
}

/** Last-resort: ask the user's login shell where portless lives. This
 *  catches setups (zsh interactive plugins, direnv, etc.) that only
 *  publish the binary inside a fully-loaded shell session. */
function askLoginShell(): string | null {
  const shell = process.env.SHELL || '/bin/zsh';
  try {
    const res = spawnSync(shell, ['-lic', 'command -v portless 2>/dev/null'], {
      encoding: 'utf-8', timeout: 4000,
    });
    const out = (res.stdout || '').trim();
    if (out && existsSync(out)) return out;
  } catch {}
  return null;
}

/** Resolved binary path. Cached only on success — a failed lookup is
 *  retried on every call so the user can install Portless without
 *  restarting taskr. */
let cachedBin: string | null = null;
let cachedVersion: string | null = null;

function resolvePortlessBin(): string | null {
  if (cachedBin && existsSync(cachedBin)) return cachedBin;
  if (process.env.PORTLESS_BIN && existsSync(process.env.PORTLESS_BIN)) {
    cachedBin = process.env.PORTLESS_BIN;
    return cachedBin;
  }
  for (const p of staticCandidates()) {
    if (existsSync(p)) { cachedBin = p; return cachedBin; }
  }
  const onPath = searchEnvPath();
  if (onPath) { cachedBin = onPath; return cachedBin; }
  const fromShell = askLoginShell();
  if (fromShell) { cachedBin = fromShell; return cachedBin; }
  cachedBin = null;
  return null;
}

export interface PortlessCliStatus {
  available: boolean;
  bin: string | null;
  version: string | null;
}

export function getPortlessCliStatus(): PortlessCliStatus {
  const bin = resolvePortlessBin();
  if (!bin) return { available: false, bin: null, version: null };
  if (cachedVersion === null) {
    try {
      const res = spawnSync(bin, ['--version'], { encoding: 'utf-8', timeout: 4000 });
      const out = (res.stdout || res.stderr || '').trim();
      cachedVersion = out || 'unknown';
    } catch {
      cachedVersion = 'unknown';
    }
  }
  return { available: true, bin, version: cachedVersion };
}

// ---------------------------------------------------------------------------
// Action input + runtime state
// ---------------------------------------------------------------------------

export interface PortlessActionInput {
  groupId: string;
  actionId: string;
  name: string;
  command: string;
  /** Resolved full hostname (e.g. "api.localhost"). */
  hostname: string;
  /** Project cwd — required (no portless without a working directory). */
  cwd: string;
  /** When true, pass `--no-tls`. Defaults to false (HTTPS on). */
  noTls?: boolean;
  /** Used by the MCP tool to surface "the agent started this" in the toast. */
  source?: 'user' | 'agent';
  /** When the action was started by the agent, the originating session id. */
  sessionId?: string;
}

export type PortlessActionState =
  | 'starting'
  | 'running'
  | 'stopping'
  | 'exited'
  | 'failed';

export interface PortlessActionStatus {
  key: string;
  groupId: string;
  actionId: string;
  name: string;
  command: string;
  hostname: string;
  url: string;
  cwd: string;
  pid: number | null;
  state: PortlessActionState;
  startedAt: number | null;
  exitedAt: number | null;
  exitCode: number | null;
  lastError: string | null;
  /** Last few lines of stdout/stderr, capped at LOG_TAIL_LIMIT. */
  logTail: string[];
}

type PortlessProc = ChildProcessByStdio<null, Readable, Readable>;

interface RunningAction extends PortlessActionStatus {
  proc: PortlessProc | null;
  killTimer: ReturnType<typeof setTimeout> | null;
}

const LOG_TAIL_LIMIT = 80;
const running = new Map<string, RunningAction>();

function actionKey(groupId: string, actionId: string): string {
  return `${groupId}:${actionId}`;
}

function snapshotOne(a: RunningAction): PortlessActionStatus {
  return {
    key: a.key,
    groupId: a.groupId,
    actionId: a.actionId,
    name: a.name,
    command: a.command,
    hostname: a.hostname,
    url: a.url,
    cwd: a.cwd,
    pid: a.pid,
    state: a.state,
    startedAt: a.startedAt,
    exitedAt: a.exitedAt,
    exitCode: a.exitCode,
    lastError: a.lastError,
    logTail: [...a.logTail],
  };
}

export function snapshotAll(): PortlessActionStatus[] {
  return [...running.values()].map(snapshotOne);
}

export function snapshotAction(groupId: string, actionId: string): PortlessActionStatus | null {
  const a = running.get(actionKey(groupId, actionId));
  return a ? snapshotOne(a) : null;
}

// ---------------------------------------------------------------------------
// Status event bus
// ---------------------------------------------------------------------------

type Listener = (status: PortlessActionStatus) => void;
const listeners = new Set<Listener>();

export function onPortlessStatus(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function emit(a: RunningAction) {
  const snap = snapshotOne(a);
  for (const cb of listeners) {
    try { cb(snap); } catch {}
  }
}

type FiredListener = (info: { action: PortlessActionStatus; source: 'user' | 'agent'; sessionId?: string }) => void;
const firedListeners = new Set<FiredListener>();

/** Fired once when an action transitions from idle to starting/running.
 *  Used by the UI to pop a toast when the agent triggers a run via MCP. */
export function onPortlessActionFired(cb: FiredListener): () => void {
  firedListeners.add(cb);
  return () => firedListeners.delete(cb);
}

function emitFired(a: RunningAction, source: 'user' | 'agent', sessionId?: string) {
  const snap = snapshotOne(a);
  for (const cb of firedListeners) {
    try { cb({ action: snap, source, sessionId }); } catch {}
  }
}

/** External helper for callers that bypass `runAction` (e.g. MCP tools that
 *  spawn their own visible terminal) but still want the action-fired toast
 *  to pop. Takes a pre-built status snapshot — caller is responsible for
 *  shaping it correctly. */
export function emitPortlessActionFired(
  status: PortlessActionStatus,
  source: 'user' | 'agent',
  sessionId?: string,
): void {
  for (const cb of firedListeners) {
    try { cb({ action: status, source, sessionId }); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Resolved-URL event bus
//
// Portless 0.7 on a non-privileged shell can't bind :443, so the actual
// proxy URL it serves at is `http://<hostname>:1355` (or similar). The
// child process logs this as `PORTLESS_URL=...` on stdout right after
// boot. We parse that line and re-broadcast the resolved URL so the toast
// and the Project Settings pane can replace the optimistic
// `https://<hostname>` with the real reachable one.
// ---------------------------------------------------------------------------

export interface PortlessUrlResolvedDetail {
  key: string;
  groupId: string;
  actionId: string;
  /** Resolved URL with the actual proxy port (e.g. http://api.localhost:1355). */
  url: string;
}

type UrlResolvedListener = (detail: PortlessUrlResolvedDetail) => void;
const urlResolvedListeners = new Set<UrlResolvedListener>();

export function onPortlessUrlResolved(cb: UrlResolvedListener): () => void {
  urlResolvedListeners.add(cb);
  return () => urlResolvedListeners.delete(cb);
}

export function emitPortlessUrlResolved(detail: PortlessUrlResolvedDetail): void {
  for (const cb of urlResolvedListeners) {
    try { cb(detail); } catch {}
  }
}

/** Extract a `PORTLESS_URL=http(s)://…` substring from a chunk of stdout.
 *  Returns the URL or null. Used by both run paths (silent + MCP terminal)
 *  to find the actual proxy URL after portless boots. */
export function extractPortlessUrl(text: string): string | null {
  const m = text.match(/PORTLESS_URL=(https?:\/\/[^\s]+)/);
  return m ? m[1]! : null;
}

// ---------------------------------------------------------------------------
// Spawn / kill
// ---------------------------------------------------------------------------

/** Build the argv to hand `portless`:
 *
 *   portless <name> -- sh -c "<command>"
 *
 * The hostname/TLD and TLS behaviour are not configurable via CLI flags in
 * the supported portless versions (0.7+ accepts only `--force` and
 * `--app-port`). The TLD comes from the user's `portless.json` (default
 * `localhost`) and TLS is on unless the user disables it in that file.
 * We pass the leading hostname label as the app name — e.g.
 * `api.localhost` → `portless api -- …` — so the URL portless serves
 * matches the hostname the user sees in the Project Settings row. */
function buildArgs(input: PortlessActionInput): string[] {
  const appLabel = input.hostname.split('.')[0] || input.name;
  return [appLabel, '--', 'sh', '-c', input.command];
}

export type RunResult =
  | { ok: true; status: PortlessActionStatus }
  | { ok: false; error: string };

export function runAction(input: PortlessActionInput): RunResult {
  const cli = getPortlessCliStatus();
  if (!cli.available || !cli.bin) {
    return { ok: false, error: 'Portless CLI not found. Install with `npm install -g portless`.' };
  }
  if (!input.cwd) {
    return { ok: false, error: 'Project has no working directory set; configure cwd in Project Settings first.' };
  }
  if (!existsSync(input.cwd)) {
    return { ok: false, error: `Project cwd does not exist: ${input.cwd}` };
  }

  const key = actionKey(input.groupId, input.actionId);
  const existing = running.get(key);
  if (existing && (existing.state === 'starting' || existing.state === 'running')) {
    return { ok: true, status: snapshotOne(existing) };
  }

  const args = buildArgs(input);
  const scheme = input.noTls ? 'http' : 'https';
  const action: RunningAction = {
    key,
    groupId: input.groupId,
    actionId: input.actionId,
    name: input.name,
    command: input.command,
    hostname: input.hostname,
    url: `${scheme}://${input.hostname}`,
    cwd: input.cwd,
    pid: null,
    state: 'starting',
    startedAt: Date.now(),
    exitedAt: null,
    exitCode: null,
    lastError: null,
    logTail: [],
    proc: null,
    killTimer: null,
  };
  running.set(key, action);
  emit(action);

  let proc: PortlessProc;
  try {
    proc = spawn(cli.bin, args, {
      cwd: input.cwd,
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as PortlessProc;
  } catch (e: any) {
    action.state = 'failed';
    action.lastError = e?.message || String(e);
    action.exitedAt = Date.now();
    emit(action);
    return { ok: false, error: action.lastError ?? 'spawn failed' };
  }

  action.proc = proc;
  action.pid = proc.pid ?? null;

  // Treat the spawn as "running" once stdout/stderr is observed or after a
  // 600ms grace period — portless prints "▶ Routing https://… → :PORT" on
  // boot, which is our clearest readiness signal but takes a beat.
  let observedOutput = false;
  const readyTimer = setTimeout(() => {
    if (action.state === 'starting') {
      action.state = 'running';
      emit(action);
    }
  }, 600);

  const onLine = (chunk: Buffer | string) => {
    if (!observedOutput) {
      observedOutput = true;
      if (action.state === 'starting') {
        action.state = 'running';
        emit(action);
      }
    }
    const text = chunk.toString();
    const lines = text.split('\n');
    for (const raw of lines) {
      const line = raw.replace(/\r/g, '').trim();
      if (!line) continue;
      action.logTail.push(line);
      while (action.logTail.length > LOG_TAIL_LIMIT) action.logTail.shift();
      // First sighting of `PORTLESS_URL=...` is the canonical proxy URL —
      // replace our optimistic https://<hostname> guess with whatever the
      // CLI actually bound to (1355 etc.).
      const resolved = extractPortlessUrl(line);
      if (resolved && resolved !== action.url) {
        action.url = resolved;
        emit(action);
        emitPortlessUrlResolved({ key: action.key, groupId: action.groupId, actionId: action.actionId, url: resolved });
      }
    }
  };

  proc.stdout.on('data', onLine);
  proc.stderr.on('data', onLine);

  proc.on('error', (err) => {
    action.lastError = err.message || String(err);
    action.state = 'failed';
    action.exitedAt = Date.now();
    clearTimeout(readyTimer);
    if (action.killTimer) { clearTimeout(action.killTimer); action.killTimer = null; }
    emit(action);
    // Keep the entry around so the UI can show the error; user can re-run
    // to clear it (the next run overwrites the same key).
  });

  proc.on('exit', (code, signal) => {
    clearTimeout(readyTimer);
    if (action.killTimer) { clearTimeout(action.killTimer); action.killTimer = null; }
    action.exitedAt = Date.now();
    action.exitCode = typeof code === 'number' ? code : (signal ? -1 : null);
    if (action.state === 'stopping') {
      action.state = 'exited';
    } else if (code === 0) {
      action.state = 'exited';
    } else {
      action.state = 'failed';
      if (!action.lastError) {
        action.lastError = signal
          ? `terminated by ${signal}`
          : `portless exited with code ${code}`;
      }
    }
    emit(action);
    log(`[portless] ${action.name} (${action.hostname}) exited code=${code} signal=${signal}`);
  });

  emitFired(action, input.source || 'user', input.sessionId);
  log(`[portless] spawn ${action.name} (${action.hostname}) pid=${action.pid} cmd="${action.command}" cwd=${action.cwd}`);
  return { ok: true, status: snapshotOne(action) };
}

export function stopAction(groupId: string, actionId: string): boolean {
  const a = running.get(actionKey(groupId, actionId));
  if (!a || !a.proc || a.state === 'exited' || a.state === 'failed') return false;
  a.state = 'stopping';
  emit(a);
  try { a.proc.kill('SIGTERM'); } catch {}
  // SIGKILL fallback if SIGTERM isn't honoured promptly.
  a.killTimer = setTimeout(() => {
    if (a.proc && a.state === 'stopping') {
      try { a.proc.kill('SIGKILL'); } catch {}
    }
  }, 2000);
  return true;
}

export function stopAll(): void {
  for (const a of running.values()) {
    if (a.proc && (a.state === 'starting' || a.state === 'running')) {
      stopAction(a.groupId, a.actionId);
    }
  }
}

/** Remove an action's runtime entry — only valid when not running. Used by
 *  the UI after the user deletes an action row so stale exited entries
 *  don't linger. */
export function forgetAction(groupId: string, actionId: string): void {
  const key = actionKey(groupId, actionId);
  const a = running.get(key);
  if (!a) return;
  if (a.state === 'running' || a.state === 'starting' || a.state === 'stopping') return;
  running.delete(key);
}
