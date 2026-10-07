import { expect, test } from 'bun:test';
import type { HostMemory, MemoryFileInfo, ProjectMemoryInfo } from './claude-client';
import { planSync, presenceOf } from './memory-sync';

const file = (name: string, hash: string, mtime = 1): MemoryFileInfo =>
  ({ name, path: `/m/${name}`, hash, size: 1, mtime, type: null, description: null });
const project = (key: string, slug: string, files: MemoryFileInfo[]): ProjectMemoryInfo =>
  ({ key, slug, name: key.split('/').pop()!, path: `/${slug}`, dir: `/${slug}/memory`, files });
const host = (projects: ProjectMemoryInfo[], claude?: { hash: string; mtime: number }): HostMemory => ({
  hostname: 'h', shareAcrossProviders: true, projects,
  user: [
    { provider: 'claude', path: '~/.claude/CLAUDE.md', exists: !!claude, hash: claude?.hash ?? null, size: 1, mtime: claude?.mtime ?? null },
    { provider: 'codex', path: '~/.codex/AGENTS.md', exists: false, hash: null, size: 0, mtime: null },
    { provider: 'opencode', path: '~/.config/opencode/AGENTS.md', exists: false, hash: null, size: 0, mtime: null },
  ],
});

const mac = host([
  project('github.com/o/code', '-Users-me-src-code', [file('MEMORY.md', 'i1'), file('a.md', 'x'), file('b.md', 'b1', 5), file('only-mac.md', 'm')]),
  project('scratch', '-Users-me-scratch', [file('MEMORY.md', 'i'), file('n.md', 'n')]),
], { hash: 'c1', mtime: 10 });
const linux = host([
  project('github.com/o/code', '-home-me-src-code', [file('MEMORY.md', 'i2'), file('a.md', 'x'), file('b.md', 'b2', 9), file('only-linux.md', 'l')]),
], { hash: 'c2', mtime: 5 });

test('pairs projects by key across different paths and skips the index and identical files', () => {
  const { items } = planSync(mac, linux, 'both');
  const files = items.filter(i => i.targets.a.scope === 'project').map(i => i.file);
  expect(files).toEqual(['b.md', 'only-linux.md', 'only-mac.md']);
  const onlyMac = items.find(i => i.file === 'only-mac.md')!;
  expect(onlyMac.from).toBe('a');
  expect(onlyMac.targets.b).toEqual({ scope: 'project', slug: '-home-me-src-code', name: 'only-mac.md' });
});

test('conflicts default to the newer copy in both-way mode', () => {
  const { items } = planSync(mac, linux, 'both');
  expect(items.find(i => i.file === 'b.md')).toMatchObject({ conflict: true, from: 'b' });
  expect(items.find(i => i.id === 'user:claude')).toMatchObject({ conflict: true, from: 'a' });
});

test('push and pull only move one way', () => {
  const push = planSync(mac, linux, 'push').items;
  expect(push.every(i => i.from === 'a')).toBe(true);
  expect(push.some(i => i.file === 'only-linux.md')).toBe(false);
  const pull = planSync(mac, linux, 'pull').items;
  expect(pull.every(i => i.from === 'b')).toBe(true);
  expect(pull.some(i => i.file === 'only-mac.md')).toBe(false);
});

test('projects the other host never opened are reported, not synced', () => {
  expect(planSync(mac, linux, 'both').unpaired).toEqual([{ side: 'a', name: 'scratch' }]);
});

test('presence compares one file against another host', () => {
  expect(presenceOf(mac, linux, { scope: 'project', key: 'github.com/o/code', name: 'a.md' })).toBe('same');
  expect(presenceOf(mac, linux, { scope: 'project', key: 'github.com/o/code', name: 'b.md' })).toBe('differs');
  expect(presenceOf(mac, linux, { scope: 'project', key: 'github.com/o/code', name: 'only-mac.md' })).toBe('missing');
  expect(presenceOf(mac, linux, { scope: 'project', key: 'scratch', name: 'n.md' })).toBe('unpaired');
  expect(presenceOf(mac, linux, { scope: 'user', provider: 'codex' })).toBe('missing');
});
