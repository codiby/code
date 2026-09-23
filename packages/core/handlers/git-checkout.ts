/**
 * `POST /git-checkout` — switch branches, and when local changes block the
 * switch, get them out of the way on request.
 *
 * A plain checkout that git refuses because of uncommitted changes answers with
 * `dirty`: the current branch and every changed file. The composer then offers
 * to stash or commit them under a message the user typed, and calls back with
 * `resolve`. After a stash, `restoreStash` (the stash's sha) undoes the whole
 * thing: back to the old branch, stash popped.
 *
 * Git runs from an argv array, not `sh -c`: the stash/commit message is free
 * text from a textarea, and an agent can drive this same route.
 */

import { corsHeaders } from '../config/config';

const GIT_TIMEOUT = 15000;
// Commit hooks (lint-staged, typecheck) routinely take longer than a checkout.
const COMMIT_TIMEOUT = 120000;

type GitResult = { ok: boolean; stdout: string; stderr: string };

export async function runGit(args: string[], cwd: string, timeout = GIT_TIMEOUT): Promise<GitResult> {
  let proc: ReturnType<typeof Bun.spawn<'ignore', 'pipe', 'pipe'>>;
  try {
    proc = Bun.spawn(['git', ...args], {
      cwd,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
  } catch (e: any) {
    // A cwd that doesn't exist throws synchronously instead of exiting non-zero.
    return { ok: false, stdout: '', stderr: String(e?.message || e) };
  }
  const timer = setTimeout(() => { try { proc.kill(); } catch {} }, timeout);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { ok: (await proc.exited) === 0, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

const output = (r: GitResult) => (r.stderr + r.stdout).trim();

export type DirtyFile = { path: string; status: string; additions?: number; deletions?: number };

export type CheckoutRequest = {
  branch: string;
  resolve?: { mode: 'stash' | 'commit'; message: string; includeUntracked?: boolean };
  /** Sha of a stash made by an earlier `resolve: stash`; popped after switching. */
  restoreStash?: string;
};

export type CheckoutResult =
  | { ok: true; branch: string; previous: string; stash?: { sha: string; message: string }; warning?: string }
  | { ok: false; error: string; dirty?: { current: string; files: DirtyFile[] }; alreadyInWorktree?: { path: string; branch: string } };

/** git's two refusals that mean "your working tree is in the way". */
const DIRTY_RE = /would be overwritten by checkout|untracked working tree files would be (?:overwritten|removed)/i;

async function currentBranch(cwd: string): Promise<string> {
  return (await runGit(['branch', '--show-current'], cwd)).stdout.trim();
}

/** Everything a stash or commit would take, with line counts where git has them. */
export async function dirtyFiles(cwd: string): Promise<DirtyFile[]> {
  const status = await runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd);
  const numstat = await runGit(['diff', 'HEAD', '--numstat', '-z'], cwd);
  const stats = new Map<string, { additions: number; deletions: number }>();
  // -z numstat: "<a>\t<d>\t<path>\0"; renames put the paths in the next two fields.
  const parts = numstat.stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const [a, d, path] = parts[i]!.split('\t');
    if (a === undefined || d === undefined || path === undefined) continue;
    const target = path === '' ? parts[i += 2] : path;
    if (target) stats.set(target, { additions: a === '-' ? 0 : Number(a), deletions: d === '-' ? 0 : Number(d) });
  }
  const files: DirtyFile[] = [];
  const entries = status.stdout.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    // A rename's source path follows as its own entry.
    if (xy[0] === 'R' || xy[0] === 'C') i++;
    const status = xy === '??' ? '?' : (xy.trim()[0] || 'M');
    files.push({ path, status, ...stats.get(path) });
  }
  return files;
}

/** `stash@{n}` for a stash sha, or null once it has been dropped. */
async function stashRef(cwd: string, sha: string): Promise<string | null> {
  const list = await runGit(['stash', 'list', '--format=%H'], cwd);
  const index = list.stdout.split('\n').map(s => s.trim()).indexOf(sha);
  return index < 0 ? null : `stash@{${index}}`;
}

async function checkout(cwd: string, branch: string): Promise<GitResult> {
  return runGit(['checkout', branch], cwd);
}

function checkoutFailure(r: GitResult, branch: string): CheckoutResult {
  // `fatal: '<branch>' is already used by worktree at '<path>'` — the caller
  // switches into that worktree instead of failing.
  const msg = output(r);
  const m = msg.match(/already (?:used by|checked out at) worktree at ['"]?([^'"\n]+)['"]?/i)
    || msg.match(/is already checked out at ['"]?([^'"\n]+)['"]?/i);
  if (m) return { ok: false, error: msg, alreadyInWorktree: { path: m[1]!.trim(), branch } };
  return { ok: false, error: msg };
}

export async function checkoutBranch(cwd: string, req: CheckoutRequest): Promise<CheckoutResult> {
  const { branch } = req;
  const previous = await currentBranch(cwd);

  if (req.resolve) {
    const message = req.resolve.message.trim();
    if (!message) return { ok: false, error: 'A message is required' };
    const includeUntracked = req.resolve.includeUntracked !== false;

    if (req.resolve.mode === 'stash') {
      const pushed = await runGit(['stash', 'push', ...(includeUntracked ? ['--include-untracked'] : []), '-m', message], cwd);
      if (!pushed.ok) return { ok: false, error: output(pushed) };
      const sha = (await runGit(['rev-parse', 'stash@{0}'], cwd)).stdout.trim();
      const switched = await checkout(cwd, branch);
      if (!switched.ok) {
        // Leave the tree the way the user had it rather than half-done.
        const ref = await stashRef(cwd, sha);
        if (ref) await runGit(['stash', 'pop', ref], cwd);
        return checkoutFailure(switched, branch);
      }
      return { ok: true, branch: await currentBranch(cwd), previous, stash: { sha, message } };
    }

    const added = await runGit(['add', includeUntracked ? '--all' : '--update'], cwd);
    if (!added.ok) return { ok: false, error: output(added) };
    const committed = await runGit(['commit', '-m', message], cwd, COMMIT_TIMEOUT);
    if (!committed.ok) return { ok: false, error: `Commit failed: ${output(committed)}` };
    const switched = await checkout(cwd, branch);
    if (!switched.ok) return checkoutFailure(switched, branch);
    return { ok: true, branch: await currentBranch(cwd), previous };
  }

  const switched = await checkout(cwd, branch);
  if (!switched.ok) {
    const failure = checkoutFailure(switched, branch);
    if (!failure.ok && !failure.alreadyInWorktree && DIRTY_RE.test(failure.error)) {
      return { ...failure, dirty: { current: previous, files: await dirtyFiles(cwd) } };
    }
    return failure;
  }

  if (req.restoreStash) {
    const ref = await stashRef(cwd, req.restoreStash);
    if (!ref) return { ok: true, branch: await currentBranch(cwd), previous, warning: 'The stash was already applied or dropped' };
    const popped = await runGit(['stash', 'pop', ref], cwd);
    if (!popped.ok) return { ok: true, branch: await currentBranch(cwd), previous, warning: `Switched back, but the stash did not apply cleanly: ${output(popped)}` };
  }
  return { ok: true, branch: await currentBranch(cwd), previous };
}

export async function handleGitCheckout(cwd: string, req: CheckoutRequest): Promise<Response> {
  const result = await checkoutBranch(cwd, req);
  const status = result.ok ? 200 : (result.dirty || result.alreadyInWorktree ? 409 : 400);
  return Response.json(result, { status, headers: corsHeaders });
}
