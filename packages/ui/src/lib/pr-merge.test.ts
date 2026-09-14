import { describe, expect, test } from 'bun:test';
import { allowedMethods, failingChecks, mergeAvailability, type PrMergeInput } from './pr-merge';

const open = (over: Partial<PrMergeInput> = {}): PrMergeInput => ({
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  reviewDecision: '',
  statusCheckRollup: [],
  repo: { mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true, viewerPermission: 'ADMIN' },
  ...over,
});

describe('allowedMethods', () => {
  test('offers only what the repository permits', () => {
    expect(allowedMethods(open({ repo: { squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: false } })))
      .toEqual(['squash']);
  });

  test('offers all three when the repo policy could not be read', () => {
    // Hiding every button because one `gh repo view` failed would be worse
    // than offering a method GitHub then rejects.
    expect(allowedMethods(open({ repo: undefined }))).toEqual(['merge', 'squash', 'rebase']);
  });
});

describe('mergeAvailability', () => {
  test('a clean PR is ready', () => {
    const a = mergeAvailability(open());
    expect(a).toMatchObject({ canMerge: true, tone: 'ready' });
  });

  test('refuses an already-merged or closed PR', () => {
    expect(mergeAvailability(open({ state: 'MERGED' }))).toMatchObject({ canMerge: false, tone: 'done' });
    expect(mergeAvailability(open({ state: 'CLOSED' }))).toMatchObject({ canMerge: false, tone: 'done' });
  });

  test('refuses without write access', () => {
    const a = mergeAvailability(open({ repo: { viewerPermission: 'READ' } }));
    expect(a.canMerge).toBe(false);
    expect(a.reason).toContain('write access');
  });

  test('refuses a draft', () => {
    expect(mergeAvailability(open({ isDraft: true })).reason).toContain('draft');
  });

  test('refuses on conflicts, however they are reported', () => {
    expect(mergeAvailability(open({ mergeable: 'CONFLICTING' })).reason).toContain('Conflicts');
    expect(mergeAvailability(open({ mergeStateStatus: 'DIRTY' })).reason).toContain('Conflicts');
  });

  test('refuses when changes were requested', () => {
    expect(mergeAvailability(open({ reviewDecision: 'CHANGES_REQUESTED' })).reason).toContain('Changes requested');
  });

  test('refuses a branch that is behind base', () => {
    expect(mergeAvailability(open({ mergeStateStatus: 'BEHIND' })).reason).toContain('out of date');
  });

  test('names the specific blocker under branch protection', () => {
    const needsReview = mergeAvailability(open({ mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' }));
    expect(needsReview.reason).toContain('Review required');
    // A blocker that clears on its own is exactly what auto-merge is for.
    expect(needsReview.canAutoMerge).toBe(true);

    const running = mergeAvailability(open({
      mergeStateStatus: 'BLOCKED',
      statusCheckRollup: [{ name: 'build', status: 'IN_PROGRESS' }, { name: 'test', status: 'QUEUED' }],
    }));
    expect(running.reason).toContain('2 required checks still running');
    expect(running.canAutoMerge).toBe(true);
  });

  test('a required check that failed blocks, and cannot be auto-merged away', () => {
    const a = mergeAvailability(open({
      mergeStateStatus: 'BLOCKED',
      statusCheckRollup: [{ name: 'lint', conclusion: 'FAILURE' }],
    }));
    expect(a.canMerge).toBe(false);
    expect(a.canAutoMerge).toBe(false);
    expect(a.reason).toContain('lint');
  });

  test('UNSTABLE still merges, with the failure named', () => {
    // A red check that is not required: GitHub allows the merge and warns.
    const a = mergeAvailability(open({
      mergeStateStatus: 'UNSTABLE',
      statusCheckRollup: [{ name: 'flaky-e2e', conclusion: 'FAILURE' }],
    }));
    expect(a).toMatchObject({ canMerge: true, tone: 'warn' });
    expect(a.reason).toContain('flaky-e2e');
  });

  test('UNKNOWN allows the attempt rather than blocking on a lazy computation', () => {
    // GitHub reports UNKNOWN until it computes mergeability; blocking here
    // would leave the button dead on every freshly-opened PR.
    const a = mergeAvailability(open({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }));
    expect(a.canMerge).toBe(true);
    expect(a.tone).toBe('warn');
  });

  test('refuses when the repository allows no merge method at all', () => {
    const a = mergeAvailability(open({
      repo: { mergeCommitAllowed: false, squashMergeAllowed: false, rebaseMergeAllowed: false, viewerPermission: 'ADMIN' },
    }));
    expect(a.canMerge).toBe(false);
    expect(a.methods).toEqual([]);
  });
});

describe('failingChecks', () => {
  test('counts every bad conclusion but not pending or success', () => {
    expect(failingChecks(open({
      statusCheckRollup: [
        { name: 'a', conclusion: 'SUCCESS' },
        { name: 'b', conclusion: 'FAILURE' },
        { name: 'c', conclusion: 'TIMED_OUT' },
        { name: 'd', status: 'IN_PROGRESS' },
        { name: 'e', state: 'ERROR' },
      ],
    }))).toEqual(['b', 'c', 'e']);
  });
});
