import { describe, test, expect } from 'bun:test';
import type { SessionInfo } from './claude-client';
import type { TabGroupInfo } from './tab-groups';
import {
  ancestorChain, buildGroupTree, descendantGroupIds, findGroupNode,
  flattenSessionIds, groupIdForCwd, isAncestorOf, projectGroupIdForRepo,
  pinOrder, repoRootOfWorktreeCwd, resolveGroupColor,
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
const WT_A = '/src/code/.worktrees/feat-a';

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

  test('sortSessions orders each parent independently', () => {
    const tree = buildGroupTree({
      sessions: [session('b', REPO), session('a', REPO), session('d', REPO), session('c', REPO)],
      groups: { p: group('p') },
      map: { a: 'p', b: 'p' },
      sortSessions: (x, y) => x.id.localeCompare(y.id),
    });
    expect(shape(tree)).toEqual([{ p: ['a', 'b'] }, 'c', 'd']);
  });
});

describe('buildGroupTree — sessions sharing a worktree', () => {
  // Nothing clusters at render time any more: a branch group is a real group
  // the bridge created when the session was born (`maybeAutoGroupSession`), so
  // the tree just draws whatever `tabGroupMap` says.
  const groups = {
    proj: group('proj', { cwd: REPO, color: 'blue' }),
    branch: group('branch', { name: 'feat-a', cwd: WT_A, parentId: 'proj', autoClaim: true }),
  };

  test('a branch group renders like any other subgroup', () => {
    const tree = buildGroupTree({
      sessions: [session('a', WT_A), session('b', WT_A), session('c', REPO)],
      groups,
      map: { a: 'branch', b: 'branch', c: 'proj' },
    });
    expect(shape(tree)).toEqual([{ proj: [{ branch: ['a', 'b'] }, 'c'] }]);
  });

  test('a session dragged out of its branch group stays out', () => {
    // The whole point of persisting the grouping: sharing the cwd no longer
    // pulls `a` back in on the next render.
    const tree = buildGroupTree({
      sessions: [session('a', WT_A), session('b', WT_A)],
      groups,
      map: { a: 'proj', b: 'branch' },
    });
    expect(shape(tree)).toEqual([{ proj: [{ branch: ['b'] }, 'a'] }]);
  });

  test('an emptied branch group disappears without being deleted', () => {
    const tree = buildGroupTree({
      sessions: [session('a', WT_A)],
      groups,
      map: { a: 'proj' },
    });
    expect(shape(tree)).toEqual([{ proj: ['a'] }]);
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

describe('worktree groups nest under their repo', () => {
  test('repoRootOfWorktreeCwd finds the repo from anywhere in the worktree', () => {
    expect(repoRootOfWorktreeCwd(WT_A)).toBe(REPO);
    expect(repoRootOfWorktreeCwd(`${WT_A}/packages/ui`)).toBe(REPO);
    // `.wt` is the legacy directory; worktrees created by older versions still
    // have to resolve.
    expect(repoRootOfWorktreeCwd('/src/code/.wt/feat-a')).toBe(REPO);
    expect(repoRootOfWorktreeCwd('C:\\src\\code\\.worktrees\\feat-a')).toBe('C:\\src\\code');
  });

  test('repoRootOfWorktreeCwd returns null off a worktree', () => {
    expect(repoRootOfWorktreeCwd(REPO)).toBeNull();
    // Nothing precedes the segment, so there is no repo to nest under.
    expect(repoRootOfWorktreeCwd('/.worktrees/feat-a')).toBeNull();
    // A directory that merely mentions worktrees is not one.
    expect(repoRootOfWorktreeCwd('/src/code/worktrees/feat-a')).toBeNull();
  });

  test('projectGroupIdForRepo matches the repo group on cwd', () => {
    const groups = {
      code: group('code', { cwd: REPO }),
      other: group('other', { cwd: '/src/taskr' }),
    };
    expect(projectGroupIdForRepo(REPO, groups)).toBe('code');
    expect(projectGroupIdForRepo('/src/unknown', groups)).toBeNull();
  });

  test('projectGroupIdForRepo falls back to the folder name', () => {
    // Groups created before `cwd` was persisted only carry the folder name.
    const groups = { g1: group('g1', { name: 'code' }) };
    expect(projectGroupIdForRepo(REPO, groups)).toBe('g1');
  });

  test('projectGroupIdForRepo ignores subgroups with the repo name', () => {
    // Two repos can each hold a "code" subgroup; neither is the project.
    const groups = {
      root: group('root', { name: 'taskr', cwd: '/src/taskr' }),
      nested: group('nested', { name: 'code', cwd: REPO, parentId: 'root' }),
    };
    expect(projectGroupIdForRepo(REPO, groups)).toBeNull();
  });

  test('cwd wins over a namesake group', () => {
    const groups = {
      renamed: group('renamed', { name: 'monorepo', cwd: REPO }),
      namesake: group('namesake', { name: 'code', cwd: '/elsewhere/code' }),
    };
    expect(projectGroupIdForRepo(REPO, groups)).toBe('renamed');
  });
});

describe('groupIdForCwd — joining instead of duplicating', () => {
  test('finds the folder already standing for the directory', () => {
    const groups = {
      home: group('home', { name: 'jovaz', cwd: '/Users/jovaz' }),
      code: group('code', { cwd: REPO }),
    };
    expect(groupIdForCwd('/Users/jovaz', groups)).toBe('home');
    expect(groupIdForCwd('/Users/jovaz/elsewhere', groups)).toBeNull();
  });

  test('searches subgroups too', () => {
    // A second session on the same branch must join the branch folder, not
    // mint a twin of it beside the project.
    const groups = {
      proj: group('proj', { cwd: REPO }),
      branch: group('branch', { name: 'feat-a', cwd: WT_A, parentId: 'proj' }),
    };
    expect(groupIdForCwd(WT_A, groups)).toBe('branch');
  });

  test('never matches a namesake that carries a different cwd', () => {
    // `~/vendor/code` is not `~/src/code`; an extra folder beats filing a
    // session into the wrong project.
    const groups = { other: group('other', { name: 'code', cwd: '/vendor/code' }) };
    expect(groupIdForCwd(REPO, groups)).toBeNull();
  });

  test('falls back to the name only for cwd-less root groups', () => {
    const legacy = { g1: group('g1', { name: 'code' }) };
    expect(groupIdForCwd(REPO, legacy)).toBe('g1');
    // A cwd-less *subgroup* is somebody's folder, not the project.
    const nested = { root: group('root'), sub: group('sub', { name: 'code', parentId: 'root' }) };
    expect(groupIdForCwd(REPO, nested)).toBeNull();
  });

  test('an empty cwd matches nothing', () => {
    expect(groupIdForCwd('', { g: group('g', { name: '' }) })).toBeNull();
  });
});

describe('pinOrder', () => {
  test('ranks by when each session was pinned, not by activity', () => {
    // The set is insertion-ordered, so this is the pin order: `a` first.
    const rank = pinOrder(new Set(['a', 'b', 'c']));
    const sorted = ['a', 'b', 'c'].sort((x, y) => (rank.get(y) ?? -1) - (rank.get(x) ?? -1));
    // Newest pin on top; the one pinned first sinks to the bottom of the pins.
    expect(sorted).toEqual(['c', 'b', 'a']);
  });

  test('unpinned ids rank below every pin', () => {
    const rank = pinOrder(new Set(['a']));
    expect(rank.get('loose') ?? -1).toBe(-1);
    expect(rank.get('a')).toBe(0);
  });

  test('no pins at all is an empty ranking, not a crash', () => {
    expect(pinOrder(undefined).size).toBe(0);
    expect(pinOrder(new Set()).size).toBe(0);
  });
});
