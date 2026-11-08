import { describe, test, expect } from 'bun:test';
import type { TabGroupInfo } from './tab-groups';
import { applyBundle, bundleOf, fingerprint, parseStoredProjects, projectGroupIds, type OrgPrefs } from './project-sync';

const g = (id: string, extra: Partial<TabGroupInfo> = {}): TabGroupInfo => ({ id, name: id, ...extra });

const mac: OrgPrefs = {
  tabGroups: {
    p1: g('p1', { projectId: 'P' }),
    sub: g('sub', { parentId: 'p1' }),
    other: g('other'),
  },
  tabGroupMap: { a: 'p1', b: 'sub', c: 'other' },
  groupOrder: { p1: ['sub'], '': ['p1', 'other'] },
  pinnedSessionIds: ['b', 'c'],
};

describe('bundleOf', () => {
  test('groups tagged with the project and everything below them', () => {
    expect([...projectGroupIds(mac.tabGroups, 'P')].sort()).toEqual(['p1', 'sub']);
  });
  test('only the project\'s slice: groups, assignments, child order, pins', () => {
    const b = bundleOf(mac, 'P');
    expect(Object.keys(b.groups).sort()).toEqual(['p1', 'sub']);
    expect(b.map).toEqual({ a: 'p1', b: 'sub' });
    expect(b.order).toEqual({ p1: ['sub'] });
    expect(b.pins).toEqual(['b']);
  });
});

describe('fingerprint', () => {
  test('ignores key order and pin order', () => {
    const b = bundleOf(mac, 'P');
    const shuffled = { ...b, map: { b: 'sub', a: 'p1' }, pins: [...b.pins].reverse() };
    expect(fingerprint(shuffled)).toBe(fingerprint(b));
  });
  test('changes when a session moves', () => {
    const b = bundleOf(mac, 'P');
    expect(fingerprint({ ...b, map: { ...b.map, a: 'sub' } })).not.toBe(fingerprint(b));
  });
});

describe('applyBundle', () => {
  const ryzen: OrgPrefs = {
    tabGroups: { old: g('old', { projectId: 'P' }), mine: g('mine') },
    tabGroupMap: { a: 'old', x: 'mine' },
    groupOrder: { old: [] },
    pinnedSessionIds: ['a', 'x'],
  };

  test('replaces the project\'s organization and leaves the rest alone', () => {
    const out = applyBundle(ryzen, 'P', bundleOf(mac, 'P'));
    expect(Object.keys(out.tabGroups).sort()).toEqual(['mine', 'p1', 'sub']);
    expect(out.tabGroupMap).toEqual({ x: 'mine', a: 'p1', b: 'sub' });
    expect(out.groupOrder).toEqual({ p1: ['sub'] });
    // `a` lost its pin with the bundle, `b` gained one, `x` is untouched.
    expect(out.pinnedSessionIds.sort()).toEqual(['b', 'x']);
  });

  test('applying converges: both hosts compute the same fingerprint afterwards', () => {
    const out = applyBundle(ryzen, 'P', bundleOf(mac, 'P'));
    expect(fingerprint(bundleOf(out, 'P'))).toBe(fingerprint(bundleOf(mac, 'P')));
  });
});

describe('parseStoredProjects', () => {
  test('keeps tombstones and normalises folders', () => {
    const out = parseStoredProjects({
      a: { name: 'A', folders: [{ path: '/x/', hostId: 'host_1' }], updatedAt: 5, fp: 'f' },
      b: { deleted: true, updatedAt: 9 },
      c: { name: '' },
    });
    expect(out.a).toEqual({ id: 'a', name: 'A', color: undefined, folders: [{ path: '/x', hostId: 'host_1' }], updatedAt: 5, fp: 'f' });
    expect(out.b?.deleted).toBe(true);
    expect(out.c).toBeUndefined();
  });
});
