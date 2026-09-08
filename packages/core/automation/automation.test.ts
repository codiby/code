import { describe, expect, test } from 'bun:test';
import * as repository from './repository';
import * as scheduler from './scheduler';
import { promptWithPayload } from './runner';
import { automationPatchSchema } from './types';

// The sandbox database these run against comes from scripts/test-preload.ts:
// setting CODIBY_DATABASE_FILE here instead would lose the race to any suite
// that imports ../database first, and write these fixtures into the real one.

describe('automation persistence', () => {
  test('creates, updates, lists, and soft-deletes an automation', () => {
    const automation = repository.createAutomation({
      name: 'Daily review',
      description: null,
      triggerType: 'cron',
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

describe('patch validation', () => {
  test('leaves out every field the caller did not send', () => {
    // Zod applies `.default()` even through `.partial()`, so a patch schema
    // built from the defaulted create schema silently rewrites untouched
    // fields — renaming an automation used to downgrade its permissionMode to
    // 'default' and its timezone to 'UTC'.
    const patch = automationPatchSchema.parse({ name: 'Renamed' });

    expect(patch).toEqual({ name: 'Renamed' });
    expect(Object.keys(patch)).toEqual(['name']);
  });

  test('still rejects an empty patch', () => {
    expect(() => automationPatchSchema.parse({})).toThrow();
  });
});

describe('webhook automations', () => {
  test('are stored without a cron and never get scheduled', () => {
    const automation = repository.createAutomation({
      name: 'On watcher event',
      description: null,
      triggerType: 'webhook',
      cronExpression: null,
      timezone: 'UTC',
      enabled: true,
      prompt: 'React to the event',
      cwd: '/tmp/project',
      provider: 'claude',
      model: null,
      permissionMode: 'default',
      effort: null,
      concurrencyPolicy: 'skip',
      maxRuntimeMs: null,
    }, null);

    expect(automation.triggerType).toBe('webhook');
    expect(automation.cronExpression).toBeNull();

    // Enabled, but with nothing to fire it on a timer: the scheduler must leave
    // `nextRunAt` empty instead of trying to parse a missing expression.
    scheduler.scheduleAutomation(automation);
    expect(repository.getAutomation(automation.id)?.nextRunAt).toBeNull();

    repository.deleteAutomation(automation.id);
  });

  test('hand the POSTed body to the prompt, and leave the prompt alone without one', () => {
    const event = JSON.stringify({ type: 'item.column_changed', to: 'code_review' });

    expect(promptWithPayload('Review it', event))
      .toBe(`Review it\n\n<webhook-payload>\n${event}\n</webhook-payload>`);
    // No body, or a body of nothing but whitespace: the prompt is sent as-is
    // rather than with an empty block the agent would have to interpret.
    expect(promptWithPayload('Review it', null)).toBe('Review it');
    expect(promptWithPayload('Review it', '   \n ')).toBe('Review it');
  });

  test('cut an oversized body instead of flooding the first turn', () => {
    const result = promptWithPayload('Review it', 'x'.repeat(40_000));

    expect(result).toContain('truncated at 32000 chars');
    expect(result.length).toBeLessThan(33_000);
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
