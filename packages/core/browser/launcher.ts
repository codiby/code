/**
 * Starts one Chromium process and returns its DevTools WebSocket endpoint.
 *
 * `--remote-debugging-port=0` lets Chromium pick a free port and write it,
 * with the browser endpoint path, to `<user-data-dir>/DevToolsActivePort` —
 * no port races between bridges and no stderr parsing.
 *
 * The sandbox stays on unless Chromium itself refuses to start with it (an
 * Ubuntu host that restricts unprivileged user namespaces, a root container);
 * only then do we retry with `--no-sandbox`, and say so in the log.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { Subprocess } from 'bun';
import type { ChromiumExecutable } from './discovery';

export const WINDOW_SIZE = { width: 1280, height: 900 };

export interface LaunchOptions {
  executable: ChromiumExecutable;
  userDataDir: string;
  sandbox: boolean;
  /** How long to wait for DevToolsActivePort. */
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  extraArgs?: string[];
}

export interface LaunchedChromium {
  proc: Subprocess;
  pid: number;
  wsEndpoint: string;
  port: number;
  sandbox: boolean;
  /** Resolves with the exit code once the process is gone. */
  exited: Promise<number | null>;
  /** Last few KB of stderr, for error messages. */
  stderrTail(): string;
}

export class LaunchError extends Error {
  constructor(message: string, readonly stderr: string, readonly sandboxRelated: boolean) {
    super(message);
    this.name = 'LaunchError';
  }
}

const STDERR_TAIL_BYTES = 8 * 1024;
const SANDBOX_FAILURE = /no usable sandbox|sandbox|setuid|user namespace|namespaces|zygote/i;

export function chromiumArgs(opts: { executable: ChromiumExecutable; userDataDir: string; sandbox: boolean; platform?: NodeJS.Platform; extraArgs?: string[] }): string[] {
  const platform = opts.platform ?? process.platform;
  const args = [
    // The headless shell is headless-only; full builds need the new headless mode.
    opts.executable.kind === 'headless-shell' ? '--headless' : '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${opts.userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    `--window-size=${WINDOW_SIZE.width},${WINDOW_SIZE.height}`,
    // Nobody looks at these windows, so Chromium would otherwise throttle
    // timers and skip frames — which turns waits and screenshots flaky.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-breakpad',
    '--mute-audio',
  ];
  // Keep the profile's cookie encryption off the OS keyring: on a server
  // there is no keyring daemon, and on a Mac it would prompt for Keychain access.
  if (platform === 'linux') args.push('--password-store=basic');
  if (platform === 'darwin') args.push('--use-mock-keychain');
  if (!opts.sandbox) args.push('--no-sandbox');
  if (opts.extraArgs?.length) args.push(...opts.extraArgs);
  args.push('about:blank');
  return args;
}

/**
 * Chromium's own password manager and autofill stay off in the managed
 * profile. Logins come from the vault through browser_fill_secret, which
 * checks the site and goes through the policy; a password Chromium saved by
 * itself (when the agent types into a login form) would sit in the profile
 * outside both, and autofill would hand it — or a saved address or card — to
 * any page that draws a matching form.
 */
export const MANAGED_PREFERENCES = {
  credentials_enable_service: false,
  credentials_enable_autosignin: false,
  profile: { password_manager_enabled: false, password_manager_leak_detection: false },
  autofill: { enabled: false, profile_enabled: false, credit_card_enabled: false },
  payments: { can_make_payment_enabled: false },
} as const;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

function mergeInto(base: Json, patch: Json): Json {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = isObject(v) ? mergeInto(isObject(base[k]) ? base[k] : {}, v) : v;
  return out;
}

/**
 * Write MANAGED_PREFERENCES into `<profile>/Default/Preferences` before
 * Chromium starts: on the profile's first launch, and again whenever they
 * drifted (a profile from before this existed). Everything else in the file
 * is kept. Returns whether the file was written. A file Chromium can't parse
 * either is left alone — Chromium rebuilds it, and the next launch fixes it.
 */
export function applyManagedPreferences(userDataDir: string): boolean {
  const dir = join(userDataDir, 'Default');
  const file = join(dir, 'Preferences');
  let current: Json = {};
  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'));
      if (!isObject(parsed)) return false;
      current = parsed;
    } catch {
      return false;
    }
  }
  const next = mergeInto(current, MANAGED_PREFERENCES as unknown as Json);
  if (JSON.stringify(next) === JSON.stringify(current)) return false;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.codiby-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
  renameSync(tmp, file);
  return true;
}

/** Parse `DevToolsActivePort`: line 1 is the port, line 2 the browser endpoint path. */
export function parseDevToolsActivePort(text: string): { port: number; path: string } | null {
  const [portLine, pathLine] = text.split('\n').map(l => l.trim());
  const port = Number(portLine);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  if (!pathLine || !pathLine.startsWith('/devtools/browser/')) return null;
  return { port, path: pathLine };
}

function drain(stream: ReadableStream<Uint8Array> | null | undefined, onChunk: (text: string) => void): void {
  if (!stream) return;
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) onChunk(decoder.decode(chunk, { stream: true }));
    } catch {}
  })();
}

export async function launchChromium(opts: LaunchOptions): Promise<LaunchedChromium> {
  mkdirSync(opts.userDataDir, { recursive: true, mode: 0o700 });
  // Never fatal: a browser without these settings still beats no browser.
  try { applyManagedPreferences(opts.userDataDir); } catch {}
  const portFile = join(opts.userDataDir, 'DevToolsActivePort');
  // A file left by a previous run would hand us a dead port.
  rmSync(portFile, { force: true });

  const argv = [opts.executable.path, ...chromiumArgs(opts)];
  let proc: Subprocess;
  try {
    proc = Bun.spawn(argv, { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' });
  } catch (err) {
    throw new LaunchError(`Could not start ${opts.executable.path}: ${err instanceof Error ? err.message : String(err)}`, '', false);
  }

  // Chromium logs a lot to stderr; the pipe has to be drained for the whole
  // life of the process or it blocks once the buffer fills.
  let tail = '';
  drain(proc.stderr as ReadableStream<Uint8Array>, (text) => {
    tail = (tail + text).slice(-STDERR_TAIL_BYTES);
  });

  let exitCode: number | null | undefined;
  const exited = proc.exited.then((code) => { exitCode = code; return code; }, () => { exitCode = null; return null; });

  const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
  while (Date.now() < deadline) {
    if (exitCode !== undefined) {
      // Give the drain loop a moment to collect the last stderr lines.
      await Bun.sleep(50);
      const stderr = tail.trim();
      const sandboxRelated = opts.sandbox && SANDBOX_FAILURE.test(stderr);
      const lastLines = stderr.split('\n').slice(-4).join(' | ');
      throw new LaunchError(`Chromium exited during startup (code ${exitCode})${lastLines ? `: ${lastLines}` : ''}`, stderr, sandboxRelated);
    }
    if (existsSync(portFile)) {
      let parsed: { port: number; path: string } | null = null;
      try { parsed = parseDevToolsActivePort(readFileSync(portFile, 'utf-8')); } catch {}
      if (parsed) {
        return {
          proc,
          pid: proc.pid,
          wsEndpoint: `ws://127.0.0.1:${parsed.port}${parsed.path}`,
          port: parsed.port,
          sandbox: opts.sandbox,
          exited,
          stderrTail: () => tail,
        };
      }
    }
    await Bun.sleep(50);
  }
  try { proc.kill('SIGKILL'); } catch {}
  throw new LaunchError(`Chromium did not open its DevTools port within ${Math.round((opts.timeoutMs ?? 20_000) / 1000)}s`, tail.trim(), false);
}

/**
 * Launch with the sandbox, falling back to `--no-sandbox` only when the
 * failure is the sandbox's. `preferNoSandbox` skips the doomed first attempt
 * once a host has shown it needs the fallback.
 */
export async function launchWithSandboxFallback(
  opts: Omit<LaunchOptions, 'sandbox'> & { preferNoSandbox?: boolean; onSandboxFallback?: (err: LaunchError) => void },
  launch: (o: LaunchOptions) => Promise<LaunchedChromium> = launchChromium,
): Promise<LaunchedChromium> {
  if (opts.preferNoSandbox) return launch({ ...opts, sandbox: false });
  try {
    return await launch({ ...opts, sandbox: true });
  } catch (err) {
    if (!(err instanceof LaunchError) || !err.sandboxRelated) throw err;
    opts.onSandboxFallback?.(err);
    return launch({ ...opts, sandbox: false });
  }
}
