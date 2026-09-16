import { describe, test, expect } from 'bun:test';
import { dedupeGroups } from './group-dedupe';

describe('dedupeGroups', () => {
  test('leaves distinct names alone', () => {
    const groups = { a: { id: 'a', name: 'taskr' }, b: { id: 'b', name: 'code' } };
    const out = dedupeGroups({ groups, map: { s1: 'a' } });
    expect(out.groups).toEqual(groups);
    expect(out.merged).toEqual({});
  });

  test('folds same-name siblings into the busiest one', () => {
    const out = dedupeGroups({
      groups: {
        a: { id: 'a', name: 'taskr', color: 'blue' },
        b: { id: 'b', name: ' Taskr ', color: 'green', cwd: '/src/taskr' },
      },
      map: { s1: 'a', s2: 'b', s3: 'b' },
    });
    expect(Object.keys(out.groups)).toEqual(['b']);
    // The survivor keeps its colour; nothing of the loser's overrides it.
    expect(out.groups.b).toMatchObject({ id: 'b', color: 'green', cwd: '/src/taskr' });
    expect(out.map).toEqual({ s1: 'b', s2: 'b', s3: 'b' });
    expect(out.merged).toEqual({ a: 'b' });
  });

  test('fills fields the survivor lacks from the loser', () => {
    const out = dedupeGroups({
      groups: { a: { id: 'a', name: 'x', cwd: '/x', allowEmpty: true }, b: { id: 'b', name: 'x' } },
      map: { s1: 'b' },
    });
    expect(out.groups.b).toMatchObject({ cwd: '/x', allowEmpty: true });
  });

  test('breaks ties by id so every server agrees', () => {
    const out = dedupeGroups({
      groups: { z: { id: 'z', name: 'vtb' }, m: { id: 'm', name: 'vtb' } },
      map: {},
    });
    expect(Object.keys(out.groups)).toEqual(['m']);
  });

  test('same name under different parents is not a duplicate', () => {
    const groups = {
      p1: { id: 'p1', name: 'web' },
      p2: { id: 'p2', name: 'api' },
      c1: { id: 'c1', name: 'backend', parentId: 'p1' },
      c2: { id: 'c2', name: 'backend', parentId: 'p2' },
    };
    expect(Object.keys(dedupeGroups({ groups, map: {} }).groups).sort()).toEqual(['c1', 'c2', 'p1', 'p2']);
  });

  test('merging parents re-parents children and folds the children they now share', () => {
    const out = dedupeGroups({
      groups: {
        p1: { id: 'p1', name: 'utilityprofit' },
        p2: { id: 'p2', name: 'utilityprofit' },
        c1: { id: 'c1', name: 'Code Reviews', parentId: 'p1' },
        c2: { id: 'c2', name: 'code reviews', parentId: 'p2' },
        c3: { id: 'c3', name: 'FEAT-1', parentId: 'p2' },
      },
      map: { s1: 'p1', s2: 'p1', s3: 'c2', s4: 'c1', s5: 'c1' },
    });
    expect(Object.keys(out.groups).sort()).toEqual(['c1', 'c3', 'p1']);
    expect(out.groups.c3!.parentId).toBe('p1');
    expect(out.map.s3).toBe('c1');
    expect(out.merged).toEqual({ p2: 'p1', c2: 'c1' });
  });

  test('repoints group order and pins at the survivor', () => {
    const out = dedupeGroups({
      groups: { a: { id: 'a', name: 'x' }, b: { id: 'b', name: 'x' }, c: { id: 'c', name: 'y' } },
      map: { s1: 'a' },
      groupOrder: { '': ['b', 'c', 'a'], b: ['k'] },
      pinnedGroupIds: ['b', 'a'],
    });
    expect(out.groupOrder).toEqual({ '': ['a', 'c'], a: ['k'] });
    expect(out.pinnedGroupIds).toEqual(['a']);
  });
});
