/**
 * Task records across a bridge restart: written next to the session's UI
 * state, read back on load with what was running settled as stopped, and a
 * workflow started before the restart still lists its agents.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CODIBY_DIR } from '../config/config';
import { createBridgeEvents } from '../provider/bridge';
import type { Session } from '../types';
import { addMessage, clearSessionState, flushTaskSaves, getSessionState, getStateForClient } from './state';
import { clearWorkflowCaches, listWorkflowAgents, resolveWorkflowDir } from './workflow-agents';

const tasksFile = (id: string) => join(CODIBY_DIR, 'ui-sessions', id, 'tasks.json');

function bridgeFor(id: string) {
  const sent: any[] = [];
  const session = { id, name: id, cwd: '/tmp', provider: 'claude', providerSessionGen: 0, replayDone: true } as unknown as Session;
  const events = createBridgeEvents(session, { broadcastToSession: (_s, m) => { sent.push(m); }, sendBrowserRequest() {}, broadcastSessionList() {} });
  return { events, sent };
}

/** What a restart does to a session's state: memory gone, disk kept. */
function restart(id: string) {
  flushTaskSaves();
  clearSessionState(id);
}

describe('task records survive a restart', () => {
  test('saved next to the UI state, restored on load, running ones stopped', () => {
    const id = `tp-${randomUUID().slice(0, 8)}`;
    addMessage(id, { id: randomUUID(), role: 'user', content: 'research this', timestamp: Date.now() });
    const { events } = bridgeFor(id);
    events.onTaskEvent!({ kind: 'started', taskId: 'r1', toolUseId: 'toolu_R', taskType: 'local_agent', description: 'Research' });
    events.onTaskEvent!({ kind: 'progress', taskId: 'r1', totalTokens: 900, toolUses: 3, lastToolName: 'Grep' });
    events.onTaskEvent!({ kind: 'started', taskId: 'd1', toolUseId: 'toolu_D', taskType: 'local_agent', description: 'Quick look' });
    events.onTaskEvent!({ kind: 'notification', taskId: 'd1', status: 'completed', summary: 'found it' });
    // Throttled, not written per event.
    expect(existsSync(tasksFile(id))).toBe(false);

    restart(id);
    const disk = JSON.parse(readFileSync(tasksFile(id), 'utf-8'));
    expect(Object.keys(disk.tasks).sort()).toEqual(['d1', 'r1']);
    expect(typeof disk.savedAt).toBe('number');

    const tasks = getSessionState(id).tasks!;
    expect(tasks.r1).toMatchObject({ status: 'stopped', totalTokens: 900, toolUses: 3, lastToolName: 'Grep', description: 'Research' });
    expect(tasks.r1!.endedAt).toBe(disk.savedAt);
    expect(tasks.d1).toMatchObject({ status: 'completed', summary: 'found it' });
    expect(getStateForClient(id).tasks.r1.status).toBe('stopped');

    // The settled copy is written back, so its end time holds across the next restart too.
    restart(id);
    expect(JSON.parse(readFileSync(tasksFile(id), 'utf-8')).tasks.r1.status).toBe('stopped');
    expect(getSessionState(id).tasks!.r1!.endedAt).toBe(disk.savedAt);
  });

  test('a session without a folder (purged) is not brought back by a late save', () => {
    const id = `tp-gone-${randomUUID().slice(0, 8)}`;
    const { events } = bridgeFor(id);
    events.onTaskEvent!({ kind: 'started', taskId: 'x', taskType: 'local_agent' });
    flushTaskSaves();
    expect(existsSync(join(CODIBY_DIR, 'ui-sessions', id))).toBe(false);
  });

  test('a corrupt tasks.json reads as no tasks', () => {
    const id = `tp-bad-${randomUUID().slice(0, 8)}`;
    addMessage(id, { id: randomUUID(), role: 'user', content: 'hi', timestamp: Date.now() });
    writeFileSync(tasksFile(id), '{"savedAt": 1, "tasks": ');
    clearSessionState(id);
    expect(getSessionState(id).tasks).toBeUndefined();
  });
});

describe('a workflow started before the restart', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'wf-restart-')));
  const root = join(base, 'projects');
  const runDir = join(root, '-Users-me-repo', 'sess-1', 'subagents', 'workflows', 'wf_re5t-art');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'journal.jsonl'), [
    JSON.stringify({ type: 'started', agentId: 'aa11', label: 'Explore', phase: 'scan' }),
    JSON.stringify({ type: 'result', agentId: 'aa11', result: { summary: 'Mapped the repo' } }),
    JSON.stringify({ type: 'started', agentId: 'bb22', label: 'Implement', phase: 'build' }),
  ].join('\n') + '\n');
  writeFileSync(join(runDir, 'agent-bb22.jsonl'), JSON.stringify({
    type: 'assistant', uuid: 'u1', timestamp: '2026-11-12T10:00:00Z',
    message: { id: 'm1', content: [{ type: 'text', text: 'Halfway there' }], usage: { output_tokens: 40 } },
  }) + '\n');

  afterAll(() => rmSync(base, { recursive: true, force: true }));
  beforeEach(() => clearWorkflowCaches());

  test('its record and transcript dir are found again, and its unfinished agents read as stopped', async () => {
    const id = `tp-wf-${randomUUID().slice(0, 8)}`;
    addMessage(id, { id: randomUUID(), role: 'user', content: 'run the workflow', timestamp: Date.now() });
    const { events } = bridgeFor(id);
    events.onToolUse({ type: 'tool_use', id: 'toolu_WF', name: 'Workflow', input: { name: 'build' } });
    events.onToolResult({
      toolUseId: 'toolu_WF',
      content: `Workflow launched in background. Task ID: wtask9\nTranscript dir: ${runDir}\nRun ID: wf_re5t-art\n`,
    });
    events.onTaskEvent!({ kind: 'started', taskId: 'wtask9', toolUseId: 'toolu_WF', taskType: 'local_workflow', workflowName: 'build', backgrounded: true });
    events.onTaskEvent!({ kind: 'progress', taskId: 'wtask9', lastToolName: 'bb22' });

    restart(id);
    clearWorkflowCaches();

    // What GET /sessions/:id/tasks/:taskId/agents does.
    const task = getSessionState(id).tasks?.wtask9;
    expect(task).toMatchObject({ status: 'stopped', taskType: 'local_workflow', toolUseId: 'toolu_WF', workflowName: 'build' });
    const dir = resolveWorkflowDir(id, task!, { messages: getSessionState(id).messages, root });
    expect(dir).toBe(runDir);
    const agents = await listWorkflowAgents(dir!, task!.status);
    expect(agents.map(a => [a.agentId, a.status])).toEqual([['aa11', 'completed'], ['bb22', 'stopped']]);
    expect(agents[1]!.lastText).toBe('Halfway there');
  });
});
