import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { inArray } from 'drizzle-orm';
import { database, sqliteHandle } from '../database';
import { agentMessages } from '../database/schema';
import { AGENT_MESSAGE_RETENTION_MS, pruneAgentFiles, pruneAgentMessages, startMessageRetention, stopMessageRetention } from './retention';
import { agentDataDir } from './store';

const DAY = 86_400_000;

function insert(createdAt: number): string {
  const id = randomUUID();
  database.insert(agentMessages).values({
    id, direction: 'in', channelId: 'retention-test', channelType: 'telegram', peer: 'p',
    trusted: false, kind: 'text', text: 'x', media: '[]', status: 'received', attempts: 0,
    createdAt, updatedAt: createdAt,
  }).run();
  return id;
}

const surviving = (ids: string[]) =>
  database.select({ id: agentMessages.id }).from(agentMessages).where(inArray(agentMessages.id, ids)).all().map(r => r.id).sort();

describe('agent message retention', () => {
  test('drops rows older than 90 days and keeps the rest', () => {
    const now = Date.now();
    const old = insert(now - 91 * DAY);
    const edge = insert(now - AGENT_MESSAGE_RETENTION_MS + 60_000);
    const recent = insert(now - DAY);
    expect(pruneAgentMessages(now)).toBeGreaterThanOrEqual(1);
    expect(surviving([old, edge, recent])).toEqual([edge, recent].sort());
    // Nothing left to do on a second pass.
    expect(pruneAgentMessages(now)).toBe(0);
  });

  test('the delete walks the created_at index', () => {
    // prepare + finalize, not query(): Bun leaves a cached EXPLAIN statement
    // "in progress", which breaks every later transaction on the shared handle.
    const stmt = sqliteHandle.prepare('EXPLAIN QUERY PLAN DELETE FROM agent_messages WHERE created_at < ?');
    let plan: { detail: string }[];
    try { plan = stmt.all(0) as { detail: string }[]; } finally { stmt.finalize(); }
    expect(plan.map(p => p.detail).join(' ')).toMatch(/agent_messages_created_idx/);
  });

  test('runs on agent start and keeps a timer that does not hold the process', () => {
    const old = insert(Date.now() - 200 * DAY);
    startMessageRetention();
    try {
      expect(surviving([old])).toEqual([]);
      startMessageRetention(); // idempotent
    } finally {
      stopMessageRetention();
    }
  });
});

describe('attachment folder retention', () => {
  let root: string;
  let outside: string;
  const NOW = Date.parse('2026-11-12T10:00:00Z');
  const day = (iso: string) => join(root, iso);
  const put = (dir: string) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'a.bin'), 'x'); };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'codiby-files-'));
    outside = mkdtempSync(join(tmpdir(), 'codiby-outside-'));
    writeFileSync(join(outside, 'precious.txt'), 'keep');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  test('removes day folders older than 90 days and keeps the rest', () => {
    put(day('2026-01-02'));
    put(day('2026-08-13')); // 91 days back: its whole day is past the cutoff
    put(day('2026-08-14')); // part of it is still within 90 days
    put(day('2026-11-12'));
    expect(pruneAgentFiles(NOW, AGENT_MESSAGE_RETENTION_MS, root)).toBe(2);
    expect(existsSync(day('2026-01-02'))).toBe(false);
    expect(existsSync(day('2026-08-13'))).toBe(false);
    expect(existsSync(day('2026-08-14'))).toBe(true);
    expect(existsSync(day('2026-11-12'))).toBe(true);
    expect(pruneAgentFiles(NOW, AGENT_MESSAGE_RETENTION_MS, root)).toBe(0);
  });

  test('touches nothing but real YYYY-MM-DD folders', () => {
    put(join(root, 'notes'));
    put(join(root, '2020-01-01-backup'));
    put(join(root, '2020-02-31')); // not a date
    writeFileSync(join(root, '2020-03-03'), 'a file, not a folder');
    // A symlink named like an old day points at someone else's folder.
    symlinkSync(outside, join(root, '2020-04-04'));
    // A link inside an old day folder: the folder goes, the target stays.
    put(day('2020-05-05'));
    symlinkSync(outside, join(day('2020-05-05'), 'link'));

    expect(pruneAgentFiles(NOW, AGENT_MESSAGE_RETENTION_MS, root)).toBe(1);
    expect(existsSync(day('2020-05-05'))).toBe(false);
    for (const kept of ['notes', '2020-01-01-backup', '2020-02-31', '2020-03-03', '2020-04-04']) expect(existsSync(join(root, kept))).toBe(true);
    expect(existsSync(join(outside, 'precious.txt'))).toBe(true);
  });

  test('a missing files folder is not an error', () => {
    expect(pruneAgentFiles(NOW, AGENT_MESSAGE_RETENTION_MS, join(root, 'nope'))).toBe(0);
  });

  test('by default it prunes ~/.codiby/agent/files, and the agent start runs it', () => {
    const old = agentDataDir('files', '2019-06-01');
    put(old);
    // Today's folder may hold other suites' attachments: only this file is ours.
    const fresh = agentDataDir('files', new Date().toISOString().slice(0, 10), `retention-${randomUUID()}.bin`);
    mkdirSync(join(fresh, '..'), { recursive: true });
    writeFileSync(fresh, 'x');
    startMessageRetention();
    try {
      expect(existsSync(old)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
    } finally {
      stopMessageRetention();
      rmSync(fresh, { force: true });
    }
  });
});
