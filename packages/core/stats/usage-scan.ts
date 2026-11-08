/**
 * Per-day usage read straight from the session message logs.
 *
 * Cost and token counts are only ever written into each session's
 * append-only `messages.jsonl` (the turn-result message carries `costUsd` and
 * `usage`). Both are running totals for the provider process — the SDK
 * reports `total_cost_usd` — so a turn's own cost is the step from the
 * previous result. A drop means the process restarted and the count began
 * again from zero. There is no table to query, and the logs add up to hundreds of
 * megabytes, so this keeps a cursor per file and only parses bytes appended
 * since the last read. A file that shrank was rewritten; it is read again from
 * the start.
 */

import { closeSync, openSync, readSync, statSync } from 'fs';

export interface DayUsage {
  costUsd: number;
  tokens: number;
  /** Messages the user sent that day. */
  userMessages: number;
}

/** `YYYY-MM-DD` in the bridge's local time zone — the user's calendar day. */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Running totals seen so far in one log, for turning them into steps. */
export interface RunningTotals { cost: number; tokens: number }

interface FileCursor {
  offset: number;
  totals: RunningTotals;
  /** Bytes after the last newline, carried into the next read. */
  tail: string;
  days: Map<string, DayUsage>;
}

const cursors = new Map<string, FileCursor>();

/** Fold one JSONL line into `days`. Exported for tests. */
export function foldLine(line: string, days: Map<string, DayUsage>, totals: RunningTotals = { cost: 0, tokens: 0 }): void {
  // Cheap prefilter: the vast majority of lines are tool calls and assistant
  // text that carry neither a cost nor a user turn.
  const isUser = line.includes('"role":"user"');
  if (!isUser && !line.includes('"costUsd"') && !line.includes('"usage"')) return;
  let msg: { role?: string; timestamp?: number; costUsd?: number; usage?: { input_tokens?: number; output_tokens?: number }; isMeta?: boolean };
  try { msg = JSON.parse(line); } catch { return; }
  if (typeof msg.timestamp !== 'number') return;
  const key = dayKey(msg.timestamp);
  let d = days.get(key);
  if (!d) { d = { costUsd: 0, tokens: 0, userMessages: 0 }; days.set(key, d); }
  if (msg.role === 'user' && !msg.isMeta) d.userMessages += 1;
  if (typeof msg.costUsd === 'number' && Number.isFinite(msg.costUsd)) {
    d.costUsd += msg.costUsd >= totals.cost ? msg.costUsd - totals.cost : msg.costUsd;
    totals.cost = msg.costUsd;
  }
  const u = msg.usage;
  if (u) {
    // Fresh input + output; cache reads would dwarf both and aren't "work".
    const t = (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
    d.tokens += t >= totals.tokens ? t - totals.tokens : t;
    totals.tokens = t;
  }
}

/** Daily usage for one log file, reading only what was appended since the
 *  previous call. Missing file → empty. */
export function usageForFile(file: string): Map<string, DayUsage> {
  let size: number;
  try { size = statSync(file).size; } catch { cursors.delete(file); return new Map(); }
  let cur = cursors.get(file);
  if (!cur || size < cur.offset) {
    cur = { offset: 0, totals: { cost: 0, tokens: 0 }, tail: '', days: new Map() };
    cursors.set(file, cur);
  }
  if (size === cur.offset) return cur.days;

  const fd = openSync(file, 'r');
  try {
    const CHUNK = 4 * 1024 * 1024;
    const buf = Buffer.allocUnsafe(CHUNK);
    let pos = cur.offset;
    while (pos < size) {
      const n = readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos);
      if (n <= 0) break;
      pos += n;
      const text = cur.tail + buf.toString('utf8', 0, n);
      const lines = text.split('\n');
      cur.tail = lines.pop() ?? '';
      for (const line of lines) if (line) foldLine(line, cur.days, cur.totals);
    }
    cur.offset = pos;
  } finally {
    closeSync(fd);
  }
  return cur.days;
}

/** Test hook. */
export function resetUsageCache(): void {
  cursors.clear();
}
