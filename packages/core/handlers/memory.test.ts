import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  deleteMemory,
  listProjectMemory,
  listUserMemory,
  normalizeRemoteUrl,
  parseMemoryFrontmatter,
  parseMemoryTarget,
  projectSlug,
  writeMemory,
} from './memory';
import { buildSharedMemoryPrompt } from '../provider/shared-memory';

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'memory-'));
  const repo = join(home, 'src', 'my.repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  writeFileSync(join(repo, '.git', 'config'), '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:Owner/My.Repo.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');
  const projectDir = join(home, '.claude', 'projects', projectSlug(repo));
  mkdirSync(join(projectDir, 'memory'), { recursive: true });
  writeFileSync(join(projectDir, 'abc.jsonl'), `{"type":"user","cwd":${JSON.stringify(repo)}}\n`);
  writeFileSync(join(projectDir, 'memory', 'MEMORY.md'), '- [Use bun](use-bun.md) — prefer bun\n');
  writeFileSync(join(projectDir, 'memory', 'use-bun.md'), '---\nname: use-bun\ndescription: prefer bun\nmetadata:\n  type: feedback\n---\n\nUse bun.\n');
  return { home, repo, slug: projectSlug(repo), memDir: join(projectDir, 'memory') };
}

test('slug matches Claude Code project directory naming', () => {
  expect(projectSlug('/Users/jovaz/src/up/.wt/bug-f68')).toBe('-Users-jovaz-src-up--wt-bug-f68');
});

test('remote urls normalize across ssh and https forms', () => {
  expect(normalizeRemoteUrl('git@github.com:Owner/Repo.git')).toBe('github.com/owner/repo');
  expect(normalizeRemoteUrl('https://github.com/Owner/Repo.git')).toBe('github.com/owner/repo');
  expect(normalizeRemoteUrl('ssh://git@host:2222/owner/repo')).toBe('host:2222/owner/repo');
});

test('frontmatter type is read from top level or metadata', () => {
  expect(parseMemoryFrontmatter('---\nname: a\nmetadata:\n  type: project\n---\nx').type).toBe('project');
  expect(parseMemoryFrontmatter('---\ntype: user\ndescription: "quoted"\n---').description).toBe('quoted');
  expect(parseMemoryFrontmatter('no frontmatter')).toEqual({});
});

test('lists project memory with real path and git-derived key', () => {
  const { home, repo } = fixture();
  const [p] = listProjectMemory(home);
  expect(p.path).toBe(repo);
  expect(p.name).toBe('my.repo');
  expect(p.key).toBe('github.com/owner/my.repo');
  expect(p.files.map(f => f.name)).toEqual(['MEMORY.md', 'use-bun.md']);
  expect(p.files[1].type).toBe('feedback');
});

test('user memory reports missing files without failing', () => {
  const { home } = fixture();
  writeFileSync(join(home, '.claude', 'CLAUDE.md'), '# Global');
  const user = listUserMemory(home);
  expect(user.find(u => u.provider === 'claude')?.exists).toBe(true);
  expect(user.find(u => u.provider === 'opencode')?.exists).toBe(false);
});

test('writing a new memory indexes it once and deleting unindexes it', () => {
  const { home, slug, memDir } = fixture();
  const content = '---\nname: new-fact\ndescription: something learned\n---\nbody';
  writeMemory({ scope: 'project', slug, name: 'new-fact.md' }, content, home);
  writeMemory({ scope: 'project', slug, name: 'new-fact.md' }, content, home);
  const index = readFileSync(join(memDir, 'MEMORY.md'), 'utf-8');
  expect(index.match(/\(new-fact\.md\)/g)?.length).toBe(1);
  expect(index).toContain('- [new-fact](new-fact.md) — something learned');
  expect(deleteMemory({ scope: 'project', slug, name: 'new-fact.md' }, home)).toBe(true);
  expect(readFileSync(join(memDir, 'MEMORY.md'), 'utf-8')).not.toContain('new-fact');
});

test('writing to a project this host never opened is refused', () => {
  const { home } = fixture();
  expect(() => writeMemory({ scope: 'project', slug: '-nope', name: 'a.md' }, 'x', home)).toThrow('project not found');
});

test('targets reject path traversal', () => {
  expect(parseMemoryTarget(new URLSearchParams('scope=project&slug=../x&name=a.md'))).toBe('invalid slug');
  expect(parseMemoryTarget(new URLSearchParams('scope=project&slug=a&name=../b.md'))).toBe('invalid file name');
  expect(parseMemoryTarget(new URLSearchParams('scope=user&provider=evil'))).toBeString();
});

test('codex sessions get Claude memory; claude sessions get Codex memory', () => {
  const { home, repo } = fixture();
  writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'Claude global rule');
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(join(home, '.codex', 'AGENTS.md'), 'Codex global rule');

  const forCodex = buildSharedMemoryPrompt('codex', repo, home)!;
  expect(forCodex).toContain('Claude global rule');
  expect(forCodex).not.toContain('Codex global rule');
  expect(forCodex).toContain('[Use bun](use-bun.md)');

  const forClaude = buildSharedMemoryPrompt('claude', repo, home)!;
  expect(forClaude).toContain('Codex global rule');
  expect(forClaude).not.toContain('Claude global rule');
  // Claude already loads its own project memory.
  expect(forClaude).not.toContain('use-bun.md');
});

test('identical instruction files are not duplicated', () => {
  const { home, repo } = fixture();
  writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'Same rule');
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(join(home, '.codex', 'AGENTS.md'), 'Same rule');
  expect(buildSharedMemoryPrompt('claude', join(home, 'elsewhere'), home)).toBeNull();
  expect(buildSharedMemoryPrompt('opencode', repo, home)!.match(/Same rule/g)?.length).toBe(1);
});
