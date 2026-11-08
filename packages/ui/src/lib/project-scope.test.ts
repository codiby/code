import { describe, test, expect } from 'bun:test';
import type { SessionInfo } from './claude-client';
import type { TabGroupInfo } from './tab-groups';
import {
  listProjects, parseProjects, projectOfSession, scopeToProject, sessionInProject,
  type Project,
} from './project-scope';

function session(id: string, cwd: string, remoteId: string | null = null): SessionInfo {
  return {
    id, name: id, cwd, remoteId,
    created_at: 0, updated_at: 0,
    status: 'open', runtime_status: 'running', ready: true,
    claude_session_id: null, ws_url: '', saved_commands: [],
    model: null, permission_mode: 'default',
  };
}
function group(id: string, extra: Partial<TabGroupInfo> = {}): TabGroupInfo {
  return { id, name: id, ...extra };
}

const vtb: Project = {
  id: 'vtb', name: 'vtb',
  folders: [{ path: '/home/jovaz/vtb', remoteId: 'ryzen9' }, { path: '/Users/jovaz/src/vtb', remoteId: null }],
};
const code: Project = { id: 'code', name: 'code', folders: [{ path: '/Users/jovaz/src/codiby/code', remoteId: null }] };

describe('sessionInProject', () => {
  test('matches a folder, anything below it, on the folder\'s own host', () => {
    expect(sessionInProject(session('a', '/home/jovaz/vtb', 'ryzen9'), vtb)).toBe(true);
    expect(sessionInProject(session('a', '/home/jovaz/vtb/.worktrees/feat', 'ryzen9'), vtb)).toBe(true);
    expect(sessionInProject(session('a', '/Users/jovaz/src/vtb/', null), vtb)).toBe(true);
  });
  test('the same path on another host, or a sibling prefix, does not', () => {
    expect(sessionInProject(session('a', '/home/jovaz/vtb', null), vtb)).toBe(false);
    expect(sessionInProject(session('a', '/home/jovaz/vtb-old', 'ryzen9'), vtb)).toBe(false);
  });
});

describe('projectOfSession', () => {
  test('the most specific folder wins', () => {
    const outer: Project = { id: 'src', name: 'src', folders: [{ path: '/Users/jovaz/src', remoteId: null }] };
    const projects = { src: outer, code };
    expect(projectOfSession(session('a', '/Users/jovaz/src/codiby/code/packages'), projects)).toBe('code');
    expect(projectOfSession(session('a', '/Users/jovaz/src/other'), projects)).toBe('src');
    expect(projectOfSession(session('a', '/tmp'), projects)).toBeNull();
  });
});

describe('scopeToProject', () => {
  const groups = {
    work: group('work'),
    feat: group('feat', { parentId: 'work' }),
    misc: group('misc'),
    fresh: group('fresh', { projectId: 'code', allowEmpty: true }),
    other: group('other', { projectId: 'vtb', allowEmpty: true }),
  };
  const map = { a: 'feat', b: 'misc', c: 'feat' };
  const sessions = [
    session('a', '/Users/jovaz/src/codiby/code'),
    session('b', '/home/jovaz/vtb', 'ryzen9'),
    session('c', '/home/jovaz/vtb', 'ryzen9'),
    session('loose', '/Users/jovaz/src/codiby/code/.worktrees/x'),
  ];

  test('null scope is the identity', () => {
    const input = { groups, map, sessions };
    expect(scopeToProject(input, null)).toBe(input);
  });

  test('keeps the project\'s sessions, their group chain and its own empty groups — nothing moves', () => {
    const out = scopeToProject({ groups, map, sessions }, code);
    expect(out.sessions.map(s => s.id)).toEqual(['a', 'loose']);
    expect(Object.keys(out.groups).sort()).toEqual(['feat', 'fresh', 'work']);
    expect(out.groups.feat!.parentId).toBe('work');
    expect(out.map).toEqual({ a: 'feat' });
  });

  test('a shared group shows in both projects, each with its own sessions', () => {
    const out = scopeToProject({ groups, map, sessions }, vtb);
    expect(out.sessions.map(s => s.id)).toEqual(['b', 'c']);
    expect(Object.keys(out.groups).sort()).toEqual(['feat', 'misc', 'other', 'work']);
    expect(out.map).toEqual({ b: 'misc', c: 'feat' });
  });
});

describe('listProjects / parseProjects', () => {
  test('counts by folder membership, sorted by name', () => {
    const out = listProjects({
      projects: { vtb, code },
      sessions: [session('a', '/Users/jovaz/src/codiby/code'), session('b', '/home/jovaz/vtb', 'ryzen9')],
      isLive: id => id === 'a',
    });
    expect(out.map(p => [p.id, p.sessionCount, p.liveCount])).toEqual([['code', 1, 1], ['vtb', 1, 0]]);
  });

  test('drops malformed entries and trailing slashes', () => {
    const out = parseProjects({
      ok: { name: ' up ', folders: [{ path: '/src/up/', remoteId: '' }, { path: '' }, null] },
      noName: { name: '', folders: [] },
      junk: 3,
    });
    expect(out).toEqual({ ok: { id: 'ok', name: 'up', color: undefined, folders: [{ path: '/src/up', remoteId: null }] } });
  });
});
