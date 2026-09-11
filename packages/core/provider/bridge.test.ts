import { describe, expect, test } from 'bun:test';
import { findPendingDecision, requestPermissionDecision, resolvePermissionDecision } from './bridge';
import type { BridgeDeps } from './bridge';
import type { Session } from '../types';

const deps: BridgeDeps = {
  broadcastToSession: () => {},
  sendBrowserRequest: () => {},
  broadcastSessionList: () => {},
  notifyTelegramIfMainSession: () => {},
};

function session(id: string): Session {
  return { id, name: id, cwd: '/tmp', provider: 'claude' } as Session;
}

describe('findPendingDecision', () => {
  test('hands a retry the decision the user is already looking at', async () => {
    const s = session('plan-retry');
    const first = requestPermissionDecision(s, deps, {
      requestId: 'req-1',
      toolName: 'ExitPlanMode',
      input: { plan: '# Plan' },
    });

    // The provider's MCP call timed out and the agent called ExitPlanMode
    // again — it must attach to `req-1`, not raise a second prompt.
    const retry = findPendingDecision(s.id, 'ExitPlanMode');
    expect(retry).not.toBeNull();

    resolvePermissionDecision('req-1', { allow: true });
    expect((await first).allow).toBe(true);
    expect((await retry!).allow).toBe(true);
  });

  test('is scoped to one session and one tool', () => {
    const s = session('scoping');
    requestPermissionDecision(s, deps, {
      requestId: 'req-2',
      toolName: 'ExitPlanMode',
      input: { plan: '# Plan' },
    });

    expect(findPendingDecision('other-session', 'ExitPlanMode')).toBeNull();
    expect(findPendingDecision(s.id, 'AskUserQuestion')).toBeNull();

    resolvePermissionDecision('req-2', { allow: false });
  });

  test('goes quiet once the pending decision is resolved', async () => {
    const s = session('resolved');
    const pending = requestPermissionDecision(s, deps, {
      requestId: 'req-3',
      toolName: 'ExitPlanMode',
      input: { plan: '# Plan' },
    });

    resolvePermissionDecision('req-3', { allow: false, message: 'nope' });
    await pending;

    expect(findPendingDecision(s.id, 'ExitPlanMode')).toBeNull();
  });
});

import { createBridgeEvents } from './bridge';
import { getSessionState, getStateForClient, updateSessionState } from '../session/state';

test('provider failures reach the transcript and clear the busy indicator', () => {
  const s = { ...session('codex-error'), provider: 'codex', providerSessionGen: 1 };
  const broadcasts: any[] = [];
  updateSessionState(s.id, state => ({ ...state, isStreaming: true }));
  createBridgeEvents(s, { ...deps, broadcastToSession: (_, msg) => broadcasts.push(msg) }).onError(new Error('Login required'));
  expect(getSessionState(s.id).isStreaming).toBe(false);
  expect(broadcasts.some(msg => msg.type === 'message' && msg.message.content.includes('Login required'))).toBe(true);
});

test('compaction is included in reconnect snapshots and cleared after failure', () => {
  const s = { ...session('compaction-state'), provider: 'codex', providerSessionGen: 1 };
  const broadcasts: any[] = [];
  const events = createBridgeEvents(s, { ...deps, broadcastToSession: (_id, msg) => broadcasts.push(msg) });
  events.onCompaction!(true);
  expect(getSessionState(s.id).isCompacting).toBe(true);
  expect(getSessionState(s.id).isStreaming).toBe(true);
  expect(getStateForClient(s.id).isCompacting).toBe(true);
  expect(broadcasts.at(-1)).toMatchObject({ type: 'compaction', active: true });
  events.onCompaction!(false);
  expect(getSessionState(s.id).isStreaming).toBe(true);
  events.onCompaction!(true);
  events.onError(new Error('Runtime failed'));
  expect(getSessionState(s.id).isCompacting).toBe(false);
  expect(getSessionState(s.id).isStreaming).toBe(false);
  expect(getStateForClient(s.id).isCompacting).toBe(false);
  events.onCompaction!(true);
  expect(getSessionState(s.id).isCompacting).toBe(false);
  updateSessionState(s.id, state => ({ ...state, wasInterrupted: false }));
  s.providerSessionGen++;
  events.onCompaction!(true);
  expect(getSessionState(s.id).isCompacting).toBe(false);
});
