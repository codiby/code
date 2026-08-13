import { describe, expect, test } from 'bun:test';
import { canRenameOwnedSession, keepAlive, matchesMcpSessionOwner, owningUiSessionId } from './mcp';

describe('keepAlive', () => {
  test('keeps the connection busy while a tool waits on the user', async () => {
    const sent: any[] = [];
    let approve!: (v: string) => void;
    const waitingOnUser = new Promise<string>((res) => { approve = res; });

    const call = keepAlive('tok-1', async (n: any) => { sent.push(n); }, () => waitingOnUser, 10);
    await Bun.sleep(55);
    // Bun would have reaped an idle socket by now; these say otherwise.
    expect(sent.length).toBeGreaterThan(1);
    expect(sent[0].method).toBe('notifications/progress');
    expect(sent[0].params.progressToken).toBe('tok-1');

    approve('approved');
    expect(await call).toBe('approved');

    const afterResolve = sent.length;
    await Bun.sleep(30);
    expect(sent.length).toBe(afterResolve);
  });

  test('stops beating when the wait ends in a rejection', async () => {
    const sent: any[] = [];
    const call = keepAlive('tok-2', async (n: any) => { sent.push(n); }, async () => {
      await Bun.sleep(25);
      throw new Error('denied');
    }, 10);

    await expect(call).rejects.toThrow('denied');
    const afterReject = sent.length;
    await Bun.sleep(30);
    expect(sent.length).toBe(afterReject);
  });

  test('stays silent for clients that never asked for progress', async () => {
    const sent: any[] = [];
    await keepAlive(undefined, async (n: any) => { sent.push(n); }, async () => {
      await Bun.sleep(25);
      return 'done';
    }, 10);

    expect(sent).toEqual([]);
  });
});

describe('canRenameOwnedSession', () => {
  test('only permits the owning session to change its title', () => {
    expect(canRenameOwnedSession('session-a', 'session-a')).toBe(true);
    expect(canRenameOwnedSession('session-a', 'session-b')).toBe(false);
    expect(canRenameOwnedSession('', 'session-a')).toBe(false);
  });
});

describe('matchesMcpSessionOwner', () => {
  test('rejects a transport reused by a different UI session', () => {
    expect(matchesMcpSessionOwner('session-a', 'session-a')).toBe(true);
    expect(matchesMcpSessionOwner('session-a', '')).toBe(true);
    expect(matchesMcpSessionOwner('session-a', 'session-b')).toBe(false);
  });
});

describe('owningUiSessionId', () => {
  test('uses the request header when present', () => {
    const req = new Request('http://localhost:3111/mcp?session_id=query-session', {
      headers: { 'x-session-id': 'header-session' },
    });

    expect(owningUiSessionId(req)).toBe('header-session');
  });

  test('falls back to the session bound into the MCP URL', () => {
    const req = new Request('http://localhost:3111/mcp?session_id=query-session');

    expect(owningUiSessionId(req)).toBe('query-session');
  });
});
