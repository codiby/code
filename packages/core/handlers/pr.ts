/**
 * Pull-request handlers backing the PR side panel: detail, unified diff,
 * review threads, commenting and merging.
 *
 * Everything here shells out to `gh`, which already carries the user's auth and
 * — for merge — is refused server-side by GitHub under exactly the same rules
 * the web UI enforces. We mirror those rules client-side only to explain *why*
 * a button is disabled; the API stays the authority.
 *
 * Unlike `runShell` in git.ts, these spawn `gh` with an argv array and no
 * shell. Comment bodies and merge subjects are attacker-shaped input (they come
 * from a textarea, and an agent can drive the same routes), so passing them
 * through `sh -c` would be a command-injection hole with no upside.
 */

import { corsHeaders } from '../config/config';

const GH_TIMEOUT = 20000;

export type GhResult = { ok: boolean; stdout: string; stderr: string; code: number };

/** Spawn `gh` with an argv array. No shell, so no quoting and no injection. */
export async function runGh(args: string[], cwd?: string, timeout = GH_TIMEOUT): Promise<GhResult> {
  const proc = Bun.spawn(['gh', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat' },
  });
  const timer = setTimeout(() => { try { proc.kill(); } catch {} }, timeout);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { ok: code === 0, stdout, stderr, code };
  } finally {
    clearTimeout(timer);
  }
}

/** `gh` writes its real complaint to stderr; the first non-empty line of it is
 *  what the user needs to see ("Pull request is not mergeable", "GraphQL: …"). */
function ghError(res: GhResult, fallback: string): string {
  const line = res.stderr.split('\n').map(l => l.trim()).find(Boolean);
  return line || fallback;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body as Record<string, unknown>, { status, headers: corsHeaders });
}

/** A PR reference is always a positive integer here — the panel only ever has a
 *  number, and validating keeps a bad value from reaching `gh` as a flag. */
function prNumber(raw: unknown): number | null {
  const n = Number(String(raw ?? '').trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

/** Everything `gh pr view` can tell us that the panel renders or gates on. */
const PR_VIEW_FIELDS = [
  'number', 'title', 'body', 'headRefName', 'baseRefName', 'state', 'url', 'isDraft',
  'additions', 'deletions', 'changedFiles', 'commits', 'reviews', 'comments', 'labels',
  'author', 'createdAt', 'updatedAt', 'mergedAt', 'mergeable',
  // Merge gating — the same signals the web button reads.
  'mergeStateStatus', 'reviewDecision', 'statusCheckRollup', 'headRefOid',
].join(',');

/** Repo-level merge policy: which buttons GitHub would even offer. */
const REPO_VIEW_FIELDS = [
  'nameWithOwner', 'mergeCommitAllowed', 'squashMergeAllowed', 'rebaseMergeAllowed',
  'deleteBranchOnMerge', 'viewerPermission',
].join(',');

export async function handlePrDetail(rawNumber: unknown, cwd: string): Promise<Response> {
  const number = prNumber(rawNumber);
  if (number === null) return json({ error: 'missing or invalid PR number' }, 400);

  // One round-trip each, in parallel: the PR itself and the repo's merge policy.
  const [prRes, repoRes] = await Promise.all([
    runGh(['pr', 'view', String(number), '--json', PR_VIEW_FIELDS], cwd),
    runGh(['repo', 'view', '--json', REPO_VIEW_FIELDS], cwd),
  ]);
  if (!prRes.ok) return json({ error: ghError(prRes, `gh pr view ${number} failed`) }, 502);

  let detail: Record<string, unknown>;
  try {
    detail = JSON.parse(prRes.stdout);
  } catch {
    return json({ error: 'gh returned malformed JSON for this PR' }, 502);
  }

  // Repo policy is best-effort: without it the panel still renders, it just
  // offers every merge method and lets GitHub reject the disallowed ones.
  if (repoRes.ok) {
    try { detail.repo = JSON.parse(repoRes.stdout); } catch {}
  }
  return json(detail);
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export async function handlePrDiff(rawNumber: unknown, cwd: string): Promise<Response> {
  const number = prNumber(rawNumber);
  if (number === null) return json({ error: 'missing or invalid PR number' }, 400);

  const res = await runGh(['pr', 'diff', String(number)], cwd, 60000);
  if (!res.ok) return json({ error: ghError(res, `gh pr diff ${number} failed`) }, 502);
  // Returned as one blob and parsed in the client: the panel needs the raw
  // hunk headers anyway to line review comments up with their code.
  return json({ diff: res.stdout });
}

// ---------------------------------------------------------------------------
// Review threads
// ---------------------------------------------------------------------------

/** As returned by `GET /repos/{slug}/pulls/{n}/comments`. Note `in_reply_to_id`
 *  is *absent* on a thread root, not null — only replies carry it. */
type RawReviewComment = {
  id: number;
  in_reply_to_id?: number | null;
  path: string;
  line?: number | null;
  original_line?: number | null;
  start_line?: number | null;
  side?: string | null;
  diff_hunk: string;
  body: string;
  created_at: string;
  html_url: string;
  user?: { login: string } | null;
};

export type ReviewThread = {
  id: number;
  path: string;
  line: number | null;
  side: string | null;
  diffHunk: string;
  comments: {
    id: number;
    author: string;
    body: string;
    createdAt: string;
    url: string;
  }[];
};

/** Group flat review comments into threads. GitHub models a thread as a root
 *  comment plus replies pointing at it through `in_reply_to_id`, so the root's
 *  id is also the id you reply to. */
export function groupReviewThreads(raw: RawReviewComment[]): ReviewThread[] {
  const threads = new Map<number, ReviewThread>();
  const toComment = (c: RawReviewComment) => ({
    id: c.id,
    author: c.user?.login || 'unknown',
    body: c.body,
    createdAt: c.created_at,
    url: c.html_url,
  });

  // Roots first, so a reply that arrives before its root in the array (the API
  // orders by id, which is usually but not always parent-first) still lands.
  for (const c of raw) {
    if (c.in_reply_to_id) continue;
    threads.set(c.id, {
      id: c.id,
      path: c.path,
      // `line` is null once a comment is outdated by a force-push; the line it
      // was originally left on is the next best anchor.
      line: c.line ?? c.original_line ?? null,
      side: c.side ?? null,
      diffHunk: c.diff_hunk,
      comments: [toComment(c)],
    });
  }
  for (const c of raw) {
    if (!c.in_reply_to_id) continue;
    const thread = threads.get(c.in_reply_to_id);
    // An orphan reply (its root was deleted) becomes its own thread rather
    // than vanishing from the panel.
    if (thread) thread.comments.push(toComment(c));
    else threads.set(c.id, {
      id: c.id, path: c.path, line: c.line ?? c.original_line ?? null, side: c.side ?? null,
      diffHunk: c.diff_hunk, comments: [toComment(c)],
    });
  }
  return [...threads.values()];
}

/** `nameWithOwner` for the repo at `cwd`, needed for the REST endpoints `gh pr`
 *  doesn't wrap (review-comment replies). */
async function repoSlug(cwd: string): Promise<string | null> {
  const res = await runGh(['repo', 'view', '--json', 'nameWithOwner'], cwd);
  if (!res.ok) return null;
  try { return JSON.parse(res.stdout).nameWithOwner || null; } catch { return null; }
}

export async function handlePrReviewThreads(rawNumber: unknown, cwd: string): Promise<Response> {
  const number = prNumber(rawNumber);
  if (number === null) return json({ error: 'missing or invalid PR number' }, 400);

  const slug = await repoSlug(cwd);
  if (!slug) return json({ error: 'could not resolve the repository for this directory' }, 502);

  const res = await runGh(
    ['api', '--paginate', `repos/${slug}/pulls/${number}/comments?per_page=100`],
    cwd,
  );
  if (!res.ok) return json({ error: ghError(res, 'could not read review comments') }, 502);

  let raw: RawReviewComment[];
  try {
    // `--paginate` concatenates JSON arrays as `][`; rejoin them into one.
    raw = JSON.parse(res.stdout.replace(/\]\s*\[/g, ','));
  } catch {
    return json({ error: 'gh returned malformed JSON for review comments' }, 502);
  }
  return json({ threads: groupReviewThreads(raw) });
}

// ---------------------------------------------------------------------------
// Commenting
// ---------------------------------------------------------------------------

export async function handlePrComment(body: {
  number?: unknown; cwd?: unknown; body?: unknown; replyTo?: unknown;
}): Promise<Response> {
  const number = prNumber(body.number);
  const cwd = typeof body.cwd === 'string' ? body.cwd : '';
  const text = typeof body.body === 'string' ? body.body.trim() : '';
  if (number === null) return json({ error: 'missing or invalid PR number' }, 400);
  if (!cwd) return json({ error: 'cwd is required' }, 400);
  if (!text) return json({ error: 'comment body cannot be empty' }, 400);

  // Replying inside a review thread is a different endpoint from commenting on
  // the PR — `gh pr comment` can only do the latter.
  if (body.replyTo !== undefined && body.replyTo !== null) {
    const replyTo = prNumber(body.replyTo);
    if (replyTo === null) return json({ error: 'invalid replyTo comment id' }, 400);
    const slug = await repoSlug(cwd);
    if (!slug) return json({ error: 'could not resolve the repository for this directory' }, 502);
    const res = await runGh(
      ['api', '--method', 'POST', `repos/${slug}/pulls/${number}/comments/${replyTo}/replies`,
       '-f', `body=${text}`],
      cwd,
    );
    if (!res.ok) return json({ error: ghError(res, 'could not post the reply') }, 502);
    return json({ ok: true });
  }

  const res = await runGh(['pr', 'comment', String(number), '--body', text], cwd);
  if (!res.ok) return json({ error: ghError(res, 'could not post the comment') }, 502);
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

const MERGE_FLAGS: Record<string, string> = {
  merge: '--merge',
  squash: '--squash',
  rebase: '--rebase',
};

export async function handlePrMerge(body: {
  number?: unknown; cwd?: unknown; method?: unknown;
  deleteBranch?: unknown; auto?: unknown; subject?: unknown; bodyText?: unknown;
}): Promise<Response> {
  const number = prNumber(body.number);
  const cwd = typeof body.cwd === 'string' ? body.cwd : '';
  const method = String(body.method ?? '');
  if (number === null) return json({ error: 'missing or invalid PR number' }, 400);
  if (!cwd) return json({ error: 'cwd is required' }, 400);
  const flag = MERGE_FLAGS[method];
  if (!flag) return json({ error: `merge method must be one of ${Object.keys(MERGE_FLAGS).join(', ')}` }, 400);

  // Pre-flight the state. `gh pr merge` on an already-merged PR prints
  // "was already merged" to stderr and still exits 0, so trusting the exit code
  // alone would report a merge that never happened. The panel hides the button
  // in that case, but this route is also reachable by an agent.
  const state = await runGh(['pr', 'view', String(number), '--json', 'state,isDraft'], cwd);
  if (state.ok) {
    try {
      const { state: prState, isDraft } = JSON.parse(state.stdout);
      if (prState === 'MERGED') return json({ error: 'This pull request is already merged.', merged: false }, 409);
      if (prState === 'CLOSED') return json({ error: 'This pull request is closed.', merged: false }, 409);
      if (isDraft) return json({ error: 'This pull request is a draft — mark it ready for review first.', merged: false }, 409);
    } catch {
      // Unreadable state: fall through and let `gh` decide.
    }
  }

  const args = ['pr', 'merge', String(number), flag];
  // `--auto` queues the merge for when checks pass instead of demanding the PR
  // be mergeable right now; it's the same "enable auto-merge" the web offers.
  if (body.auto) args.push('--auto');
  if (body.deleteBranch) args.push('--delete-branch');
  if (typeof body.subject === 'string' && body.subject.trim()) args.push('--subject', body.subject.trim());
  if (typeof body.bodyText === 'string' && body.bodyText.trim()) args.push('--body', body.bodyText.trim());

  const res = await runGh(args, cwd, 60000);
  if (!res.ok) {
    // Branch protection, failing checks, missing approvals and conflicts all
    // surface here — GitHub refuses the mutation, we just relay the reason.
    return json({ error: ghError(res, 'merge failed'), merged: false }, 502);
  }
  // `gh` warns on stderr with a leading `!` for the no-op cases it still exits
  // 0 on; treat those as "nothing happened" rather than a merge.
  const warning = res.stderr.split('\n').map(l => l.trim()).find(l => l.startsWith('!'));
  if (warning) return json({ error: warning.replace(/^!\s*/, ''), merged: false }, 409);
  return json({ ok: true, merged: true, auto: !!body.auto, output: res.stdout.trim() });
}
