/**
 * Decides what the merge control may offer, mirroring the rules GitHub's own
 * merge button follows.
 *
 * This is presentation only. The API is the authority — `gh pr merge` is
 * refused server-side by branch protection, required reviews and conflicts
 * regardless of what we render. What this buys is an *explanation*: a disabled
 * button that says "2 required checks still running" instead of one that says
 * nothing and fails after the click.
 */

export type MergeMethod = 'merge' | 'squash' | 'rebase';

export type PrMergeInput = {
  state: string;
  isDraft: boolean;
  /** MERGEABLE | CONFLICTING | UNKNOWN */
  mergeable?: string;
  /** CLEAN | BLOCKED | BEHIND | DIRTY | UNSTABLE | HAS_HOOKS | DRAFT | UNKNOWN */
  mergeStateStatus?: string;
  /** APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | '' (no review required) */
  reviewDecision?: string;
  statusCheckRollup?: { name?: string; conclusion?: string; status?: string; state?: string }[];
  repo?: {
    mergeCommitAllowed?: boolean;
    squashMergeAllowed?: boolean;
    rebaseMergeAllowed?: boolean;
    deleteBranchOnMerge?: boolean;
    viewerPermission?: string;
  };
};

export type MergeAvailability = {
  /** Merge methods the repository permits, in GitHub's own order. */
  methods: MergeMethod[];
  /** True when merging right now should succeed. */
  canMerge: boolean;
  /** True when the only thing in the way is time — checks still running or a
   *  protection rule that will clear. This is what `--auto` is for. */
  canAutoMerge: boolean;
  /** One line explaining the state, shown next to the button either way. */
  reason: string;
  tone: 'ready' | 'blocked' | 'warn' | 'done';
};

const WRITE_ROLES = new Set(['WRITE', 'MAINTAIN', 'ADMIN']);

/** Checks that finished badly. GitHub blocks only on *required* ones, which the
 *  rollup doesn't flag — so a failure here is reported as a warning unless
 *  `mergeStateStatus` independently says BLOCKED. */
export function failingChecks(input: PrMergeInput): string[] {
  return (input.statusCheckRollup || [])
    .filter(c => {
      const verdict = (c.conclusion || c.state || '').toUpperCase();
      return ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED'].includes(verdict);
    })
    .map(c => c.name || 'check');
}

export function pendingChecks(input: PrMergeInput): string[] {
  return (input.statusCheckRollup || [])
    .filter(c => {
      const state = (c.status || c.state || '').toUpperCase();
      return ['IN_PROGRESS', 'QUEUED', 'PENDING', 'WAITING', 'REQUESTED'].includes(state);
    })
    .map(c => c.name || 'check');
}

export function allowedMethods(input: PrMergeInput): MergeMethod[] {
  const repo = input.repo;
  // No repo policy (the `gh repo view` call failed) — offer everything and let
  // GitHub reject what the repo disallows, rather than hiding every button.
  if (!repo) return ['merge', 'squash', 'rebase'];
  const out: MergeMethod[] = [];
  if (repo.mergeCommitAllowed !== false) out.push('merge');
  if (repo.squashMergeAllowed !== false) out.push('squash');
  if (repo.rebaseMergeAllowed !== false) out.push('rebase');
  return out;
}

export function mergeAvailability(input: PrMergeInput): MergeAvailability {
  const methods = allowedMethods(input);
  const no = (reason: string, tone: MergeAvailability['tone'] = 'blocked', canAutoMerge = false): MergeAvailability =>
    ({ methods, canMerge: false, canAutoMerge, reason, tone });

  const state = (input.state || '').toUpperCase();
  if (state === 'MERGED') return no('Already merged.', 'done');
  if (state === 'CLOSED') return no('This pull request is closed.', 'done');

  const permission = input.repo?.viewerPermission;
  if (permission && !WRITE_ROLES.has(permission.toUpperCase())) {
    return no('You do not have write access to this repository.');
  }
  if (methods.length === 0) return no('This repository allows no merge method.');
  if (input.isDraft) return no('This is a draft — mark it ready for review first.');

  const mergeable = (input.mergeable || '').toUpperCase();
  const mergeState = (input.mergeStateStatus || '').toUpperCase();

  if (mergeable === 'CONFLICTING' || mergeState === 'DIRTY') {
    return no('Conflicts must be resolved before merging.');
  }
  if ((input.reviewDecision || '').toUpperCase() === 'CHANGES_REQUESTED') {
    return no('Changes requested — the review must be resolved.');
  }

  const failing = failingChecks(input);
  const pending = pendingChecks(input);

  switch (mergeState) {
    case 'BEHIND':
      return no('The branch is out of date with the base branch.');
    case 'BLOCKED': {
      // Branch protection is holding it. Naming the specific blocker is what
      // makes the disabled button actionable.
      if ((input.reviewDecision || '').toUpperCase() === 'REVIEW_REQUIRED') {
        return no('Review required before this can be merged.', 'blocked', true);
      }
      if (pending.length) {
        return no(`${pending.length} required check${pending.length === 1 ? '' : 's'} still running.`, 'blocked', true);
      }
      if (failing.length) return no(`Required checks failing: ${failing.slice(0, 3).join(', ')}.`);
      return no('Blocked by branch protection rules.', 'blocked', true);
    }
    case 'UNSTABLE':
      // Mergeable, but something red that isn't required. GitHub lets this
      // through with a warning, so we do too.
      return {
        methods, canMerge: true, canAutoMerge: true, tone: 'warn',
        reason: failing.length
          ? `Mergeable, but these checks failed: ${failing.slice(0, 3).join(', ')}.`
          : 'Mergeable, but some checks have not succeeded.',
      };
    case 'UNKNOWN':
      // GitHub computes mergeability lazily; it resolves within a second or two
      // of the first read. Allow the attempt — the API still refuses if it
      // turns out not to be mergeable.
      return {
        methods, canMerge: true, canAutoMerge: true, tone: 'warn',
        reason: 'GitHub is still computing mergeability — reload in a moment.',
      };
    case 'CLEAN':
    case 'HAS_HOOKS':
    default:
      if (failing.length) {
        return {
          methods, canMerge: true, canAutoMerge: true, tone: 'warn',
          reason: `Mergeable, but these checks failed: ${failing.slice(0, 3).join(', ')}.`,
        };
      }
      return { methods, canMerge: true, canAutoMerge: true, tone: 'ready', reason: 'Ready to merge.' };
  }
}
