/**
 * Side-effecting dependencies of the Google area, behind one seam so tests can
 * run the whole OAuth + Gmail + Calendar flow against a fake Google without a
 * network, a clock or a `tailscale` binary.
 */

import { existsSync } from 'fs';
import { logError } from '../../lib/logger';
import { sendToOwner } from '../outbox';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GoogleDeps {
  fetch: FetchLike;
  now(): number;
  /** Runs a read-only command (argv, never a shell string). */
  run(argv: string[], timeoutMs: number): Promise<CommandResult>;
  /** Path of the `tailscale` CLI, or null when it isn't installed. */
  tailscaleBin(): string | null;
  /** Tells the owner something went wrong with the connection. */
  notifyOwner(text: string): Promise<void>;
}

// launchd / systemd services run with a minimal PATH, so look in the usual places.
const TAILSCALE_CANDIDATES = [
  '/usr/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
];

function findTailscale(): string | null {
  const fromEnv = process.env.TAILSCALE_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  return TAILSCALE_CANDIDATES.find(p => existsSync(p)) ?? null;
}

async function runCommand(argv: string[], timeoutMs: number): Promise<CommandResult> {
  const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const timer = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

const defaults: GoogleDeps = {
  fetch: (url, init) => fetch(url, init),
  now: () => Date.now(),
  run: runCommand,
  tailscaleBin: findTailscale,
  async notifyOwner(text) {
    const res = await sendToOwner({ kind: 'text', text, priority: 'normal' });
    if (!res.ok) logError(`[google] could not tell the owner: ${res.error ?? 'no channel'}`);
  },
};

let current: GoogleDeps = { ...defaults };

export function googleDeps(): GoogleDeps {
  return current;
}

/** Tests only: override some dependencies; `null` restores the real ones. */
export function _setGoogleDepsForTest(patch: Partial<GoogleDeps> | null): void {
  current = patch ? { ...current, ...patch } : { ...defaults };
}
