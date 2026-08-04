import { describe, expect, test } from 'bun:test';
import { canRenameOwnedSession, matchesMcpSessionOwner, owningUiSessionId } from './mcp';

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
