/**
 * Pull requests that wait on the user, polled with the GitHub CLI: reviews
 * requested from them, and their own open PRs whose checks fail. GitHub only
 * pushes to a public URL, so this polls — every few minutes is plenty for
 * PRs — and closes items the search stops returning (reviewed, fixed).
 */

import { runShell } from '../handlers/git';
import { addInboxItem, closeMissing, getInboxItem, markInboxDone, refreshInboxContext, type InboxInput } from './store';

interface GhPr {
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  createdAt?: string;
  repository: { nameWithOwner: string };
  author?: { login: string };
}

const FIELDS = 'number,title,url,createdAt,updatedAt,repository,author';
const POLL_MS = 3 * 60_000;
let timer: ReturnType<typeof setInterval> | null = null;

export function prToItem(pr: GhPr, kind: 'review_requested' | 'checks_failing'): InboxInput {
  const repo = pr.repository.nameWithOwner;
  return {
    // Keyed by kind too: the same PR can be in both lists over its life.
    id: `pr:${kind}:${repo}#${pr.number}`,
    source: 'pr',
    kind,
    title: pr.title,
    body: kind === 'review_requested'
      ? `${pr.author?.login ?? 'Someone'} asked for your review`
      : 'Checks are failing on your pull request',
    context: {
      repo, number: pr.number, author: pr.author?.login ?? null,
      createdAt: pr.createdAt ? Date.parse(pr.createdAt) : null,
      updatedAt: Date.parse(pr.updatedAt) || null,
    },
    url: pr.url,
    occurredAt: Date.parse(pr.updatedAt) || Date.now(),
  };
}

async function search(args: string): Promise<GhPr[] | null> {
  try {
    return JSON.parse(await runShell(`gh search prs ${args} --state=open --json ${FIELDS} --limit 50`, undefined, 20_000)) as GhPr[];
  } catch {
    return null;   // gh missing, not logged in, offline: leave what's there
  }
}

export async function pollPullRequests(): Promise<void> {
  const [review, failing] = await Promise.all([
    search('--review-requested=@me'),
    search('--author=@me --checks=failure'),
  ]);
  if (!review || !failing) return;
  const items = [...review.map(p => prToItem(p, 'review_requested')), ...failing.map(p => prToItem(p, 'checks_failing'))];
  // New ones land; ones already listed get fresh dates (older items lack them).
  for (const it of items) if (!addInboxItem(it)) refreshInboxContext(it.id, it.context);
  closeMissing('pr', new Set(items.map(i => i.id)));
}

export function startPullRequestPolling(): void {
  if (timer) return;
  void pollPullRequests();
  timer = setInterval(() => { void pollPullRequests(); }, POLL_MS);
}

/** Take the user off a PR's requested reviewers, then close its item. */
export async function declineReview(itemId: string): Promise<void> {
  const item = getInboxItem(itemId);
  if (!item || item.source !== 'pr' || item.kind !== 'review_requested' || !item.url) throw new Error('Not a review request');
  await runShell(`gh pr edit ${JSON.stringify(item.url)} --remove-reviewer @me`, undefined, 20_000);
  markInboxDone(itemId);
}
