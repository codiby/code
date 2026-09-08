import { describe, test, expect } from 'bun:test';
import type { TabGroupInfo } from './tab-groups';
import {
  isRemoteGroupKey, mergeRemoteGroups, remoteGroupKey, remoteOfGroupKey,
  stripRemoteGroups,
} from './remote-groups';

function group(id: string, extra: Partial<TabGroupInfo> = {}): TabGroupInfo {
  return { id, name: id, ...extra };
}

const RYZEN = 'rmt_ryzen9';
const OTHER = 'rmt_other';

describe('mergeRemoteGroups — folding by name', () => {
  const local = {
    groups: {
      up: group('up', { name: 'utilityprofit', cwd: '/Users/jovaz/src/up/utilityprofit', color: 'green' }),
    },
    map: { 'local-1': 'up' },
  };

  test('a remote project with a local namesake folds into the local folder', () => {
    const merged = mergeRemoteGroups({
      ...local,
      remotes: {
        [RYZEN]: {
          tabGroups: { r1: group('r1', { name: 'utilityprofit', cwd: '/home/jovaz/up/utilityprofit', color: 'amber' }) },
          tabGroupMap: { 'remote-1': 'r1' },
        },
      },
    });

    expect(Object.keys(merged.groups)).toEqual(['up']);
    expect(merged.map).toEqual({ 'local-1': 'up', 'remote-1': 'up' });
    // The local definition owns the folder: cwd and colour are not clobbered.
    expect(merged.groups.up!.cwd).toBe('/Users/jovaz/src/up/utilityprofit');
    expect(merged.groups.up!.color).toBe('green');
  });

  test('name matching ignores case and surrounding space', () => {
    const merged = mergeRemoteGroups({
      ...local,
      remotes: { [RYZEN]: { tabGroups: { r1: group('r1', { name: '  UtilityProfit ' }) }, tabGroupMap: { 'remote-1': 'r1' } } },
    });
    expect(merged.map['remote-1']).toBe('up');
  });

  test('a remote-only project renders under a synthetic id', () => {
    const merged = mergeRemoteGroups({
      ...local,
      remotes: { [RYZEN]: { tabGroups: { r9: group('r9', { name: 'ledger' }) }, tabGroupMap: { 'remote-1': 'r9' } } },
    });

    const key = remoteGroupKey(RYZEN, 'r9');
    expect(merged.groups[key]).toMatchObject({ id: key, name: 'ledger', parentId: null });
    expect(merged.map['remote-1']).toBe(key);
    expect(isRemoteGroupKey(key)).toBe(true);
    expect(remoteOfGroupKey(key)).toBe(RYZEN);
  });

  test('two remotes sharing a project name land in one folder', () => {
    const merged = mergeRemoteGroups({
      groups: {}, map: {},
      remotes: {
        [RYZEN]: { tabGroups: { a: group('a', { name: 'vtb' }) }, tabGroupMap: { s1: 'a' } },
        [OTHER]: { tabGroups: { b: group('b', { name: 'vtb' }) }, tabGroupMap: { s2: 'b' } },
      },
    });

    expect(Object.keys(merged.groups)).toHaveLength(1);
    expect(merged.map.s1).toBe(merged.map.s2);
  });

  test('duplicate local names fold into the busiest one, not the first', () => {
    const merged = mergeRemoteGroups({
      groups: {
        phantom: group('phantom', { name: 'vtb', cwd: '/home/jovaz/vtb' }),
        real: group('real', { name: 'vtb', cwd: '/Users/jovaz/src/vtb' }),
      },
      map: { a: 'real', b: 'real', c: 'phantom' },
      remotes: { [RYZEN]: { tabGroups: { r: group('r', { name: 'vtb' }) }, tabGroupMap: { s1: 'r' } } },
    });
    expect(merged.map.s1).toBe('real');
  });
});

describe('mergeRemoteGroups — nesting and ownership', () => {
  test('a remote branch subgroup keeps its nesting under the folded parent', () => {
    const merged = mergeRemoteGroups({
      groups: { up: group('up', { name: 'utilityprofit' }) },
      map: {},
      remotes: {
        [RYZEN]: {
          tabGroups: {
            r1: group('r1', { name: 'utilityprofit' }),
            r2: group('r2', { name: 'feat-a', parentId: 'r1' }),
          },
          tabGroupMap: { s1: 'r2' },
        },
      },
    });

    const sub = remoteGroupKey(RYZEN, 'r2');
    expect(merged.groups[sub]!.parentId).toBe('up');
    expect(merged.map.s1).toBe(sub);
  });

  test('a subgroup never folds by name into an unrelated local subgroup', () => {
    const merged = mergeRemoteGroups({
      groups: { p: group('p', { name: 'code' }), backend: group('backend', { name: 'backend', parentId: 'p' }) },
      map: {},
      remotes: {
        [RYZEN]: {
          tabGroups: { r1: group('r1', { name: 'ledger' }), r2: group('r2', { name: 'backend', parentId: 'r1' }) },
          tabGroupMap: { s1: 'r2' },
        },
      },
    });
    expect(merged.map.s1).toBe(remoteGroupKey(RYZEN, 'r2'));
  });

  test('a local placement wins over the remote\'s own grouping', () => {
    const merged = mergeRemoteGroups({
      groups: { up: group('up', { name: 'utilityprofit' }), inbox: group('inbox', { name: 'inbox' }) },
      map: { 'remote-1': 'inbox' },
      remotes: { [RYZEN]: { tabGroups: { r1: group('r1', { name: 'utilityprofit' }) }, tabGroupMap: { 'remote-1': 'r1' } } },
    });
    expect(merged.map['remote-1']).toBe('inbox');
  });

  test('an id the local bridge also owns is left alone', () => {
    // `main-session` exists on every machine: following the remote's mapping
    // would move this machine's Telegram tab into the remote's folder.
    const merged = mergeRemoteGroups({
      groups: { up: group('up', { name: 'utilityprofit' }) },
      map: {},
      remotes: { [RYZEN]: { tabGroups: { r1: group('r1', { name: 'utilityprofit' }) }, tabGroupMap: { 'main-session': 'r1' } } },
      localSessionIds: new Set(['main-session']),
    });
    expect(merged.map['main-session']).toBeUndefined();
  });

  test('no remotes is the identity', () => {
    const groups = { up: group('up') };
    const map = { s1: 'up' };
    const merged = mergeRemoteGroups({ groups, map, remotes: {} });
    expect(merged.groups).toBe(groups);
    expect(merged.map).toBe(map);
  });
});

describe('stripRemoteGroups', () => {
  test('removes synthetic groups and any mapping into them', () => {
    const key = remoteGroupKey(RYZEN, 'r1');
    const out = stripRemoteGroups({
      tabGroups: { up: group('up'), [key]: group(key) } as Record<string, TabGroupInfo>,
      tabGroupMap: { local: 'up', remote: key } as Record<string, string>,
    });
    expect(out.tabGroups).toEqual({ up: group('up') });
    expect(out.tabGroupMap).toEqual({ local: 'up' });
  });

  test('leaves a payload without groups untouched', () => {
    expect(stripRemoteGroups({ tabOrder: ['a'] } as Record<string, unknown>)).toEqual({ tabOrder: ['a'] });
  });
});
