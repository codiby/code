import { describe, expect, test } from 'bun:test';
import { createBridgeEvents } from './bridge';
import type { BridgeDeps } from './bridge';
import { getSessionState, getStateForClient, getTaskMessages, addMessage } from '../session/state';
import type { Session } from '../types';

function setup(id: string) {
  const sent: any[] = [];
  const deps: BridgeDeps = {
    broadcastToSession: (_sid, msg) => { sent.push(msg); },
    sendBrowserRequest: () => {},
    broadcastSessionList: () => {},
  };
  const session = { id, name: id, cwd: '/tmp', provider: 'claude', providerSessionGen: 0, replayDone: true } as unknown as Session;
  return { events: createBridgeEvents(session, deps), sent };
}

describe('sub-agent tasks in the bridge', () => {
  test('task events become one live record, pushed as task_update', () => {
    const { events, sent } = setup('tasks-lifecycle');
    events.onTaskEvent!({ kind: 'started', taskId: 'a078', toolUseId: 'toolu_A', description: 'List probe files', subagentType: 'Explore', taskType: 'local_agent', prompt: 'List the files' });
    events.onTaskEvent!({ kind: 'progress', taskId: 'a078', totalTokens: 8840, toolUses: 1, durationMs: 2005, lastToolName: 'Bash', description: 'Running List directory' });
    events.onTaskEvent!({ kind: 'notification', taskId: 'a078', status: 'completed', summary: 'hello', totalTokens: 10237, toolUses: 1, durationMs: 5247 });
    const task = getSessionState('tasks-lifecycle').tasks!.a078!;
    expect(task).toMatchObject({ status: 'completed', summary: 'hello', subagentType: 'Explore', toolUseId: 'toolu_A' });
    expect(sent.filter(m => m.type === 'task_update')).toHaveLength(3);
    expect(getStateForClient('tasks-lifecycle').tasks.a078.status).toBe('completed');
  });

  test("a sub-agent's text goes out as subagent_message and stays out of the chat window", () => {
    const { events, sent } = setup('tasks-chatter');
    getSessionState('tasks-chatter').isStreaming = true;
    events.onAssistantText('Main thread says hi', {});
    events.onAssistantText('Sub-agent working notes', { parentToolUseId: 'toolu_A', agentId: 'a078' });
    events.onThinking({ type: 'thinking', text: 'Sub-agent thought', parentToolUseId: 'toolu_A', agentId: 'a078' });
    events.onToolUse({ type: 'tool_use', id: 'toolu_sub_1', name: 'Bash', input: { command: 'ls' }, parentToolUseId: 'toolu_A', agentId: 'a078' });

    expect(sent.filter(m => m.type === 'subagent_message').map(m => m.message.content)).toEqual(['Sub-agent working notes', 'Sub-agent thought']);
    // The chat window keeps the main text and the sub-agent's tool call, not its chatter.
    const windowed = getStateForClient('tasks-chatter').messages.map((m: any) => m.content);
    expect(windowed).toContain('Main thread says hi');
    expect(windowed).not.toContain('Sub-agent working notes');
    // The Agents window gets all of it.
    const forTask = getTaskMessages('tasks-chatter', 'a078', 'toolu_A').map(m => m.toolName || m.content);
    expect(forTask).toEqual(['Sub-agent working notes', 'Sub-agent thought', 'Bash']);
  });

  test('sub-agent text does not end the main turn indicator', () => {
    const { events } = setup('tasks-streaming');
    const state = getSessionState('tasks-streaming');
    state.isStreaming = true;
    state.partialText = 'main preview';
    events.onAssistantText('sub text', { agentId: 'zz' });
    expect(getSessionState('tasks-streaming').isStreaming).toBe(true);
    expect(getSessionState('tasks-streaming').partialText).toBe('main preview');
  });

  test("the main thread's pending text stays main when a background sub-agent's tool event lands first", () => {
    const { events, sent } = setup('tasks-main-flush');
    const state = getSessionState('tasks-main-flush');
    state.isStreaming = true;
    state.partialText = 'Started a researcher in the background; meanwhile here is the plan.';
    events.onToolUse({ type: 'tool_use', id: 'toolu_bg_1', name: 'Grep', input: { pattern: 'x' }, parentToolUseId: 'toolu_BG', agentId: 'bg1' });
    events.onToolResult({ toolUseId: 'toolu_bg_1', content: 'no matches', parentToolUseId: 'toolu_BG', agentId: 'bg1' });

    const main = sent.filter(m => m.type === 'message' && m.message.content.startsWith('Started a researcher'));
    // Committed once, as the main thread's own text — in the chat window, not the Agents window.
    expect(main).toHaveLength(1);
    expect(main[0].message.parentToolUseId).toBeNull();
    expect(main[0].message.agentId).toBeUndefined();
    expect(sent.some(m => m.type === 'subagent_message' && m.message.content.startsWith('Started a researcher'))).toBe(false);
    expect(getSessionState('tasks-main-flush').partialText).toBe('');
    expect(getStateForClient('tasks-main-flush').messages.map((m: any) => m.content)).toContain('Started a researcher in the background; meanwhile here is the plan.');
  });

  test('tasks still running when a new provider takes over are settled as stopped', () => {
    const id = 'tasks-stale';
    const first = setup(id);
    first.events.onTaskEvent!({ kind: 'started', taskId: 'old', toolUseId: 'toolu_O', taskType: 'local_agent', description: 'Long research' });
    first.events.onTaskEvent!({ kind: 'started', taskId: 'done', toolUseId: 'toolu_D', taskType: 'local_agent' });
    first.events.onTaskEvent!({ kind: 'notification', taskId: 'done', status: 'completed', summary: 'ok' });
    // The session restarts (or the thread rotates): the old process and its sub-agents are gone.
    const second = setup(id);
    const tasks = getSessionState(id).tasks!;
    expect(tasks.old!.status).toBe('stopped');
    expect(tasks.old!.endedAt).not.toBeNull();
    expect(tasks.done!.status).toBe('completed');
    expect(second.sent.filter(m => m.type === 'task_update').map(m => m.task.taskId)).toEqual(['old']);
  });

  test('a provider exit settles its running tasks', () => {
    const id = 'tasks-exit';
    const { events } = setup(id);
    events.onTaskEvent!({ kind: 'started', taskId: 'r1', taskType: 'local_agent' });
    events.onExit(1);
    expect(getSessionState(id).tasks!.r1!.status).toBe('stopped');
  });

  test('legacy messages without an agent id are matched by tool_use id', () => {
    addMessage('tasks-legacy', { id: 'l1', role: 'assistant', content: 'Using tool', timestamp: 1, toolName: 'Read', parentToolUseId: 'toolu_L' });
    expect(getTaskMessages('tasks-legacy', 'unknown-id', 'toolu_L').map(m => m.id)).toEqual(['l1']);
  });
});
