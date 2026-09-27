import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'crypto';
import { setBridgeDeps, startProviderSession } from './lifecycle';
import { registerProvider } from './registry';
import { addMessage, clearSessionState, getSessionState, getStateForClient, updateSessionState } from '../session/state';
import { deleteSessionData } from '../session/storage';
import type { ProviderEvents } from './types';
import type { Session } from '../types';

const sessionIds: string[] = [];
afterEach(() => {
  for (const id of sessionIds.splice(0)) {
    clearSessionState(id);
    deleteSessionData(id);
  }
});

test('effort respawn settles the old turn even when its exit arrives late', async () => {
  const events: ProviderEvents[] = [];
  const broadcasts: any[] = [];
  registerProvider({
    name: 'effort-restart-test',
    spawn(opts, callbacks) {
      events.push(callbacks);
      return {
        sessionId: opts.sessionId, provider: 'effort-restart-test',
        async close() {}, async interrupt() {}, async setModel() {},
        async setPermissionMode() {}, async sendUserMessage() {},
      };
    },
  });
  setBridgeDeps({
    broadcastToSession: (_id, msg) => broadcasts.push(msg),
    broadcastSessionList() {}, sendBrowserRequest() {}, notifyTelegramIfMainSession() {},
  });
  const session = {
    id: randomUUID(), cwd: '/tmp', provider: 'effort-restart-test',
    remoteId: 'test', providerSessionGen: 0, replayDone: true,
  } as Session;
  sessionIds.push(session.id);
  startProviderSession(session, 3111);
  expect(getSessionState(session.id).wasInterrupted).toBe(false);
  expect(broadcasts.some(msg => msg.status === 'interrupted')).toBe(false);
  addMessage(session.id, { id: 'running-tool', role: 'assistant', content: '', toolName: 'Bash', timestamp: Date.now() });
  events[0]!.onThinkingDelta('unfinished thinking');
  events[0]!.onAssistantDelta('unfinished response');
  events[0]!.onCompaction!(true);
  expect(getSessionState(session.id).isStreaming).toBe(true);

  // Same close/resume sequence as set_effort; close need not emit onExit.
  await session.providerSession!.setModel('new-model');
  session.effort = 'high';
  await session.providerSession!.close();
  session.providerSession = null;
  session.replayDone = false;
  startProviderSession(session, 3111, 'resume-token');
  events[0]!.onExit(0);

  expect(getStateForClient(session.id)).toMatchObject({
    isStreaming: false, isCompacting: false, partialText: '', partialThinking: '', wasInterrupted: true,
  });
  expect(getSessionState(session.id).messages).toEqual(expect.arrayContaining([
    expect.objectContaining({ content: 'unfinished thinking', isThinking: true }),
    expect.objectContaining({ content: 'unfinished response' }),
    expect.objectContaining({ toolUseId: 'running-tool', isToolResult: true, isError: true }),
  ]));
  expect(broadcasts).toContainEqual({ type: 'status', sessionId: session.id, status: 'interrupted' });
  expect(session.providerSession).not.toBeNull();
  expect(session.ready).toBe(true);

  // A new user turn can still stream, and the retired exit cannot stop it.
  session.replayDone = true;
  updateSessionState(session.id, state => ({ ...state, wasInterrupted: false }));
  events[1]!.onAssistantDelta('new response');
  events[0]!.onExit(0);
  expect(getSessionState(session.id).isStreaming).toBe(true);
});
