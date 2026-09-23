import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const HOOKS = resolve(import.meta.dir, '../../.githooks');
const SCRIPT = resolve(import.meta.dir, 'bump-on-commit.ts');
const PKG = (version: string, extra = '') => `{\n  "name": "x",\n  "version": "${version}"${extra}\n}\n`;

let repo: string;

function git(args: string[], env: Record<string, string> = {}): string {
  const r = Bun.spawnSync(['git', ...args], { cwd: repo, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}
const committedVersion = (rev = 'HEAD') => JSON.parse(git(['show', `${rev}:package.json`])).version;
const workingPkg = () => readFileSync(join(repo, 'package.json'), 'utf8');

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'bump-hook-'));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  git(['config', 'commit.gpgsign', 'false']);
  cpSync(HOOKS, join(repo, '.githooks'), { recursive: true });
  mkdirSync(join(repo, 'scripts/hooks'), { recursive: true });
  cpSync(SCRIPT, join(repo, 'scripts/hooks/bump-on-commit.ts'));
  writeFileSync(join(repo, 'package.json'), PKG('0.30.0'));
  git(['add', '.']);
  git(['commit', '-qm', 'init']); // no hooks yet
  git(['config', 'core.hooksPath', '.githooks']);
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

function commitFile(name: string, msg: string, extraArgs: string[] = [], env: Record<string, string> = {}) {
  writeFileSync(join(repo, name), msg);
  git(['add', name]);
  git(['commit', '-qm', msg, ...extraArgs], env);
}

describe('pre-commit version bump', () => {
  it('bumps the patch on every commit', () => {
    commitFile('a.txt', 'one');
    expect(committedVersion()).toBe('0.30.1');
    commitFile('b.txt', 'two');
    expect(committedVersion()).toBe('0.30.2');
    expect(workingPkg()).toBe(PKG('0.30.2'));
  });

  it('commits only the version line, leaving other unstaged edits unstaged', () => {
    writeFileSync(join(repo, 'package.json'), PKG('0.30.0', ',\n  "wip": true'));
    commitFile('a.txt', 'one');
    expect(git(['show', 'HEAD:package.json'])).toBe(PKG('0.30.1').trim());
    expect(workingPkg()).toBe(PKG('0.30.1', ',\n  "wip": true'));
    expect(git(['diff', '--name-only'])).toBe('package.json');
  });

  it('does not bump again on --amend', () => {
    commitFile('a.txt', 'one');
    commitFile('a.txt', 'one, amended', ['--amend']);
    expect(committedVersion()).toBe('0.30.1');
  });

  it('keeps a manual release bump', () => {
    writeFileSync(join(repo, 'package.json'), PKG('0.31.0'));
    git(['add', 'package.json']);
    git(['commit', '-qm', 'release']);
    expect(committedVersion()).toBe('0.31.0');
  });

  it('honours SKIP_VERSION_BUMP=1', () => {
    commitFile('a.txt', 'one', [], { SKIP_VERSION_BUMP: '1' });
    expect(committedVersion()).toBe('0.30.0');
  });
});
