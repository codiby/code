import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const testDir = mkdtempSync(join(tmpdir(), 'codiby-automations-'));
process.env.CODIBY_DATABASE_FILE = join(testDir, 'database.sqlite');

let repository: typeof import('./repository');
let scheduler: typeof import('./scheduler');

beforeAll(async () => {
  repository = await import('./repository');
  scheduler = await import('./scheduler');
});

// `bun test` runs every file in one process against a single sqlite handle and
// a single database file, so closing or deleting them in afterAll would break
// whichever suite runs next. Cleanup waits for the process to exit.
process.on('exit', () => rmSync(testDir, { recursive: true, force: true }));

describe('automation persistence', () => {
  test('creates, updates, lists, and soft-deletes an automation', () => {
    const automation = repository.createAutomation({
      name: 'Daily review',
      description: null,
      cronExpression: '0 9 * * *',
      timezone: 'UTC',
      enabled: true,
      prompt: 'Review the project',
      cwd: '/tmp/project',
      provider: 'claude',
      model: null,
      permissionMode: 'default',
      effort: null,
      concurrencyPolicy: 'skip',
      maxRuntimeMs: null,
    }, 1_000);

    expect(repository.getAutomation(automation.id)?.name).toBe('Daily review');
    expect(repository.listAutomations()).toHaveLength(1);
    expect(repository.updateAutomation(automation.id, { name: 'Morning review' })?.name).toBe('Morning review');

    const run = repository.createRun(automation, 'manual', null)!;
    repository.startRun(run.id, 'session-1');
    repository.finishRunBySession('session-1', 'succeeded', {
      resultText: 'Review complete',
      costUsd: 0.02,
      usage: { input_tokens: 10, output_tokens: 20 },
    });
    expect(repository.getRun(automation.id, run.id)).toMatchObject({
      status: 'succeeded',
      resultText: 'Review complete',
      inputTokens: 10,
      outputTokens: 20,
    });

    expect(repository.deleteAutomation(automation.id)).toBe(true);
    expect(repository.getAutomation(automation.id)).toBeNull();
  });
});

describe('cron calculation', () => {
  test('calculates the next run in the requested IANA timezone', () => {
    const after = new Date('2026-07-21T12:00:00.000Z');
    const next = scheduler.nextRunFor('0 9 * * *', 'America/New_York', after);
    expect(next).toBe(Date.parse('2026-07-21T13:00:00.000Z'));
  });

  test('rejects invalid expressions and timezones', () => {
    expect(() => scheduler.nextRunFor('not a cron', 'UTC')).toThrow();
    expect(() => scheduler.nextRunFor('0 9 * * *', 'Mars/Olympus')).toThrow();
  });
});
