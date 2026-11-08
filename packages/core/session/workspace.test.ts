import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Session } from '../types';
import { additionalDirsFor, isWorkspaceRead, resolveDirectory, spawnCwdFor, workspaceDirs, workspacePrompt } from './workspace';

const session = (patch: Partial<Session> = {}) =>
  ({ id: 's1', cwd: '/repo/a', additionalDirectories: [], provider: 'claude', providerCwd: null, ...patch }) as Session;

describe('workspace', () => {
  test('lists the cwd first, without duplicates', () => {
    expect(workspaceDirs(session({ additionalDirectories: ['/repo/b', '/repo/a', '/repo/b'] }))).toEqual(['/repo/a', '/repo/b']);
    expect(additionalDirsFor(session({ additionalDirectories: ['/repo/b'] }), '/repo/b')).toEqual(['/repo/a']);
  });

  test('a resume spawns where the conversation started, except on Codex', () => {
    const moved = session({ cwd: '/repo/b', providerCwd: '/repo/a' });
    expect(spawnCwdFor(moved, true)).toBe('/repo/a');
    expect(spawnCwdFor(moved, false)).toBe('/repo/b');
    expect(spawnCwdFor({ ...moved, provider: 'codex' } as Session, true)).toBe('/repo/b');
  });

  test('prompts only for a workspace beyond the spawn cwd', () => {
    expect(workspacePrompt(session(), '/repo/a')).toBeNull();
    expect(workspacePrompt(session({ cwd: '/repo/b' }), '/repo/a')).toContain('later moved');
    expect(workspacePrompt(session({ additionalDirectories: ['/repo/c'] }), '/repo/a')).toContain('/repo/c');
  });

  test('auto-approves reads inside additional directories only', () => {
    const s = session({ additionalDirectories: ['/repo/b'] });
    expect(isWorkspaceRead(s, 'Read', { file_path: '/repo/b/src/x.ts' })).toBe(true);
    expect(isWorkspaceRead(s, 'Grep', { path: '/repo/b' })).toBe(true);
    expect(isWorkspaceRead(s, 'Read', { file_path: '/repo/bb/x.ts' })).toBe(false);
    expect(isWorkspaceRead(s, 'Read', { file_path: '/repo/b/../c/x.ts' })).toBe(false);
    expect(isWorkspaceRead(s, 'Edit', { file_path: '/repo/b/x.ts' })).toBe(false);
  });

  test('resolves relative paths against the cwd and rejects non-directories', async () => {
    const base = mkdtempSync(join(tmpdir(), 'ws-'));
    writeFileSync(join(base, 'file.txt'), '');
    expect(await resolveDirectory('.', base)).toEqual({ ok: true, path: base });
    expect((await resolveDirectory('file.txt', base)).ok).toBe(false);
    expect((await resolveDirectory('missing', base)).ok).toBe(false);
    expect((await resolveDirectory('  ', base)).ok).toBe(false);
  });
});
