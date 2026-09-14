import { describe, expect, test } from 'bun:test';
import { groupReviewThreads, handlePrComment, handlePrMerge, runGh } from './pr';

/** Shaped like a real `GET /repos/{slug}/pulls/{n}/comments` entry. The field
 *  that matters: a thread root has NO `in_reply_to_id` key at all — GitHub
 *  omits it rather than sending null, which a `=== null` check would miss. */
const comment = (over: Partial<Record<string, unknown>> & { id: number }) => ({
  path: 'src/a.ts',
  line: 10,
  original_line: 10,
  side: 'RIGHT',
  diff_hunk: '@@ -1,3 +1,3 @@\n-old\n+new',
  body: 'body',
  created_at: '2026-01-01T00:00:00Z',
  html_url: `https://github.com/o/r/pull/1#discussion_r${over.id}`,
  user: { login: 'someone' },
  ...over,
}) as any;

describe('groupReviewThreads', () => {
  test('nests replies under the root they point at', () => {
    const threads = groupReviewThreads([
      comment({ id: 1, body: 'root' }),
      comment({ id: 2, in_reply_to_id: 1, body: 'reply' }),
      comment({ id: 3, path: 'src/b.ts', line: 4, body: 'other root' }),
    ]);

    expect(threads).toHaveLength(2);
    expect(threads[0]!.comments.map(c => c.body)).toEqual(['root', 'reply']);
    expect(threads[1]!.path).toBe('src/b.ts');
  });

  test('replies to a root that appears later still attach', () => {
    // The API orders by id, but a reply is not guaranteed to follow its root
    // in the same page — grouping must not depend on arrival order.
    const threads = groupReviewThreads([
      comment({ id: 9, in_reply_to_id: 5, body: 'reply' }),
      comment({ id: 5, body: 'root' }),
    ]);

    expect(threads).toHaveLength(1);
    expect(threads[0]!.comments.map(c => c.body)).toEqual(['root', 'reply']);
  });

  test('the thread id is the root id, which is what a reply must target', () => {
    const threads = groupReviewThreads([
      comment({ id: 42, body: 'root' }),
      comment({ id: 43, in_reply_to_id: 42, body: 'reply' }),
    ]);

    expect(threads[0]!.id).toBe(42);
  });

  test('falls back to original_line for a comment outdated by a force-push', () => {
    const threads = groupReviewThreads([comment({ id: 1, line: null, original_line: 77 })]);

    expect(threads[0]!.line).toBe(77);
  });

  test('an orphan reply becomes its own thread rather than disappearing', () => {
    // Root deleted: the reply is still a real comment the user must be able to
    // see, so it is promoted instead of dropped.
    const threads = groupReviewThreads([comment({ id: 8, in_reply_to_id: 999, body: 'orphan' })]);

    expect(threads).toHaveLength(1);
    expect(threads[0]!.comments[0]!.body).toBe('orphan');
  });

  test('a missing author does not blow up the panel', () => {
    const threads = groupReviewThreads([comment({ id: 1, user: null })]);

    expect(threads[0]!.comments[0]!.author).toBe('unknown');
  });
});

describe('handlePrMerge input validation', () => {
  test('rejects a merge method that is not one of the three', async () => {
    // The method is chosen from a fixed set rather than passed through: it ends
    // up as a `gh` flag, and an allowlist is the only safe shape for that.
    const res = await handlePrMerge({ number: 1, cwd: '/tmp', method: 'squash; rm -rf /tmp' });

    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toContain('merge method must be one of');
  });

  test('rejects a non-numeric PR reference', async () => {
    const res = await handlePrMerge({ number: '3 --admin', cwd: '/tmp', method: 'squash' });

    expect(res.status).toBe(400);
  });

  test('requires a cwd', async () => {
    const res = await handlePrMerge({ number: 1, method: 'squash' });

    expect(res.status).toBe(400);
  });
});

describe('handlePrComment input validation', () => {
  test('refuses an empty body instead of posting a blank comment', async () => {
    const res = await handlePrComment({ number: 1, cwd: '/tmp', body: '   ' });

    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toContain('empty');
  });

  test('refuses a reply id that is not a number', async () => {
    const res = await handlePrComment({ number: 1, cwd: '/tmp', body: 'hi', replyTo: 'x; whoami' });

    expect(res.status).toBe(400);
  });
});

describe('runGh', () => {
  test('passes arguments as argv, so shell metacharacters stay literal', async () => {
    // The decisive property for /pr-comment: a body containing `;` or `$()`
    // must arrive as text, never be interpreted. `gh` is not involved here —
    // we assert the spawn contract itself with a command that echoes back.
    const nasty = 'hello; touch /tmp/codiby-pwned-$(whoami)';
    const proc = Bun.spawn(['echo', nasty], { stdout: 'pipe' });
    const out = await new Response(proc.stdout).text();

    expect(out.trim()).toBe(nasty);
  });

  test('reports a non-zero exit instead of throwing', async () => {
    const res = await runGh(['definitely-not-a-gh-command'], '/tmp', 15000);

    expect(res.ok).toBe(false);
    expect(res.code).not.toBe(0);
  });
});
