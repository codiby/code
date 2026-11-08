import { describe, expect, test } from 'bun:test';
import type { InboxItem, SessionInfo } from './claude-client';
import { buildInboxRows, initials, itemRow } from './inbox';

const session = (id: string): SessionInfo => ({
  id, name: id, cwd: '/src', created_at: 0, updated_at: 0,
  status: 'open', runtime_status: 'running', ready: true,
  claude_session_id: null, ws_url: '', saved_commands: [], model: null, permission_mode: 'default',
});
const item = (extra: Partial<InboxItem>): InboxItem => ({
  id: 'x', source: 'slack', kind: 'mention', title: 'Mariana Ruiz', body: 'hola', context: { where: '#up-dev', inThread: true },
  url: null, occurredAt: 10, readAt: null, doneAt: null, ...extra,
});
const flags = {
  hasPermission: { a: true }, interrupted: { b: true }, awaitingReply: new Set(['c']),
  lastMessageAt: { a: 5, b: 6, c: 7 }, lastPreview: { c: 'listo' }, describe: () => 'code · Opus 5.5',
};

describe('inbox rows', () => {
  test('sessions become rows only when they wait on the user', () => {
    const rows = buildInboxRows([], ['a', 'b', 'c', 'd'].map(session), flags);
    expect(rows.map(r => [r.sessionId, r.bucket, r.tag?.label])).toEqual([
      ['a', 'decision', 'Needs approval'],
      ['b', 'broke', 'Interrupted'],
      ['c', 'read', 'Turn finished'],
    ]);
  });

  test('Slack: mentions ask for a decision, DMs are to read', () => {
    expect(itemRow(item({})).bucket).toBe('decision');
    expect(itemRow(item({})).where).toBe('#up-dev · mention in thread');
    expect(itemRow(item({ kind: 'dm', context: { where: 'direct message' } })).bucket).toBe('read');
  });

  test('PRs: review requested vs failing checks', () => {
    const rr = itemRow(item({ source: 'pr', kind: 'review_requested', title: 'feat', context: { repo: 'org/web', number: 12, author: 'rtalexk' } }));
    expect([rr.bucket, rr.where, rr.person]).toEqual(['decision', 'web #12 · review requested', 'RT']);
    const cf = itemRow(item({ source: 'pr', kind: 'checks_failing', context: { repo: 'org/web', number: 3 } }));
    expect([cf.bucket, cf.status]).toEqual(['broke', 'err']);
  });

  test('done items drop out; buckets in order, newest first inside', () => {
    const rows = buildInboxRows([item({ id: 'old', occurredAt: 1 }), item({ id: 'new', occurredAt: 9 }), item({ id: 'gone', doneAt: 3 })], [], flags);
    expect(rows.map(r => r.id)).toEqual(['new', 'old']);
  });

  test('initials', () => {
    expect(initials('Mariana Ruiz')).toBe('MR');
    expect(initials('rtalexk')).toBe('RT');
  });
});

describe('handed to an agent', () => {
  test('the item moves to "With an agent", takes the session state, and the session is not listed twice', () => {
    const it = item({ id: 'pr1', source: 'pr', kind: 'review_requested', context: { repo: 'o/web', number: 1, sessionId: 'c' } });
    const rows = buildInboxRows([it], [session('c')], {
      ...flags,
      agent: sid => ({ sessionId: sid, name: 'Review PR', state: 'finished', preview: 'LGTM with two nits' }),
    });
    expect(rows.map(r => r.id)).toEqual(['pr1']);
    expect([rows[0]!.bucket, rows[0]!.tag?.label, rows[0]!.agent?.preview]).toEqual(['progress', 'Agent finished', 'LGTM with two nits']);
  });
});
