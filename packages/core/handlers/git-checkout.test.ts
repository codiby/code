import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkoutBranch } from './git-checkout';

let repo: string;

function git(...args: string[]): string {
  const r = Bun.spawnSync(['git', ...args], { cwd: repo });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

// `main` and `other` disagree on a.txt, so a dirty a.txt blocks the switch.
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'git-checkout-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  git('checkout', '-qb', 'other');
  writeFileSync(join(repo, 'a.txt'), 'two\n');
  git('commit', '-qam', 'other');
  git('checkout', '-q', 'main');
  writeFileSync(join(repo, 'a.txt'), 'dirty\n');
  writeFileSync(join(repo, 'new.txt'), 'untracked\n');
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('checkoutBranch', () => {
  it('reports the blocking changes instead of just failing', async () => {
    const r = await checkoutBranch(repo, { branch: 'other' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.dirty?.current).toBe('main');
    expect(r.dirty?.files).toEqual([
      { path: 'a.txt', status: 'M', additions: 1, deletions: 1 },
      { path: 'new.txt', status: '?' },
    ]);
    expect(git('branch', '--show-current')).toBe('main');
  });

  it('stashes under the given message, switches, and undoes back', async () => {
    const r = await checkoutBranch(repo, { branch: 'other', resolve: { mode: 'stash', message: 'wip "quoted" $(nope)' } });
    expect(r).toMatchObject({ ok: true, branch: 'other', previous: 'main' });
    expect(git('stash', 'list', '--format=%s')).toBe('On main: wip "quoted" $(nope)');
    if (!r.ok || !r.stash) throw new Error('expected a stash');

    const undo = await checkoutBranch(repo, { branch: 'main', restoreStash: r.stash.sha });
    expect(undo).toMatchObject({ ok: true, branch: 'main' });
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('dirty\n');
    expect(readFileSync(join(repo, 'new.txt'), 'utf8')).toBe('untracked\n');
    expect(git('stash', 'list')).toBe('');
  });

  it('commits on the current branch, then switches', async () => {
    const r = await checkoutBranch(repo, { branch: 'other', resolve: { mode: 'commit', message: 'wip sidebar' } });
    expect(r).toMatchObject({ ok: true, branch: 'other', previous: 'main' });
    expect(git('log', '-1', '--format=%s', 'main')).toBe('wip sidebar');
    expect(git('show', '--name-only', '--format=', 'main')).toBe('a.txt\nnew.txt');
  });

  it('leaves untracked files out of a commit when asked', async () => {
    await checkoutBranch(repo, { branch: 'other', resolve: { mode: 'commit', message: 'tracked only', includeUntracked: false } });
    expect(git('show', '--name-only', '--format=', 'main')).toBe('a.txt');
  });

  it('refuses to resolve without a message', async () => {
    const r = await checkoutBranch(repo, { branch: 'other', resolve: { mode: 'stash', message: '  ' } });
    expect(r).toEqual({ ok: false, error: 'A message is required' });
  });

  it('puts the stash back when the checkout itself fails', async () => {
    const r = await checkoutBranch(repo, { branch: 'does-not-exist', resolve: { mode: 'stash', message: 'x' } });
    expect(r.ok).toBe(false);
    expect(git('stash', 'list')).toBe('');
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('dirty\n');
  });
});
