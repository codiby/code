/**
 * Worktree placement and repo resolution.
 *
 * The layout is `<repo>/.worktrees/<branch>` — inside the project, so the
 * owning repo is readable off the path and two repos under a shared parent
 * can't collide. The previous layout put worktrees at `<repo-parent>/.wt/`,
 * one level *outside* the repo, which broke every consumer that recovered the
 * repo by trimming the path: they landed on the containing directory instead.
 *
 * These tests run against real git repos in a temp dir, because the whole
 * point of `rootRepoOf` is that it asks git rather than slicing strings.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createWorktree, rootRepoOf, WORKTREES_DIRNAME, WORKTREE_CWD_RE } from './worktree';

const roots: string[] = [];

/** A throwaway git repo with one commit, at `<tmp>/<name>`. */
function makeRepo(name: string): { root: string; repo: string } {
  const root = mkdtempSync(join(tmpdir(), 'wt-test-'));
  roots.push(root);
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  execSync('git init -q .', { cwd: repo });
  execSync('git config user.email t@t.t && git config user.name t', { cwd: repo });
  execSync('git commit -q --allow-empty -m init', { cwd: repo });
  return { root, repo };
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('createWorktree placement', () => {
  test('creates the worktree inside the repo, under .worktrees/', () => {
    const { repo } = makeRepo('utilityprofit');
    const { path, branch } = createWorktree({ repoPath: repo, branch: 'feat-a', newBranch: true });
    expect(branch).toBe('feat-a');
    // Resolved through the filesystem, so compare on the tail rather than the
    // full string (macOS reports /private/var for /var).
    expect(path.endsWith(join('utilityprofit', WORKTREES_DIRNAME, 'feat-a'))).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  test('the nested worktree does not show up in the repo\'s git status', () => {
    const { repo } = makeRepo('proj');
    createWorktree({ repoPath: repo, branch: 'feat-b', newBranch: true });
    const status = execSync('git status --short', { cwd: repo }).toString().trim();
    expect(status).toBe('');
  });

  test('the exclude entry is written once, not appended per worktree', () => {
    const { repo } = makeRepo('proj');
    createWorktree({ repoPath: repo, branch: 'one', newBranch: true });
    createWorktree({ repoPath: repo, branch: 'two', newBranch: true });
    const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
    const hits = exclude.split(/\r?\n/).filter(l => l.trim() === `${WORKTREES_DIRNAME}/`);
    expect(hits).toHaveLength(1);
  });

  test('spawning from inside a worktree stays flat, beside its sibling', () => {
    const { repo } = makeRepo('proj');
    const first = createWorktree({ repoPath: repo, branch: 'feat-a', newBranch: true });
    // Same call again, but sourced from the worktree rather than the repo root.
    const second = createWorktree({ repoPath: first.path, branch: 'feat-b', newBranch: true });
    expect(second.path.startsWith(first.path)).toBe(false);
    expect(second.path.endsWith(join(WORKTREES_DIRNAME, 'feat-b'))).toBe(true);
    // Both siblings under one directory: trimming the branch leaves the same dir.
    expect(second.path.slice(0, -'feat-b'.length)).toBe(first.path.slice(0, -'feat-a'.length));
  });

  test('two repos sharing a parent no longer collide on the same branch name', () => {
    const { repo: a } = makeRepo('repo-a');
    const { repo: b } = makeRepo('repo-b');
    const wtA = createWorktree({ repoPath: a, branch: 'shared', newBranch: true });
    const wtB = createWorktree({ repoPath: b, branch: 'shared', newBranch: true });
    expect(wtA.path).not.toBe(wtB.path);
  });
});

describe('rootRepoOf', () => {
  test('resolves the repo from a worktree in the current layout', () => {
    const { repo } = makeRepo('proj');
    const { path } = createWorktree({ repoPath: repo, branch: 'feat-a', newBranch: true });
    const real = execSync('pwd -P', { cwd: repo }).toString().trim();
    expect(rootRepoOf(path)).toBe(real);
  });

  test('resolves the repo from a legacy <repo-parent>/.wt/<branch> worktree', () => {
    const { root, repo } = makeRepo('proj');
    const legacy = join(root, '.wt', 'old-branch');
    execSync(`git worktree add -q "${legacy}" -b old-branch`, { cwd: repo });
    const real = execSync('pwd -P', { cwd: repo }).toString().trim();
    // The path itself says "the repo is <root>" — only git knows better.
    expect(legacy.match(WORKTREE_CWD_RE)?.[1]).toBe(root);
    expect(rootRepoOf(legacy)).toBe(real);
  });

  test('resolves the repo from the repo root and from a subdirectory', () => {
    const { repo } = makeRepo('proj');
    const sub = join(repo, 'packages', 'ui');
    mkdirSync(sub, { recursive: true });
    const real = execSync('pwd -P', { cwd: repo }).toString().trim();
    expect(rootRepoOf(repo)).toBe(real);
    expect(rootRepoOf(sub)).toBe(real);
  });

  test('returns null outside a repo and for a path that does not exist', () => {
    const bare = mkdtempSync(join(tmpdir(), 'wt-test-bare-'));
    roots.push(bare);
    expect(rootRepoOf(bare)).toBeNull();
    expect(rootRepoOf(join(bare, 'nope'))).toBeNull();
    expect(rootRepoOf('')).toBeNull();
  });
});
