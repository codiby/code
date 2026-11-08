import { describe, expect, test, beforeEach } from 'bun:test';
import { appendFileSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { dayKey, foldLine, resetUsageCache, usageForFile, type DayUsage } from './usage-scan';

const T = new Date(2026, 10, 8, 15, 0).getTime();   // Nov 8, local time

describe('foldLine', () => {
  test('counts user turns, cost and tokens by local day', () => {
    const days = new Map<string, DayUsage>();
    foldLine(JSON.stringify({ role: 'user', content: 'hi', timestamp: T }), days);
    foldLine(JSON.stringify({ role: 'assistant', content: 'ok', timestamp: T, costUsd: 0.25, usage: { input_tokens: 100, output_tokens: 50 } }), days);
    foldLine(JSON.stringify({ role: 'assistant', content: 'tool', timestamp: T }), days);
    expect(days.get(dayKey(T))).toEqual({ costUsd: 0.25, tokens: 150, userMessages: 1 });
  });

  test('ignores broken lines and lines without a timestamp', () => {
    const days = new Map<string, DayUsage>();
    foldLine('{"role":"user", nope', days);
    foldLine(JSON.stringify({ role: 'user', content: 'x' }), days);
    expect(days.size).toBe(0);
  });
});

describe('foldLine — running totals', () => {
  test('a turn costs the step from the previous total; a drop restarts the count', () => {
    const days = new Map<string, DayUsage>();
    const totals = { cost: 0, tokens: 0 };
    const res = (cost: number, out: number) => JSON.stringify({ role: 'assistant', timestamp: T, costUsd: cost, usage: { input_tokens: 0, output_tokens: out } });
    foldLine(res(2, 100), days, totals);
    foldLine(res(5, 250), days, totals);
    foldLine(res(1, 40), days, totals);     // provider restarted
    expect(days.get(dayKey(T))).toEqual({ costUsd: 6, tokens: 290, userMessages: 0 });
  });
});

describe('usageForFile', () => {
  beforeEach(() => resetUsageCache());

  test('reads only what was appended, including a line split across reads', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'usage-')), 'messages.jsonl');
    writeFileSync(file, JSON.stringify({ role: 'user', timestamp: T }) + '\n');
    expect(usageForFile(file).get(dayKey(T))?.userMessages).toBe(1);

    const line = JSON.stringify({ role: 'assistant', timestamp: T, costUsd: 1 });
    appendFileSync(file, line.slice(0, 10));            // a write caught mid-line
    expect(usageForFile(file).get(dayKey(T))?.costUsd).toBe(0);
    appendFileSync(file, line.slice(10) + '\n');
    expect(usageForFile(file).get(dayKey(T))).toEqual({ costUsd: 1, tokens: 0, userMessages: 1 });
  });

  test('a rewritten (shorter) file is read again from the start', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'usage-')), 'messages.jsonl');
    writeFileSync(file, JSON.stringify({ role: 'user', timestamp: T }) + '\n' + JSON.stringify({ role: 'user', timestamp: T }) + '\n');
    expect(usageForFile(file).get(dayKey(T))?.userMessages).toBe(2);
    writeFileSync(file, JSON.stringify({ role: 'user', timestamp: T }) + '\n');
    expect(usageForFile(file).get(dayKey(T))?.userMessages).toBe(1);
  });

  test('a missing file is empty', () => {
    expect(usageForFile('/nonexistent/messages.jsonl').size).toBe(0);
  });
});
