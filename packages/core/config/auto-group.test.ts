import { describe, test, expect } from 'bun:test';
import {
  planAutoGroup, planAutoGroupExisting,
  type AutoGroup, type AutoGroupInput, type LooseSession,
} from './auto-group';

const REPO = '/src/code';
const WT_A = '/src/code/.worktrees/feat-a';
const WT_B = '/src/code/.worktrees/feat-b';

/** Deterministic ids so assertions can name the groups that get created. */
function ids() {
  let n = 0;
  return () => `new-${++n}`;
}

function plan(over: Partial<AutoGroupInput> = {}) {
  return planAutoGroup({
    sessionId: 'new',
    sessionCwd: REPO,
    projectCwd: REPO,
    groups: {},
    map: {},
    sessionCwds: {},
    autoGroupSessions: true,
    groupSessionsByWorktree: true,
    newId: ids(),
    ...over,
  });
}

const group = (id: string, extra: Partial<AutoGroup> = {}): AutoGroup => ({ id, name: id, ...extra });

describe('planAutoGroup — project grouping', () => {
  test('creates a top-level group named after the repo folder', () => {
    const out = plan()!;
    expect(out.map.new).toBe('new-1');
    expect(out.groups['new-1']).toMatchObject({ name: 'code', cwd: REPO, parentId: null });
    expect(out.groups['new-1']!.color).toBe('blue');
  });

  test('reuses an existing top-level group with the same name', () => {
    const out = plan({ groups: { p: group('p', { name: 'code', cwd: REPO }) } })!;
    expect(out.map.new).toBe('p');
    expect(Object.keys(out.groups)).toEqual(['p']);
  });

  test('ignores a subgroup that merely shares the project name', () => {
    // Two repos can each hold a "code" subgroup; joining one would be wrong.
    const out = plan({ groups: { sub: group('sub', { name: 'code', parentId: 'other' }) } })!;
    expect(out.map.new).toBe('new-1');
    expect(out.groups['new-1']!.parentId).toBeNull();
  });

  test('a worktree session still groups under the repo, not the branch', () => {
    // The caller resolved `projectCwd` through git; the branch only matters
    // once a second session shares the checkout.
    const out = plan({ sessionCwd: WT_A, projectCwd: REPO })!;
    expect(out.groups[out.map.new!]!.name).toBe('code');
  });

  test('off: a session with no other rule to catch it stays ungrouped', () => {
    expect(plan({ autoGroupSessions: false })).toBeNull();
  });

  test('an explicit group assignment from the caller wins', () => {
    expect(plan({ map: { new: 'chosen' } })).toBeNull();
  });

  test('an empty projectCwd is a no-op', () => {
    expect(plan({ projectCwd: '' })).toBeNull();
  });
});

describe('planAutoGroup — branch subgroups', () => {
  const proj = { p: group('p', { name: 'code', cwd: REPO }) };

  test('the second session on a checkout creates the group and pulls the first in', () => {
    const out = plan({
      sessionCwd: WT_A,
      projectCwd: REPO,
      groups: proj,
      map: { first: 'p' },
      sessionCwds: { first: WT_A },
    })!;
    expect(out.groups['new-1']).toMatchObject({
      name: 'feat-a', cwd: WT_A, parentId: 'p', autoClaim: true, icon: 'git-branch',
    });
    // No colour of its own — a subgroup reads as part of its project's family.
    expect(out.groups['new-1']!.color).toBeUndefined();
    expect(out.map).toEqual({ first: 'new-1', new: 'new-1' });
  });

  test('the first session on a checkout stays a direct child of the project', () => {
    const out = plan({ sessionCwd: WT_A, projectCwd: REPO, groups: proj })!;
    expect(out.map.new).toBe('p');
    expect(Object.keys(out.groups)).toEqual(['p']);
  });

  test('a sibling on a different branch does not trigger the group', () => {
    const out = plan({
      sessionCwd: WT_A,
      projectCwd: REPO,
      groups: proj,
      map: { other: 'p' },
      sessionCwds: { other: WT_B },
    })!;
    expect(out.map.new).toBe('p');
  });

  test('a sibling the user already filed elsewhere is left alone', () => {
    // It is not loose next to us, so pulling it out of its folder would be
    // undoing a decision the user made.
    const out = plan({
      sessionCwd: WT_A,
      projectCwd: REPO,
      groups: { ...proj, mine: group('mine', { parentId: 'p' }) },
      map: { first: 'mine' },
      sessionCwds: { first: WT_A },
    })!;
    expect(out.map).toEqual({ first: 'mine', new: 'p' });
  });

  test('sessions in the repo root never form a branch group', () => {
    // A "main" folder inside the project would just repeat the parent.
    const out = plan({
      sessionCwd: REPO,
      projectCwd: REPO,
      groups: proj,
      map: { first: 'p' },
      sessionCwds: { first: REPO },
    })!;
    expect(out.map).toEqual({ first: 'p', new: 'p' });
  });

  test('off: two sessions on a branch both stay in the project group', () => {
    const out = plan({
      sessionCwd: WT_A,
      projectCwd: REPO,
      groups: proj,
      map: { first: 'p' },
      sessionCwds: { first: WT_A },
      groupSessionsByWorktree: false,
    })!;
    expect(out.map).toEqual({ first: 'p', new: 'p' });
  });

  test('with project grouping off, the branch group lands at the root', () => {
    // Ungrouped is the *absence* of a map entry (the UI deletes the key), so
    // two loose sessions on a branch still cluster, just at the top level.
    const out = plan({
      sessionCwd: WT_A,
      projectCwd: REPO,
      sessionCwds: { first: WT_A },
      autoGroupSessions: false,
    })!;
    expect(out.groups['new-1']).toMatchObject({ name: 'feat-a', parentId: null });
    expect(out.map).toEqual({ first: 'new-1', new: 'new-1' });
  });
});

describe('planAutoGroup — auto-claim', () => {
  test('a claiming group takes the session outright', () => {
    const out = plan({
      sessionCwd: WT_A,
      projectCwd: REPO,
      groups: { b: group('b', { cwd: WT_A, autoClaim: true }) },
    })!;
    expect(out.map.new).toBe('b');
    expect(Object.keys(out.groups)).toEqual(['b']);
  });

  test('a renamed and re-parented branch group keeps claiming its checkout', () => {
    // This is what replaces re-deriving the cluster on every render.
    const out = plan({
      sessionCwd: WT_A,
      projectCwd: REPO,
      groups: {
        p: group('p', { name: 'code', cwd: REPO }),
        b: group('b', { name: 'Refactor', cwd: WT_A, parentId: null, autoClaim: true }),
      },
    })!;
    expect(out.map.new).toBe('b');
  });

  test('claiming is exact — a parent directory does not claim its worktrees', () => {
    const out = plan({
      sessionCwd: WT_A,
      projectCwd: REPO,
      groups: { p: group('p', { name: 'code', cwd: REPO, autoClaim: true }) },
    })!;
    expect(out.map.new).toBe('p');
    // Reached by the project rule (name match), not by the claim.
    expect(out.groups.p!.cwd).toBe(REPO);
  });
});

describe('planAutoGroupExisting — retroactive pass', () => {
  const loose = (id: string, cwd: string, projectCwd = cwd): LooseSession =>
    ({ sessionId: id, sessionCwd: cwd, projectCwd });

  function existing(over: Partial<Parameters<typeof planAutoGroupExisting>[0]> = {}) {
    return planAutoGroupExisting({ sessions: [], groups: {}, map: {}, newId: ids(), ...over });
  }

  test('a single loose session earns a group of its own', () => {
    // The minimum is gone: resolving the repo root makes one-session groups the
    // exception rather than the 17-groups-of-one case it used to guard against.
    const out = existing({ sessions: [loose('a', REPO)] });
    expect(out.plan).toEqual([
      { name: 'code', groupId: 'new-1', exists: false, sessionIds: ['a'] },
    ]);
    expect(out.moved).toBe(1);
    expect(out.map).toEqual({ a: 'new-1' });
  });

  test('sessions in subdirectories of one repo collapse into a single group', () => {
    // The whole reason this runs in the bridge: the caller resolved all three
    // through git, so `packages/ui` and `packages/core` are both `code`.
    const out = existing({
      sessions: [
        loose('a', REPO),
        loose('b', '/src/code/packages/ui', REPO),
        loose('c', '/src/code/packages/core', REPO),
      ],
    });
    expect(out.plan).toHaveLength(1);
    expect(out.plan[0]).toMatchObject({ name: 'code', sessionIds: ['a', 'b', 'c'] });
    expect(out.moved).toBe(3);
  });

  test('an existing group is reused by name and reported as such', () => {
    const out = existing({
      sessions: [loose('a', REPO)],
      groups: { p: group('p', { name: 'code', cwd: REPO }) },
    });
    expect(out.plan).toEqual([
      { name: 'code', groupId: 'p', exists: true, sessionIds: ['a'] },
    ]);
    expect(Object.keys(out.groups)).toEqual(['p']);
  });

  test('a group created mid-pass is still reported as new to the sessions that follow', () => {
    const out = existing({ sessions: [loose('a', REPO), loose('b', REPO)] });
    expect(out.plan).toEqual([
      { name: 'code', groupId: 'new-1', exists: false, sessionIds: ['a', 'b'] },
    ]);
  });

  test('separate projects get separate groups, with cycling colours', () => {
    const out = existing({ sessions: [loose('a', REPO), loose('b', '/src/other')] });
    expect(out.plan.map(e => e.name)).toEqual(['code', 'other']);
    expect(out.groups['new-1']!.color).toBe('blue');
    expect(out.groups['new-2']!.color).toBe('green');
  });

  test('sessions the user already filed are never touched', () => {
    // The caller filters these out, but the planner refuses them too — losing
    // a hand-placed session to an automatic pass is the one unforgivable bug.
    const out = existing({
      sessions: [loose('a', REPO), loose('mine', REPO)],
      groups: { keep: group('keep') },
      map: { mine: 'keep' },
    });
    expect(out.map.mine).toBe('keep');
    expect(out.moved).toBe(1);
  });

  test('a second pass is a no-op', () => {
    const first = existing({ sessions: [loose('a', REPO), loose('b', '/src/other')] });
    const second = planAutoGroupExisting({
      sessions: [], groups: first.groups, map: first.map, newId: ids(),
    });
    expect(second.plan).toEqual([]);
    expect(second.moved).toBe(0);
    expect(second.groups).toEqual(first.groups);
  });

  test('re-running with the same sessions reuses the group instead of duplicating it', () => {
    // Idempotence as the client would hit it: POST twice without the map
    // having been re-read in between.
    const first = existing({ sessions: [loose('a', REPO)] });
    const second = planAutoGroupExisting({
      sessions: [loose('b', REPO)], groups: first.groups, map: first.map, newId: ids(),
    });
    expect(Object.keys(second.groups)).toEqual(['new-1']);
    expect(second.plan).toEqual([
      { name: 'code', groupId: 'new-1', exists: true, sessionIds: ['b'] },
    ]);
  });

  test('a worktree session joins its repo, without a branch subgroup', () => {
    // The caller resolved the worktree to its main repo via git. The branch
    // rule stays a creation-time concern — see planAutoGroupExisting.
    const out = existing({ sessions: [loose('a', WT_A, REPO), loose('b', WT_B, REPO)] });
    expect(out.plan).toEqual([
      { name: 'code', groupId: 'new-1', exists: false, sessionIds: ['a', 'b'] },
    ]);
  });

  test('a group that claims the exact directory takes precedence', () => {
    const out = existing({
      sessions: [loose('a', WT_A, REPO)],
      groups: { b: group('b', { name: 'feat-a', cwd: WT_A, autoClaim: true }) },
    });
    expect(out.plan).toEqual([
      { name: 'feat-a', groupId: 'b', exists: true, sessionIds: ['a'] },
    ]);
  });

  test('a session with no directory is left alone', () => {
    const out = existing({ sessions: [loose('a', '', '')] });
    expect(out.plan).toEqual([]);
    expect(out.moved).toBe(0);
  });

  test('nothing loose means an empty plan, not an error', () => {
    expect(existing()).toMatchObject({ plan: [], moved: 0 });
  });
});
