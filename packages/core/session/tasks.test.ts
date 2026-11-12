import { describe, expect, test } from 'bun:test';
import { applyTaskEvent, pruneTasks, restoreStoredTasks, seedFromSnapshot } from './tasks';
import type { SubagentTask } from '../provider/types';

describe('applyTaskEvent', () => {
  test('folds the real SDK sequence into one record', () => {
    // Shapes captured from claude-agent-sdk 0.3.170 (an Explore sub-agent).
    let t = applyTaskEvent(undefined, { kind: 'started', taskId: 'a078', toolUseId: 'toolu_1', description: 'List probe files', subagentType: 'Explore', taskType: 'local_agent', prompt: 'List the files', backgrounded: true, spawnDepth: 1 }, 1000);
    expect(t.status).toBe('running');
    expect(t.startedAt).toBe(1000);
    t = applyTaskEvent(t, { kind: 'progress', taskId: 'a078', description: 'Running List directory', totalTokens: 8840, toolUses: 1, durationMs: 2005, lastToolName: 'Bash' }, 3000);
    expect(t.progress).toBe('Running List directory');
    expect(t.lastToolName).toBe('Bash');
    t = applyTaskEvent(t, { kind: 'updated', taskId: 'a078', status: 'completed', endTime: 6247 }, 6300);
    t = applyTaskEvent(t, { kind: 'notification', taskId: 'a078', status: 'completed', summary: 'a.txt: hello', totalTokens: 10237, toolUses: 1, durationMs: 5247 }, 6400);
    expect(t).toMatchObject({ status: 'completed', endedAt: 6247, summary: 'a.txt: hello', totalTokens: 10237, durationMs: 5247, description: 'List probe files' });
  });

  test('progress summaries win over the generic description and numbers never go backwards', () => {
    let t = applyTaskEvent(undefined, { kind: 'progress', taskId: 'x', totalTokens: 500, toolUses: 4, summary: 'Analyzing the auth module' });
    t = applyTaskEvent(t, { kind: 'progress', taskId: 'x', totalTokens: 300, toolUses: 2, description: 'Running Grep' });
    expect(t.totalTokens).toBe(500);
    expect(t.toolUses).toBe(4);
    expect(t.progress).toBe('Running Grep');
    t = applyTaskEvent(t, { kind: 'progress', taskId: 'x', summary: 'Writing the report' });
    expect(t.progress).toBe('Writing the report');
  });

  test('a replayed start does not revive a finished task', () => {
    let t = applyTaskEvent(undefined, { kind: 'notification', taskId: 'y', status: 'stopped' }, 10);
    expect(t.endedAt).toBe(10);
    t = applyTaskEvent(t, { kind: 'started', taskId: 'y', description: 'again' }, 20);
    expect(t.status).toBe('stopped');
  });
});

describe('snapshot + prune', () => {
  test('snapshot only seeds unknown tasks', () => {
    const known = { a: applyTaskEvent(undefined, { kind: 'started', taskId: 'a' }) };
    const added = seedFromSnapshot(known, { kind: 'snapshot', tasks: [{ taskId: 'a' }, { taskId: 'b', subagentType: 'Explore', description: 'B' }] });
    expect(added.map(t => t.taskId)).toEqual(['b']);
    expect(added[0]!.backgrounded).toBe(true);
  });

  test('prune drops the oldest finished tasks first', () => {
    const tasks: Record<string, SubagentTask> = {};
    for (let i = 0; i < 5; i++) {
      tasks[`f${i}`] = applyTaskEvent(undefined, { kind: 'notification', taskId: `f${i}`, status: 'completed' }, i);
    }
    tasks.live = applyTaskEvent(undefined, { kind: 'started', taskId: 'live' }, 0);
    const kept = pruneTasks(tasks, 3);
    expect(Object.keys(kept).sort()).toEqual(['f3', 'f4', 'live']);
  });
});

describe('restoreStoredTasks', () => {
  test('records come back as they were, running ones stopped at the last save', () => {
    const done = applyTaskEvent(undefined, { kind: 'notification', taskId: 'd1', status: 'completed', summary: 'ok' }, 50);
    const live = applyTaskEvent(undefined, { kind: 'started', taskId: 'w1', toolUseId: 'toolu_W', taskType: 'local_workflow', workflowName: 'review' }, 100);
    const { tasks, settled } = restoreStoredTasks(JSON.parse(JSON.stringify({ d1: done, w1: live })), 900, 5000);
    expect(settled).toBe(1);
    expect(tasks.d1).toEqual(done);
    expect(tasks.w1).toEqual({ ...live, status: 'stopped', endedAt: 900 });
  });

  test('anything malformed is dropped or reset, never trusted as is', () => {
    const { tasks } = restoreStoredTasks({
      good: { taskId: 'good', status: 'failed', totalTokens: 12, endedAt: 7 },
      mismatched: { taskId: 'other', status: 'completed' },
      noId: { status: 'completed' },
      weird: { taskId: 'weird', status: 'exploded', totalTokens: -4, toolUses: 'many', description: 42, spawnDepth: 0 },
      junk: 'x',
    }, null, 1000);
    expect(Object.keys(tasks).sort()).toEqual(['good', 'weird']);
    expect(tasks.good).toMatchObject({ status: 'failed', totalTokens: 12, endedAt: 7, taskType: 'local_agent', description: '' });
    expect(tasks.weird).toMatchObject({ status: 'stopped', totalTokens: 0, toolUses: 0, description: '', spawnDepth: 1, startedAt: 1000 });
    expect(restoreStoredTasks(null, null).tasks).toEqual({});
    expect(restoreStoredTasks([1, 2], null).tasks).toEqual({});
  });
});
