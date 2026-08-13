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
