import { describe, expect, test } from 'bun:test';
import {
  WORKFLOW_MESSAGES_CAP, isAgentActing, mergeWorkflowMessages, taskElapsedMs, taskKindLabel, visibleWorkflowAgents,
  windowTakesEscape, workflowAgentElapsedMs, workflowAgentTask, workflowProgress,
} from './subagents';
import type { ChatMessage, SubagentTask, WorkflowAgent } from './claude-client';

/** Just enough of a DOM element for the sibling walk. */
function el(classes: string, next: any = null): any {
  const set = new Set(classes.split(/\s+/).filter(Boolean));
  return { classList: { contains: (c: string) => set.has(c) }, nextElementSibling: next };
}

const esc = (extra: Record<string, unknown> = {}) => ({ key: 'Escape', isComposing: false, ctrlKey: false, metaKey: false, altKey: false, ...extra });

describe('Agents window Esc', () => {
  test('closes on a plain Esc when nothing sits on top of it', () => {
    expect(windowTakesEscape(esc(), el('fixed inset-0'))).toBe(true);
    expect(windowTakesEscape(esc(), el('fixed inset-0', el('toast-region')))).toBe(true);
    expect(windowTakesEscape(esc({ key: 'k' }), el('fixed inset-0'))).toBe(false);
  });

  test('leaves Esc to an image preview or tool window opened from inside it', () => {
    const root = el('fixed inset-0 z-[1000]', el('fixed inset-0 z-[10000] bg-black/95'));
    expect(windowTakesEscape(esc(), root)).toBe(false);
  });

  test('leaves Esc to IME composition and to held-modifier shortcuts (the session switcher)', () => {
    expect(windowTakesEscape(esc({ isComposing: true }), el('fixed inset-0'))).toBe(false);
    expect(windowTakesEscape(esc({ ctrlKey: true }), el('fixed inset-0'))).toBe(false);
    expect(windowTakesEscape(esc({ metaKey: true }), el('fixed inset-0'))).toBe(false);
  });
});

const workflow: SubagentTask = {
  taskId: 'wtask', toolUseId: 'toolu_wf', taskType: 'local_workflow', description: 'Build it', subagentType: null,
  workflowName: 'phase3', prompt: null, status: 'running', backgrounded: true, spawnDepth: 1, startedAt: 1000,
  endedAt: null, totalTokens: 0, toolUses: 0, durationMs: 0, lastToolName: 'fix:ui', progress: null, summary: null, error: null,
};
const agent = (patch: Partial<WorkflowAgent>): WorkflowAgent => ({
  agentId: 'a1', label: 'fix:ui', phase: 'Fix', status: 'running', startedAt: 2000, endedAt: null,
  toolUses: 3, outputTokens: 1200, lastToolName: 'Bash', lastText: 'Running tests', summary: null, ...patch,
});
const msg = (id: string, seq: number): ChatMessage => ({ id, role: 'assistant', content: id, timestamp: seq, seq });

describe('workflow agents', () => {
  test('progress counts the agents that handed back a result', () => {
    expect(workflowProgress([])).toEqual({ done: 0, total: 0, percent: 0 });
    expect(workflowProgress([agent({}), agent({ status: 'completed' }), agent({ status: 'stopped' })])).toEqual({ done: 1, total: 3, percent: 33 });
    expect(workflowProgress([agent({ status: 'completed' }), agent({ status: 'completed' })])).toMatchObject({ done: 2, total: 2, percent: 100 });
  });

  test('the acting agent is the one the last progress tick named, only while both run', () => {
    expect(isAgentActing(agent({}), workflow)).toBe(true);
    expect(isAgentActing(agent({ label: 'fix:core' }), workflow)).toBe(false);
    expect(isAgentActing(agent({ status: 'completed' }), workflow)).toBe(false);
    expect(isAgentActing(agent({}), { ...workflow, status: 'completed' })).toBe(false);
    expect(isAgentActing(agent({}), { ...workflow, lastToolName: null })).toBe(false);
  });

  test('elapsed runs until now while running, and stops at the last entry after', () => {
    expect(workflowAgentElapsedMs(agent({}), 5000)).toBe(3000);
    expect(workflowAgentElapsedMs(agent({ status: 'completed', endedAt: 4000 }), 9000)).toBe(2000);
    expect(workflowAgentElapsedMs(agent({ startedAt: null }), 9000)).toBe(0);
  });

  test('the Running filter hides inner agents that are done', () => {
    const list = [agent({ agentId: 'x' }), agent({ agentId: 'y', status: 'completed' })];
    expect(visibleWorkflowAgents(list, 'running').map(a => a.agentId)).toEqual(['x']);
    expect(visibleWorkflowAgents(list, 'all')).toBe(list);
  });

  test('an inner agent reads as a workflow agent task in the window', () => {
    const t = workflowAgentTask(agent({ status: 'completed', endedAt: 6000, summary: 'Done' }), workflow, 'Fix the UI');
    expect(t).toMatchObject({
      taskId: 'wtask/a1', description: 'fix:ui', workflowName: 'phase3', prompt: 'Fix the UI', status: 'completed',
      totalTokens: 1200, toolUses: 3, startedAt: 2000, endedAt: 6000, durationMs: 4000, summary: 'Done', progress: null,
    });
    expect(taskKindLabel(t)).toBe('workflow agent');
    expect(taskElapsedMs(t, 99_000)).toBe(4000);
    const live = workflowAgentTask(agent({}), { ...workflow, workflowName: null });
    expect(live).toMatchObject({ status: 'running', progress: null, workflowName: 'Build it', durationMs: 0 });
    expect(taskElapsedMs(live, 7000)).toBe(5000);
  });

  test('polls append what is new and keep the same array when nothing is', () => {
    const prev = [msg('a', 1), msg('b', 2)];
    expect(mergeWorkflowMessages(prev, { messages: [], gap: false }, true)).toBe(prev);
    expect(mergeWorkflowMessages(prev, { messages: [msg('b', 2)], gap: false }, true)).toBe(prev);
    expect(mergeWorkflowMessages(prev, { messages: [msg('c', 3)], gap: false }, true).map(m => m.id)).toEqual(['a', 'b', 'c']);
    // A whole read or a gap replaces.
    expect(mergeWorkflowMessages(prev, { messages: [msg('z', 9)], gap: true }, true).map(m => m.id)).toEqual(['z']);
    expect(mergeWorkflowMessages(prev, { messages: [msg('z', 9)], gap: false }, false).map(m => m.id)).toEqual(['z']);
    const full = Array.from({ length: WORKFLOW_MESSAGES_CAP }, (_, i) => msg(`m${i}`, i + 1));
    const capped = mergeWorkflowMessages(full, { messages: [msg('new', WORKFLOW_MESSAGES_CAP + 1)], gap: false }, true);
    expect(capped.length).toBe(WORKFLOW_MESSAGES_CAP);
    expect(capped.at(-1)!.id).toBe('new');
  });
});
