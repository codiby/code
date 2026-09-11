import { describe, expect, test } from 'bun:test';
import { canRenameOwnedSession, keepAlive, matchesMcpSessionOwner, owningUiSessionId, executeLocalMcpTool, handleMcpRequest } from './mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { sessions } from '../session/sessions';
import { updateSessionState, clearSessionState } from '../session/state';

test('MCP advertises remote coordination and preserves local execution', async () => {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handleMcpRequest });
  const client = new Client({ name: 'coordination-test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', server.url)));
    const { tools } = await client.listTools();
    expect(tools.some(t => t.name === 'ui_list_hosts')).toBe(true);
    for (const name of ['ui_list_sessions', 'ui_read_session_messages', 'ui_send_message', 'ui_spawn_session']) {
      expect(tools.find(t => t.name === name)?.inputSchema.properties).toHaveProperty('host_id');
    }
    const result = await client.callTool({ name: 'ui_read_session_messages', arguments: { session_id: 'missing-fixture' } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('Session not found');
  } finally { await client.close(); server.stop(true); }
});

test('incremental context reads page forward without dropping intervening messages', async () => {
  const id = `test-peer-pagination-${crypto.randomUUID()}`;
  sessions.set(id, { id } as any);
  updateSessionState(id, state => ({ ...state, messages: Array.from({ length: 45 }, (_, i) => ({
    id: `m${i + 1}`, seq: i + 1, timestamp: Date.now(), role: 'assistant', content: `answer-${i + 1}`,
  })) }));
  try {
    const first = JSON.stringify(await executeLocalMcpTool('ui_read_session_messages', { session_id: id, since_seq: 0, limit: 20 }, 'caller'));
    expect(first).toContain('next_seq=20');
    expect(first).toContain('has_more=true');
    expect(first).toContain('answer-1');
    expect(first).not.toContain('answer-21');
    const second = JSON.stringify(await executeLocalMcpTool('ui_read_session_messages', { session_id: id, since_seq: 20, limit: 20 }, 'caller'));
    expect(second).toContain('next_seq=40');
    expect(second).toContain('answer-21');
    const third = JSON.stringify(await executeLocalMcpTool('ui_read_session_messages', { session_id: id, since_seq: 40, limit: 20 }, 'caller'));
    expect(third).toContain('next_seq=45');
    expect(third).toContain('has_more=false');
  } finally { clearSessionState(id); sessions.delete(id); }
});

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
