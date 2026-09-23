/**
 * `POST /self-update` — a Linux bridge running from a git checkout under the
 * systemd user unit updates itself: fast-forward the checkout, then have
 * systemd restart the unit. process-compose reinstalls deps and rebuilds the
 * frontends on the way back up.
 *
 * Anything else — the macOS app's bundled `server.js`, a dev bridge from
 * `run.sh`, a system-level unit — answers `canSelfUpdate: false` on `/host`
 * with the reason, and the desktop keeps showing the manual command.
 *
 * Restarting kills every session on this host. The desktop asks first.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { corsHeaders } from '../config/config';
import { runGit } from './git-checkout';

// packages/core/handlers → repo root. Inside the macOS app this lands in the
// bundle's Resources, which is not a git checkout.
const ROOT = resolve(import.meta.dir, '../../..');
const PULL_TIMEOUT = 60000;

/** The commit this process started from, read once at load. */
export const BOOT_COMMIT: string | null = (() => {
  try {
    const r = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: ROOT, stdout: 'pipe', stderr: 'ignore' });
    return r.exitCode === 0 ? r.stdout.toString().trim() : null;
  } catch { return null; }
})();

/** The systemd *user* unit this process runs in, from its cgroup path
 *  (`…/user@1000.service/app.slice/codiby-code.service`). */
export function userUnitFromCgroup(cgroup: string): string | null {
  const line = cgroup.split('\n').find(l => l.startsWith('0::')) ?? '';
  if (!/\/user@\d+\.service\//.test(line)) return null;
  return line.match(/\/([^/]+\.service)$/)?.[1] ?? null;
}

type Support = { canSelfUpdate: true; unit: string } | { canSelfUpdate: false; reason: string };

let support: Support | undefined;
export function selfUpdateSupport(): Support {
  if (support) return support;
  let cgroup = '';
  try { cgroup = readFileSync('/proc/self/cgroup', 'utf8'); } catch {}
  const unit = userUnitFromCgroup(cgroup);
  if (!unit) support = { canSelfUpdate: false, reason: 'Not running under a systemd user unit' };
  else if (!BOOT_COMMIT || !existsSync(join(ROOT, '.git'))) support = { canSelfUpdate: false, reason: 'Not running from a git checkout' };
  else support = { canSelfUpdate: true, unit };
  return support;
}

const output = (r: { stdout: string; stderr: string }) => (r.stderr + r.stdout).trim();

export type SelfUpdateResult =
  | { ok: true; restarting: boolean; commit: string; version: string; branch: string }
  | { ok: false; error: string };

export async function selfUpdate(): Promise<SelfUpdateResult> {
  const s = selfUpdateSupport();
  if (!s.canSelfUpdate) return { ok: false, error: s.reason };

  // Untracked files (logs, local notes) don't block a fast-forward; edits do.
  const dirty = await runGit(['status', '--porcelain', '--untracked-files=no'], ROOT);
  if (dirty.stdout.trim()) {
    return { ok: false, error: `The checkout at ${ROOT} has local changes:\n${dirty.stdout.trim()}` };
  }
  const branch = (await runGit(['branch', '--show-current'], ROOT)).stdout.trim();
  const pulled = await runGit(['pull', '--ff-only'], ROOT, PULL_TIMEOUT);
  if (!pulled.ok) return { ok: false, error: `git pull failed: ${output(pulled)}` };

  const commit = (await runGit(['rev-parse', 'HEAD'], ROOT)).stdout.trim();
  let version = '';
  try { version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version; } catch {}
  // Already running this commit: a restart would only drop sessions.
  const restarting = commit !== BOOT_COMMIT;
  if (restarting) {
    // After the response is out. `--no-block` queues the job with systemd,
    // which then kills this whole cgroup — including us — and starts over.
    setTimeout(() => {
      try { Bun.spawn(['systemctl', '--user', '--no-block', 'restart', s.unit], { stdio: ['ignore', 'ignore', 'ignore'] }); } catch {}
    }, 500);
  }
  return { ok: true, restarting, commit, version, branch };
}

export async function handleSelfUpdate(): Promise<Response> {
  const result = await selfUpdate();
  return Response.json(result, { status: result.ok ? 200 : 409, headers: corsHeaders });
}
