import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const dir = mkdtempSync(join(tmpdir(), 'codiby-interrupted-'));
const m = await import('./interrupted');
m.setInterruptedTurnsFile(join(dir, 'inflight-turns.json'));
const onDisk = () => JSON.parse(readFileSync(join(dir, 'inflight-turns.json'), 'utf-8')).sessionIds as string[];

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('interrupted turns', () => {
  test('mirrors turn start/end to disk', () => {
    m.trackTurnState('a', true);
    m.trackTurnState('b', true);
    m.trackTurnState('a', false);
    expect(onDisk()).toEqual(['b']);
  });

  test('a frozen tracker keeps what was busy at shutdown', () => {
    m.freezeTurnTracking();
    m.trackTurnState('b', false); // provider onExit during shutdown
    expect(onDisk()).toEqual(['b']);
  });

  test('the next boot offers the leftovers, filtered, and starts clean', () => {
    m.loadInterruptedTurns((id) => id !== 'gone');
    expect(m.getInterruptedTurns().map(t => t.sessionId)).toEqual(['b']);
    expect(onDisk()).toEqual([]);
    m.clearInterruptedTurns(['b']);
    expect(m.getInterruptedTurns()).toEqual([]);
  });
});
