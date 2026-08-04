import { describe, test, expect } from 'bun:test';
import type { SessionInfo } from './claude-client';
import type { TabGroupInfo } from './tab-groups';
import {
  ancestorChain, buildGroupTree, derivedGroupId, descendantGroupIds, findGroupNode,
  flattenSessionIds, isAncestorOf, isDerivedGroupId, resolveGroupColor, worktreeOf,
  type TreeNode,
} from './group-tree';

function session(id: string, cwd: string): SessionInfo {
  return {
    id, name: id, cwd,
    created_at: 0, updated_at: 0,
    status: 'open', runtime_status: 'running', ready: true,
    claude_session_id: null, ws_url: '', saved_commands: [],
    model: null, permission_mode: 'default',
  };
}

function group(id: string, extra: Partial<TabGroupInfo> = {}): TabGroupInfo {
  return { id, name: id, ...extra };
}

/** Compact shape for assertions: `group(children…)` / `sessionId`. */
function shape(nodes: TreeNode[]): unknown[] {
  return nodes.map(n => n.type === 'session' ? n.id : { [n.id]: shape(n.children) });
}

const REPO = '/src/code';
const WT_A = '/src/code/.wt/feat-a';
const WT_B = '/src/code/.wt/feat-b';

describe('worktreeOf', () => {
  test('splits the standard <repo>/.wt/<branch> layout', () => {
    expect(worktreeOf(WT_A)).toEqual({ repo: '/src/code', branch: 'feat-a' });
  });

  test('handles Windows separators', () => {
    expect(worktreeOf('C:\\src\\code\\.wt\\feat-a')).toEqual({ repo: 'C:\\src\\code', branch: 'feat-a' });
  });

  test('rejects a plain repo and a subdirectory of a worktree', () => {
    expect(worktreeOf(REPO)).toBeNull();
    // Only the worktree root counts — `packages/ui` inside it is a normal dir.
    expect(worktreeOf(`${WT_A}/packages/ui`)).toBeNull();
    expect(worktreeOf('')).toBeNull();
    expect(worktreeOf(undefined)).toBeNull();
  });
});

describe('buildGroupTree — nesting', () => {
  const groups = {
    root: group('root', { parentId: null, color: 'blue' }),
    mid: group('mid', { parentId: 'root' }),
    leaf: group('leaf', { parentId: 'mid' }),
  };

  test('nests to arbitrary depth and reports subtree session counts', () => {
    const tree = buildGroupTree({
      sessions: [session('s1', REPO), session('s2', REPO), session('s3', REPO)],
      groups,
      map: { s1: 'root', s2: 'mid', s3: 'leaf' },
    });
    expect(shape(tree)).toEqual([{ root: [{ mid: [{ leaf: ['s3'] }, 's2'] }, 's1'] }]);
    const root = findGroupNode(tree, 'root')!;
    expect(root.sessionCount).toBe(3);
    expect(findGroupNode(tree, 'mid')!.sessionCount).toBe(2);
    expect(findGroupNode(tree, 'leaf')!.sessionCount).toBe(1);
    expect(root.depth).toBe(0);
    expect(findGroupNode(tree, 'leaf')!.depth).toBe(2);
  });

  test('a group whose parent is missing renders at the root', () => {
    const tree = buildGroupTree({
      sessions: [session('s1', REPO)],
      groups: { orphan: group('orphan', { parentId: 'gone' }) },
      map: { s1: 'orphan' },
    });
    expect(shape(tree)).toEqual([{ orphan: ['s1'] }]);
  });

  test('a parentId cycle is flattened instead of recursing forever', () => {
    const cyclic = {
      a: group('a', { parentId: 'b' }),
      b: group('b', { parentId: 'a' }),
    };
    // Both land at the root; `b` is then hidden for holding nothing.
    const tree = buildGroupTree({ sessions: [session('s1', REPO)], groups: cyclic, map: { s1: 'a' } });
    expect(shape(tree)).toEqual([{ a: ['s1'] }]);
  });

  test('sessions whose group no longer exists fall back to the root', () => {
    const tree = buildGroupTree({
      sessions: [session('s1', REPO)],
      groups: {},
      map: { s1: 'deleted' },
    });
    expect(shape(tree)).toEqual(['s1']);
  });

  test('childOrder drives sibling order per parent, unknowns go last', () => {
    const sibs = {
      p: group('p'),
      x: group('x', { parentId: 'p', allowEmpty: true }),
      y: group('y', { parentId: 'p', allowEmpty: true }),
      z: group('z', { parentId: 'p', allowEmpty: true }),
    };
    const tree = buildGroupTree({
      sessions: [],
      groups: sibs,
      map: {},
      childOrder: { p: ['z', 'x'] },
    });
    expect(shape(tree)).toEqual([{ p: [{ z: [] }, { x: [] }, { y: [] }] }]);
  });
});

describe('buildGroupTree — empty groups', () => {
  test('a group with no open sessions is hidden', () => {
    // tabGroups outlives its sessions: archived members keep their mapping, so
    // the group survives in prefs with nothing left to render.
    const tree = buildGroupTree({
      sessions: [session('s1', REPO)],
      groups: { live: group('live'), stale: group('stale') },
      map: { s1: 'live', archived: 'stale' },
    });
    expect(shape(tree)).toEqual([{ live: ['s1'] }]);
  });

  test('a deliberately empty folder is kept', () => {
    const tree = buildGroupTree({
      sessions: [],
      groups: { folder: group('folder', { allowEmpty: true }) },
      map: {},
    });
    expect(shape(tree)).toEqual([{ folder: [] }]);
  });

  test('a parent whose sessions all live in subgroups survives', () => {
    const tree = buildGroupTree({
      sessions: [session('s1', REPO)],
      groups: { root: group('root'), sub: group('sub', { parentId: 'root' }) },
      map: { s1: 'sub' },
    });
    expect(shape(tree)).toEqual([{ root: [{ sub: ['s1'] }] }]);
  });

  test('a search that matches nothing in a group hides it', () => {
    // The caller pre-filters `sessions`; an emptied group must not linger.
    const tree = buildGroupTree({
      sessions: [session('hit', REPO)],
      groups: { a: group('a'), b: group('b') },
      map: { hit: 'a', miss: 'b' },
    });
    expect(shape(tree)).toEqual([{ a: ['hit'] }]);
  });
});

describe('buildGroupTree — automatic worktree groups', () => {
  const groups = { proj: group('proj', { color: 'blue' }) };

  test('two sessions sharing a worktree materialise a derived group', () => {
    const tree = buildGroupTree({
      sessions: [session('a', WT_A), session('b', WT_A), session('c', REPO)],
      groups,
      map: { a: 'proj', b: 'proj', c: 'proj' },
    });
    const wt = derivedGroupId('proj', WT_A);
    expect(shape(tree)).toEqual([{ proj: [{ [wt]: ['a', 'b'] }, 'c'] }]);
    const node = findGroupNode(tree, wt)!;
    expect(node.derived).toBe(true);
    expect(node.group.kind).toBe('worktree');
    expect(node.group.name).toBe('feat-a');
    expect(node.group.worktreePath).toBe(WT_A);
    expect(isDerivedGroupId(node.id)).toBe(true);
  });

  test('a lone worktree session stays loose', () => {
    const tree = buildGroupTree({
      sessions: [session('a', WT_A), session('c', REPO)],
      groups,
      map: { a: 'proj', c: 'proj' },
    });
    expect(shape(tree)).toEqual([{ proj: ['a', 'c'] }]);
  });

  test('different worktrees form separate groups', () => {
    const tree = buildGroupTree({
      sessions: [session('a', WT_A), session('b', WT_A), session('c', WT_B), session('d', WT_B)],
      groups,
      map: { a: 'proj', b: 'proj', c: 'proj', d: 'proj' },
    });
    expect(shape(tree)).toEqual([{
      proj: [
        { [derivedGroupId('proj', WT_A)]: ['a', 'b'] },
        { [derivedGroupId('proj', WT_B)]: ['c', 'd'] },
      ],
    }]);
  });

  test('the same worktree under two parents does not merge', () => {
    const two = { p1: group('p1'), p2: group('p2') };
    const tree = buildGroupTree({
      sessions: [session('a', WT_A), session('b', WT_A), session('c', WT_A), session('d', WT_A)],
      groups: two,
      map: { a: 'p1', b: 'p1', c: 'p2', d: 'p2' },
    });
    expect(shape(tree)).toEqual([
      { p1: [{ [derivedGroupId('p1', WT_A)]: ['a', 'b'] }] },
      { p2: [{ [derivedGroupId('p2', WT_A)]: ['c', 'd'] }] },
    ]);
  });

  test('ungrouped worktree sessions cluster at the root', () => {
    const tree = buildGroupTree({
      sessions: [session('a', WT_A), session('b', WT_A)],
      groups: {},
      map: {},
    });
    expect(shape(tree)).toEqual([{ [derivedGroupId('', WT_A)]: ['a', 'b'] }]);
  });

  test('pinning a session out drops it below the threshold and dissolves the group', () => {
    const tree = buildGroupTree({
      sessions: [session('a', WT_A), session('b', WT_A)],
      groups,
      map: { a: 'proj', b: 'proj' },
      pinnedOutOfWorktree: new Set(['a']),
    });
    expect(shape(tree)).toEqual([{ proj: ['a', 'b'] }]);
  });

  test('pinning one of three leaves the group standing without it', () => {
    const tree = buildGroupTree({
      sessions: [session('a', WT_A), session('b', WT_A), session('c', WT_A)],
      groups,
      map: { a: 'proj', b: 'proj', c: 'proj' },
      pinnedOutOfWorktree: new Set(['a']),
    });
    expect(shape(tree)).toEqual([{ proj: [{ [derivedGroupId('proj', WT_A)]: ['b', 'c'] }, 'a'] }]);
  });

  test('derived groups can appear at any nesting depth', () => {
    const nested = { root: group('root'), sub: group('sub', { parentId: 'root' }) };
    const tree = buildGroupTree({
      sessions: [session('a', WT_A), session('b', WT_A)],
      groups: nested,
      map: { a: 'sub', b: 'sub' },
    });
    expect(shape(tree)).toEqual([{ root: [{ sub: [{ [derivedGroupId('sub', WT_A)]: ['a', 'b'] }] }] }]);
    expect(findGroupNode(tree, derivedGroupId('sub', WT_A))!.depth).toBe(2);
  });

  test('the repo root is a checkout too — it clusters as "main"', () => {
    // git's own terms: the repo root is the main working tree, `.wt/*` are the
    // linked ones. Both cluster; the root reads as `main`.
    const proj = { proj: group('proj', { cwd: REPO }) };
    const tree = buildGroupTree({
      sessions: [session('a', REPO), session('b', REPO), session('c', WT_A), session('d', WT_A)],
      groups: proj,
      map: { a: 'proj', b: 'proj', c: 'proj', d: 'proj' },
    });
    expect(shape(tree)).toEqual([{
      proj: [
        { [derivedGroupId('proj', REPO)]: ['a', 'b'] },
        { [derivedGroupId('proj', WT_A)]: ['c', 'd'] },
      ],
    }]);
    expect(findGroupNode(tree, derivedGroupId('proj', REPO))!.group.name).toBe('main');
    expect(findGroupNode(tree, derivedGroupId('proj', WT_A))!.group.name).toBe('feat-a');
  });

  test('a group living entirely in its own directory gains no child node', () => {
    // Otherwise every single-checkout project would grow a lone `main` child
    // repeating the parent — noise, not structure.
    const proj = { proj: group('proj', { cwd: REPO }) };
    const tree = buildGroupTree({
      sessions: [session('a', REPO), session('b', REPO)],
      groups: proj,
      map: { a: 'proj', b: 'proj' },
    });
    expect(shape(tree)).toEqual([{ proj: ['a', 'b'] }]);
  });

  test('a lone linked worktree still gets its node — the branch is information', () => {
    const proj = { proj: group('proj', { cwd: REPO }) };
    const tree = buildGroupTree({
      sessions: [session('a', WT_A), session('b', WT_A)],
      groups: proj,
      map: { a: 'proj', b: 'proj' },
    });
    expect(shape(tree)).toEqual([{ proj: [{ [derivedGroupId('proj', WT_A)]: ['a', 'b'] }] }]);
  });

  test('a shared directory that is neither the project nor a worktree uses its folder name', () => {
    const proj = { proj: group('proj', { cwd: REPO }) };
    const tree = buildGroupTree({
      sessions: [session('a', '/src/other'), session('b', '/src/other'), session('c', REPO)],
      groups: proj,
      map: { a: 'proj', b: 'proj', c: 'proj' },
    });
    expect(findGroupNode(tree, derivedGroupId('proj', '/src/other'))!.group.name).toBe('other');
  });

  test('groupByWorktree: false skips the derivation entirely', () => {
    const proj = { proj: group('proj', { cwd: REPO }) };
    const tree = buildGroupTree({
      sessions: [session('a', WT_A), session('b', WT_A), session('c', REPO)],
      groups: proj,
      map: { a: 'proj', b: 'proj', c: 'proj' },
      groupByWorktree: false,
    });
    expect(shape(tree)).toEqual([{ proj: ['a', 'b', 'c'] }]);
  });

  test('groupByWorktree defaults to on when omitted', () => {
    const proj = { proj: group('proj', { cwd: REPO }) };
    const tree = buildGroupTree({
      sessions: [session('a', WT_A), session('b', WT_A), session('c', REPO)],
      groups: proj,
      map: { a: 'proj', b: 'proj', c: 'proj' },
    });
    expect(shape(tree)).toEqual([{ proj: [{ [derivedGroupId('proj', WT_A)]: ['a', 'b'] }, 'c'] }]);
  });

  test('sortSessions applies inside derived groups too', () => {
    const tree = buildGroupTree({
      sessions: [session('b', WT_A), session('a', WT_A)],
      groups,
      map: { a: 'proj', b: 'proj' },
      sortSessions: (x, y) => x.id.localeCompare(y.id),
    });
    expect(shape(tree)).toEqual([{ proj: [{ [derivedGroupId('proj', WT_A)]: ['a', 'b'] }] }]);
  });
});

describe('tree helpers', () => {
  const groups = {
    root: group('root', { color: 'blue' }),
    mid: group('mid', { parentId: 'root' }),
    leaf: group('leaf', { parentId: 'mid', color: 'red' }),
    other: group('other', { color: 'green' }),
  };

  test('descendantGroupIds collects the whole subtree', () => {
    expect(descendantGroupIds(groups, 'root').sort()).toEqual(['leaf', 'mid']);
    expect(descendantGroupIds(groups, 'leaf')).toEqual([]);
  });

  test('isAncestorOf covers self, ancestors and unrelated branches', () => {
    expect(isAncestorOf(groups, 'root', 'leaf')).toBe(true);
    expect(isAncestorOf(groups, 'root', 'root')).toBe(true);
    expect(isAncestorOf(groups, 'leaf', 'root')).toBe(false);
    expect(isAncestorOf(groups, 'other', 'leaf')).toBe(false);
  });

  test('ancestorChain runs nearest-first', () => {
    expect(ancestorChain(groups, 'leaf')).toEqual(['leaf', 'mid', 'root']);
    expect(ancestorChain(groups, null)).toEqual([]);
  });

  test('resolveGroupColor inherits from the nearest ancestor that sets one', () => {
    expect(resolveGroupColor(groups, 'mid')).toBe('blue');
    expect(resolveGroupColor(groups, 'leaf')).toBe('red');
    expect(resolveGroupColor(groups, 'missing', 'amber')).toBe('amber');
  });

  test('flattenSessionIds reads the tree in visual order', () => {
    const tree = buildGroupTree({
      sessions: [session('s1', REPO), session('s2', REPO), session('loose', REPO)],
      groups: { root: group('root'), mid: group('mid', { parentId: 'root' }) },
      map: { s1: 'root', s2: 'mid' },
    });
    expect(flattenSessionIds(tree)).toEqual(['s2', 's1', 'loose']);
  });
});
