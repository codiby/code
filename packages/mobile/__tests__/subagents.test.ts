import {
  belongsToTask,
  countTasks,
  formatElapsed,
  formatTokens,
  groupTasks,
  mergeTranscript,
  parseTask,
  parseTasks,
  returnedSummary,
  taskElapsedMs,
  taskLine,
  taskSections,
  taskTotals,
  toolCounts,
  type SubagentMessage,
  type SubagentTask,
} from '../src/lib/subagents';
import { createTaskFeed, parseTaskMessage } from '../src/api/subagents';

const base: SubagentTask = {
  taskId: 't',
  toolUseId: null,
  taskType: 'local_agent',
  description: '',
  subagentType: 'Explore',
  workflowName: null,
  prompt: null,
  status: 'running',
  backgrounded: false,
  spawnDepth: 1,
  startedAt: 0,
  endedAt: null,
  totalTokens: 0,
  toolUses: 0,
  durationMs: 0,
  lastToolName: null,
  progress: null,
  summary: null,
  error: null,
};
const task = (patch: Partial<SubagentTask>): SubagentTask => ({
  ...base,
  ...patch,
});

const message = (patch: Partial<SubagentMessage>): SubagentMessage => ({
  id: 'm',
  role: 'assistant',
  content: '',
  timestamp: 0,
  seq: 0,
  toolName: null,
  toolInput: null,
  images: [],
  isThinking: false,
  thinkingRedacted: false,
  agentId: null,
  parentToolUseId: null,
  ...patch,
});

describe('parseTask', () => {
  test('fills what a bridge left out and rejects a task without id', () => {
    expect(parseTask({ taskId: 'a1', status: 'running' })).toEqual({
      ...base,
      taskId: 'a1',
      subagentType: null,
    });
    expect(parseTask({ description: 'no id' })).toBeNull();
    expect(parseTask('a1')).toBeNull();
  });

  test('an unknown status reads as finished, never as running', () => {
    expect(parseTask({ taskId: 'a1', status: 'teleported' })?.status).toBe(
      'stopped',
    );
    expect(parseTask({ taskId: 'a1' })?.status).toBe('stopped');
    expect(parseTask({ taskId: 'a1', status: 'failed' })?.status).toBe(
      'failed',
    );
  });

  test('parseTasks keys by task id and skips junk', () => {
    const tasks = parseTasks({
      x: { taskId: 'a1', description: 'One', totalTokens: 12 },
      y: null,
      z: { taskId: 'a2', totalTokens: 'lots' },
    });
    expect(Object.keys(tasks)).toEqual(['a1', 'a2']);
    expect(tasks.a1!.description).toBe('One');
    expect(tasks.a2!.totalTokens).toBe(0);
    expect(parseTasks(undefined)).toEqual({});
  });
});

describe('groupTasks', () => {
  test('running first and newest first; shells stay out', () => {
    const { running, done } = groupTasks([
      task({ taskId: 'old', status: 'completed', startedAt: 1, endedAt: 50 }),
      task({ taskId: 'older', status: 'failed', startedAt: 1, endedAt: 20 }),
      task({ taskId: 'live1', startedAt: 10 }),
      task({ taskId: 'live2', startedAt: 30 }),
      task({ taskId: 'shell', taskType: 'local_bash', subagentType: null }),
    ]);
    expect(running.map(group => group.tasks.map(t => t.taskId))).toEqual([
      ['live2', 'live1'],
    ]);
    expect(done.map(t => t.taskId)).toEqual(['old', 'older']);
  });

  test("a workflow's agents are listed under it while any of them runs", () => {
    const all = [
      task({
        taskId: 'wf',
        taskType: 'local_workflow',
        subagentType: null,
        toolUseId: 'tu',
        workflowName: 'review',
      }),
      task({ taskId: 'a', toolUseId: 'tu', startedAt: 1 }),
      task({
        taskId: 'b',
        toolUseId: 'tu',
        startedAt: 2,
        status: 'completed',
        endedAt: 5,
      }),
    ];
    const { running, done } = groupTasks(all);
    expect(running).toHaveLength(1);
    expect(running[0]!.workflow?.taskId).toBe('wf');
    expect(running[0]!.tasks.map(t => t.taskId)).toEqual(['a']);
    expect(done.map(t => t.taskId)).toEqual(['b']);
    expect(countTasks(all)).toEqual({ running: 1, done: 1 });

    const sections = taskSections(all, 'all');
    expect(sections.map(s => [s.label, s.detail, s.tasks.length])).toEqual([
      ['Workflow', 'review', 1],
      ['Completed', null, 1],
    ]);
    expect(taskSections(all, 'running').map(s => s.key)).toEqual(['wf']);
    expect(taskSections(all, 'done').map(s => s.key)).toEqual(['done']);
  });
});

describe('formatting', () => {
  test('elapsed and tokens read like the desktop drawer', () => {
    expect(formatElapsed(65_000)).toBe('1m 05s');
    expect(formatElapsed(3_725_000)).toBe('1h 02m');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(12_345)).toBe('12.3k');
    expect(formatTokens(250_000)).toBe('250k');
    expect(formatTokens(2_500_000)).toBe('2.5M');
  });

  test('a running task counts up from its start; a finished one keeps its duration', () => {
    expect(taskElapsedMs(task({ startedAt: 1000 }), 61_000)).toBe(60_000);
    expect(
      taskElapsedMs(
        task({
          status: 'completed',
          durationMs: 4000,
          startedAt: 0,
          endedAt: 9000,
        }),
        99_999,
      ),
    ).toBe(4000);
    expect(
      taskElapsedMs(
        task({ status: 'completed', startedAt: 1000, endedAt: 9000 }),
        99_999,
      ),
    ).toBe(8000);
  });

  test('the row line follows the live step, then the result', () => {
    expect(taskLine(task({}))).toBe('Starting…');
    expect(
      taskLine(
        task({
          lastToolName: 'mcp__codiby__browser_open',
          progress: 'Opening the page',
        }),
      ),
    ).toBe('browser open · Opening the page');
    expect(taskLine(task({ status: 'completed', totalTokens: 1500 }))).toBe(
      'Explore · 1.5k tokens',
    );
    expect(taskLine(task({ status: 'failed', error: 'Out of budget' }))).toBe(
      'Out of budget',
    );
  });

  test('totals add tokens and tools, and take the longest agent', () => {
    const totals = taskTotals(
      [
        task({
          status: 'completed',
          totalTokens: 100,
          toolUses: 2,
          durationMs: 5000,
        }),
        task({
          status: 'completed',
          totalTokens: 50,
          toolUses: 1,
          durationMs: 9000,
        }),
      ],
      0,
    );
    expect(totals).toEqual({ tokens: 150, tools: 3, longest: 9000 });
  });
});

describe('transcript', () => {
  test('a message is the task’s by agent id, or by its Agent call when unstamped', () => {
    const t = { taskId: 'a1', toolUseId: 'tu1' };
    expect(belongsToTask({ agentId: 'a1', parentToolUseId: null }, t)).toBe(
      true,
    );
    expect(belongsToTask({ agentId: null, parentToolUseId: 'tu1' }, t)).toBe(
      true,
    );
    expect(belongsToTask({ agentId: 'a2', parentToolUseId: 'tu1' }, t)).toBe(
      false,
    );
    expect(
      belongsToTask(
        { agentId: null, parentToolUseId: null },
        { taskId: 'a1', toolUseId: null },
      ),
    ).toBe(false);
  });

  test('merge keeps the fetched copy and orders by seq', () => {
    const merged = mergeTranscript(
      [
        message({ id: 'b', seq: 2, content: 'fetched' }),
        message({ id: 'a', seq: 1 }),
      ],
      [
        message({ id: 'b', seq: 2, content: 'streamed' }),
        message({ id: 'c', seq: 3 }),
      ],
    );
    expect(merged.map(m => m.id)).toEqual(['a', 'b', 'c']);
    expect(merged[1]!.content).toBe('fetched');
  });

  test('the returned summary is a label when it repeats the last answer, a card otherwise', () => {
    const transcript = [
      message({ id: '1', content: 'Looking…' }),
      message({ id: '2', toolName: 'Read' }),
      message({ id: '3', content: '  The plan is ready.  ' }),
      message({ id: '4', isThinking: true, content: 'hmm' }),
    ];
    const done = task({ status: 'completed', summary: 'The plan is ready.' });
    expect(returnedSummary(done, transcript)).toEqual({ kind: 'marker' });
    expect(
      returnedSummary({ ...done, summary: 'Something else' }, transcript),
    ).toEqual({
      kind: 'card',
      text: 'Something else',
    });
    expect(returnedSummary(task({ summary: 'early' }), transcript)).toEqual({
      kind: 'none',
    });
    expect(returnedSummary({ ...done, summary: null }, transcript)).toEqual({
      kind: 'none',
    });
  });

  test('tool counts, most used first', () => {
    expect(
      toolCounts([
        message({ id: '1', toolName: 'Read' }),
        message({ id: '2', toolName: 'Bash' }),
        message({ id: '3', toolName: 'Read' }),
        message({ id: '4' }),
      ]),
    ).toEqual([
      ['Read', 2],
      ['Bash', 1],
    ]);
  });

  test('parseTaskMessage keeps the agent ids and sorts a frame without seq last', () => {
    const parsed = parseTaskMessage({
      id: 'x',
      role: 'assistant',
      content: 'hi',
      agentId: 'a1',
      parentToolUseId: 'tu1',
    });
    expect(parsed).toMatchObject({
      id: 'x',
      agentId: 'a1',
      parentToolUseId: 'tu1',
    });
    expect(parsed!.seq).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseTaskMessage({ id: 'y', seq: 4 })).toMatchObject({
      seq: 4,
      agentId: null,
    });
    expect(parseTaskMessage({ seq: 4 })).toBeNull();
  });
});

test('the task feed replaces on a snapshot, merges updates and tells its readers', () => {
  const feed = createTaskFeed();
  const listener = jest.fn();
  const off = feed.subscribe(listener);
  feed.replace({ a: task({ taskId: 'a' }) });
  const before = feed.get();
  feed.upsert(task({ taskId: 'b' }));
  expect(Object.keys(feed.get())).toEqual(['a', 'b']);
  // A new object per change: `useSyncExternalStore` repaints on identity.
  expect(feed.get()).not.toBe(before);
  feed.replace({});
  expect(feed.get()).toEqual({});
  expect(listener).toHaveBeenCalledTimes(3);
  off();
  feed.upsert(task({ taskId: 'c' }));
  expect(listener).toHaveBeenCalledTimes(3);
});
