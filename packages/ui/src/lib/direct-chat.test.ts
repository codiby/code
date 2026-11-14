import { describe, expect, test } from 'bun:test';
import type { SessionInfo } from './claude-client';
import { directHandoff, directMessageText, directPrompt, parseDirectRecommendation, type DirectContext } from './direct-chat';

const session = (over: Partial<SessionInfo>): SessionInfo => ({
  id: 's1', name: 'Orders', cwd: '/home/j/vtb', created_at: 1, updated_at: 2, status: 'open',
  runtime_status: 'stopped', ready: true, claude_session_id: null, ws_url: '', saved_commands: [],
  model: null, permission_mode: 'default', remoteId: 'ryzen9', ...over,
});

const context: DirectContext = {
  hosts: [{ id: '', name: 'Local', home: '/Users/j' }, { id: 'ryzen9', name: 'ryzen9', home: '/home/j' }],
  sessions: [session({}), session({ id: 'tmp', disposable_ttl_ms: 1000 })],
  excerpts: [],
};
const route = (body: object) => `Done.\n\n\`\`\`codiby-route\n${JSON.stringify(body)}\n\`\`\``;

describe('parseDirectRecommendation', () => {
  test('continue only targets a known, non-disposable session on its host', () => {
    expect(parseDirectRecommendation(route({ kind: 'continue', serverId: 'ryzen9', sessionId: 's1', reason: 'same bug' }), context))
      .toMatchObject({ kind: 'continue', session: { id: 's1' } });
    expect(parseDirectRecommendation(route({ kind: 'continue', serverId: '', sessionId: 's1', reason: 'x' }), context)).toBeNull();
    expect(parseDirectRecommendation(route({ kind: 'continue', serverId: 'ryzen9', sessionId: 'tmp', reason: 'x' }), context)).toBeNull();
  });

  test('new needs a cwd from the inventory or the host home', () => {
    expect(parseDirectRecommendation(route({ kind: 'new', serverId: 'ryzen9', cwd: '/home/j/vtb', title: 'TZ', reason: 'x' }), context))
      .toMatchObject({ kind: 'new', hostId: 'ryzen9', cwd: '/home/j/vtb' });
    expect(parseDirectRecommendation(route({ kind: 'new', serverId: '', cwd: '/Users/j', title: 'T', reason: 'x' }), context))
      .toMatchObject({ kind: 'new', hostId: '' });
    expect(parseDirectRecommendation(route({ kind: 'new', serverId: 'ryzen9', cwd: '/etc', title: 'T', reason: 'x' }), context)).toBeNull();
  });

  test('here keeps the chat; malformed blocks are ignored', () => {
    expect(parseDirectRecommendation(route({ kind: 'here', title: 'Notes', reason: 'new work' }), context))
      .toEqual({ kind: 'here', title: 'Notes', reason: 'new work' });
    expect(parseDirectRecommendation('```codiby-route\n{oops\n```', context)).toBeNull();
    expect(parseDirectRecommendation('no block', context)).toBeNull();
  });
});

test('the inventory and the route block never reach the reader or the handoff', () => {
  const sent = directPrompt('fix the date filter', context, '');
  expect(directMessageText(sent)).toBe('fix the date filter');
  expect(directMessageText(route({ kind: 'here', title: 'a', reason: 'b' }))).toBe('Done.');
  expect(directMessageText('plain text')).toBe('plain text');
  const handoff = directHandoff([
    { id: '1', role: 'user', content: sent },
    { id: '2', role: 'assistant', content: route({ kind: 'here', title: 'a', reason: 'b' }) },
    { id: '3', role: 'user', content: 'also the time zone' },
  ] as never);
  expect(handoff.text).toBe('fix the date filter\n\nalso the time zone');
});
