import { describe, expect, test } from 'bun:test';
import { IDLE_SHUTDOWN_MS, idleSessions } from './idle-shutdown';

describe('idleSessions', () => {
  const base = { running: true, busy: false, lastActivityAt: 0 };

  test('shuts a running session down once an hour passes without activity', () => {
    expect(idleSessions([{ ...base, id: 'a' }], IDLE_SHUTDOWN_MS)).toEqual(['a']);
    expect(idleSessions([{ ...base, id: 'a' }], IDLE_SHUTDOWN_MS - 1)).toEqual([]);
  });

  test('leaves stopped and mid-turn sessions alone', () => {
    const list = [
      { ...base, id: 'stopped', running: false },
      { ...base, id: 'busy', busy: true },
    ];
    expect(idleSessions(list, 10 * IDLE_SHUTDOWN_MS)).toEqual([]);
  });

  test('recent activity resets the clock', () => {
    expect(idleSessions([{ ...base, id: 'a', lastActivityAt: 5_000 }], IDLE_SHUTDOWN_MS)).toEqual([]);
  });
});
