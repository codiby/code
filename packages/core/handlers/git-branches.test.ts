import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkoutBranch } from './git-checkout';
import { handleGitBranches } from './git';

let repo: string;
let worktree: string;

function git(...args: string[]): string {
  const r = Bun.spawnSync(['git', ...args], { cwd: repo });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'git-branches-'));
  worktree = mkdtempSync(join(tmpdir(), 'git-branches-wt-'));
  rmSync(worktree, { recursive: true, force: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  git('worktree', 'add', '-q', '-b', 'feat-wt', worktree);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(worktree, { recursive: true, force: true });
});

describe('handleGitBranches', () => {
  it('strips the worktree marker from branch names', async () => {
    const body = await (await handleGitBranches(repo)).json();
    expect(body.current).toBe('main');
    expect(body.local.sort()).toEqual(['feat-wt', 'main']);
  });

  it('points a listed worktree branch at its worktree on checkout', async () => {
    const { local } = await (await handleGitBranches(repo)).json();
    const r = await checkoutBranch(repo, { branch: local.find((b: string) => b !== 'main') });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(realpathSync(r.alreadyInWorktree!.path)).toBe(realpathSync(worktree));
  });
});
