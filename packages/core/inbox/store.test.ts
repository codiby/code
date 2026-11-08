import { describe, expect, test } from 'bun:test';
import { addInboxItem, closeMissing, getInboxItem, linkInboxSession, listOpenInbox, markInboxDone, markInboxRead, setInboxBroadcaster } from './store';

// Sandbox database comes from scripts/test-preload.ts, like every other suite.

let n = 0;
const item = (extra: Partial<Parameters<typeof addInboxItem>[0]> = {}) => ({
  id: `test:${++n}`, source: 'slack' as const, kind: 'mention', title: 'T', body: 'B',
  context: { channel: 'C1' }, url: null, occurredAt: 1000 + n, ...extra,
});

describe('inbox store', () => {
  test('adds once, broadcasts, lists newest first', () => {
    const sent: unknown[] = [];
    setInboxBroadcaster(m => sent.push(m));
    const a = item(), b = item();
    expect(addInboxItem(a)).toBe(true);
    expect(addInboxItem(a)).toBe(false);          // the backfill saw it too
    addInboxItem(b);
    const ids = listOpenInbox().map(i => i.id);
    expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));
    expect(sent.filter((m: any) => m.type === 'inbox_item')).toHaveLength(2);
    expect(listOpenInbox().find(i => i.id === a.id)?.context).toEqual({ channel: 'C1' });
  });

  test('done removes it from the open list; read stamps once', () => {
    const a = item();
    addInboxItem(a);
    expect(markInboxRead(a.id, 5)).toBe(true);
    expect(markInboxRead(a.id, 6)).toBe(false);
    expect(markInboxDone(a.id)).toBe(true);
    expect(markInboxDone(a.id)).toBe(false);
    expect(listOpenInbox().some(i => i.id === a.id)).toBe(false);
  });

  test('closeMissing closes what the source no longer reports', () => {
    const keep = item({ source: 'pr' }), gone = item({ source: 'pr' }), other = item();
    for (const x of [keep, gone, other]) addInboxItem(x);
    closeMissing('pr', new Set([keep.id]));
    const open = new Set(listOpenInbox().map(i => i.id));
    expect(open.has(keep.id)).toBe(true);
    expect(open.has(gone.id)).toBe(false);
    expect(open.has(other.id)).toBe(true);
  });
});

test('linking a session keeps the context and marks it read', () => {
  const a = item();
  addInboxItem(a);
  expect(linkInboxSession(a.id, 'sess-1', 77)).toBe(true);
  const got = getInboxItem(a.id)!;
  expect(got.context).toEqual({ channel: 'C1', sessionId: 'sess-1', handedAt: 77 });
  expect(got.readAt).toBe(77);
  expect(linkInboxSession('nope', 's')).toBe(false);
});
