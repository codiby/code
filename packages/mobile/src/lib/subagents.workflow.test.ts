import {
  findWorkflowAgent,
  isAgentActing,
  mergeWorkflowMessages,
  parseWorkflowAgent,
  parseWorkflowAgents,
  sheetSections,
  taskElapsedMs,
  taskKindLabel,
  taskLine,
  workflowAgentTask,
  workflowProgress,
  type SubagentTask,
  type WorkflowAgent,
} from './subagents';

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
const workflow = task({
  taskId: 'wf',
  taskType: 'local_workflow',
  subagentType: null,
  toolUseId: 'tu',
  workflowName: 'phase3',
  startedAt: 100,
  lastToolName: 'fix:ui',
});
const agent = (patch: Partial<WorkflowAgent>): WorkflowAgent => ({
  agentId: 'a1',
  label: 'fix:ui',
  phase: 'Fix',
  status: 'running',
  startedAt: 1000,
  endedAt: null,
  toolUses: 4,
  outputTokens: 2500,
  lastToolName: 'mcp__codiby__Bash',
  lastText: 'Running the tests',
  summary: null,
  ...patch,
});

describe('workflow agents from the wire', () => {
  test('parses what the bridge sends and degrades the rest', () => {
    expect(
      parseWorkflowAgent({
        agentId: 'a1',
        label: 'x',
        status: 'completed',
        toolUses: 3,
      }),
    ).toMatchObject({
      agentId: 'a1',
      label: 'x',
      status: 'completed',
      toolUses: 3,
      outputTokens: 0,
      startedAt: null,
      phase: null,
    });
    // An unknown status reads as finished, a missing label as the id.
    expect(
      parseWorkflowAgent({ agentId: 'a2', status: 'zooming' }),
    ).toMatchObject({ status: 'stopped', label: 'a2' });
    expect(parseWorkflowAgent({ label: 'no id' })).toBeNull();
    expect(
      parseWorkflowAgents([{ agentId: 'a' }, null, 5]).map(a => a.agentId),
    ).toEqual(['a']);
    expect(parseWorkflowAgents('nope')).toEqual([]);
  });
});

describe('workflow agent rules', () => {
  test('progress counts agents that handed back a result', () => {
    expect(
      workflowProgress([
        agent({}),
        agent({ status: 'completed' }),
        agent({ status: 'stopped' }),
      ]),
    ).toEqual({
      done: 1,
      total: 3,
      percent: 33,
    });
    expect(workflowProgress([])).toEqual({ done: 0, total: 0, percent: 0 });
  });

  test('the acting agent is the one the last progress tick named', () => {
    expect(isAgentActing(agent({}), workflow)).toBe(true);
    expect(isAgentActing(agent({ label: 'fix:core' }), workflow)).toBe(false);
    expect(isAgentActing(agent({}), { ...workflow, status: 'completed' })).toBe(
      false,
    );
    expect(isAgentActing(agent({ status: 'completed' }), workflow)).toBe(false);
  });

  test('an agent reads as a workflow-agent task in the row and the chat', () => {
    const live = workflowAgentTask(agent({}), workflow, 'Fix the UI');
    expect(live).toMatchObject({
      taskId: 'wf/a1',
      description: 'fix:ui',
      workflowName: 'phase3',
      prompt: 'Fix the UI',
      totalTokens: 2500,
      progress: 'Running the tests',
    });
    expect(taskKindLabel(live)).toBe('workflow agent');
    expect(taskLine(live)).toBe('Bash · Running the tests');
    expect(taskElapsedMs(live, 4000)).toBe(3000);
    const done = workflowAgentTask(
      agent({ status: 'completed', endedAt: 6000, summary: 'ok' }),
      workflow,
    );
    expect(done).toMatchObject({
      durationMs: 5000,
      progress: null,
      summary: 'ok',
    });
    expect(taskLine(done)).toBe('workflow agent · 2.5k tokens');
  });

  test('findWorkflowAgent resolves a row key back to its workflow and agent', () => {
    const tasks = { wf: workflow };
    const inner = { wf: [agent({})] };
    expect(findWorkflowAgent('wf/a1', tasks, inner)?.agent.label).toBe(
      'fix:ui',
    );
    expect(findWorkflowAgent('wf/zz', tasks, inner)).toBeNull();
    expect(findWorkflowAgent('gone/a1', tasks, inner)).toBeNull();
    expect(findWorkflowAgent('wf', tasks, inner)).toBeNull();
  });

  test('polls append only what is new and keep the array otherwise', () => {
    const prev = [{ id: 'a' }, { id: 'b' }];
    expect(
      mergeWorkflowMessages(prev, [], { incremental: true, gap: false }),
    ).toBe(prev);
    expect(
      mergeWorkflowMessages(prev, [{ id: 'b' }], {
        incremental: true,
        gap: false,
      }),
    ).toBe(prev);
    expect(
      mergeWorkflowMessages(prev, [{ id: 'c' }], {
        incremental: true,
        gap: false,
      }).map(m => m.id),
    ).toEqual(['a', 'b', 'c']);
    expect(
      mergeWorkflowMessages(prev, [{ id: 'z' }], {
        incremental: true,
        gap: true,
      }),
    ).toEqual([{ id: 'z' }]);
    expect(
      mergeWorkflowMessages(prev, [{ id: 'z' }], {
        incremental: false,
        gap: false,
      }),
    ).toEqual([{ id: 'z' }]);
    expect(
      mergeWorkflowMessages(
        prev,
        [{ id: 'c' }],
        { incremental: true, gap: false },
        2,
      ).map(m => m.id),
    ).toEqual(['b', 'c']);
  });
});

describe('sheetSections', () => {
  const inner = {
    wf: [
      agent({ agentId: 'a1' }),
      agent({
        agentId: 'a2',
        label: 'fix:core',
        status: 'completed',
        endedAt: 5000,
      }),
    ],
  };

  test('a running workflow lists its agents under a meter instead of its own row', () => {
    const [section] = sheetSections([workflow], 'all', inner);
    expect(section).toMatchObject({
      key: 'wf',
      label: 'Workflow',
      detail: 'phase3',
    });
    expect(section!.progress).toEqual({ done: 1, total: 2, percent: 50 });
    expect(section!.rows.map(row => [row.kind, row.key])).toEqual([
      ['agent', 'wf/a1'],
      ['agent', 'wf/a2'],
    ]);
    expect(section!.rows[0]).toMatchObject({ acting: true });
    // "Running" keeps the meter and drops the agents already done.
    const [running] = sheetSections([workflow], 'running', inner);
    expect(running!.rows.map(row => row.key)).toEqual(['wf/a1']);
    expect(running!.progress?.total).toBe(2);
  });

  test('without its agents a workflow keeps its single row', () => {
    const [section] = sheetSections([workflow], 'all', {});
    expect(section!.progress).toBeNull();
    expect(section!.rows.map(row => [row.kind, row.key])).toEqual([
      ['task', 'wf'],
    ]);
  });

  test('a finished workflow heads its agents inside Completed with its final n/n', () => {
    const finished = {
      ...workflow,
      status: 'completed' as const,
      endedAt: 9000,
    };
    const loose = task({ taskId: 'x', status: 'completed', endedAt: 100 });
    const all = [finished, loose];
    const doneInner = {
      wf: inner.wf.map(a => ({ ...a, status: 'completed' as const })),
    };
    const sections = sheetSections(all, 'all', doneInner);
    expect(sections.map(s => s.key)).toEqual(['done']);
    expect(sections[0]!.rows.map(row => [row.kind, row.key])).toEqual([
      ['workflow', 'wf'],
      ['agent', 'wf/a1'],
      ['agent', 'wf/a2'],
      ['task', 'x'],
    ]);
    expect(sections[0]!.rows[0]).toMatchObject({
      progress: { done: 2, total: 2 },
    });
    expect(sections[0]!.rows[1]).toMatchObject({ acting: false });
  });
});
