import { describe, expect, test } from 'bun:test';
import { addInboxItem, closeMissing, listOpenInbox, markInboxDone, markInboxRead, setInboxBroadcaster } from './store';

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
