import { describe, expect, test } from 'bun:test';
import type { ChatMessage } from './claude-client';
import { isSuggestNewSessionTool, pendingNewSessionSuggestion, seededPrompt } from './new-session-suggestion';

let n = 0;
const msg = (m: Partial<ChatMessage>): ChatMessage => ({ id: `m${++n}`, role: 'assistant', content: '', timestamp: n, ...m });
const offer = (input: Record<string, unknown>, extra: Partial<ChatMessage> = {}) =>
  msg({ toolName: 'mcp__codiby-code-sdk__suggest_new_session', toolInput: input, ...extra });
const valid = { title: ' FEAT-H43 KW Acts ', reason: 'Separate from the board tour', prompt: ' Implement FEAT-H43. ' };

describe('isSuggestNewSessionTool', () => {
  test('matches both servers and nothing else', () => {
    expect(isSuggestNewSessionTool('mcp__codiby-code-sdk__suggest_new_session')).toBe(true);
    expect(isSuggestNewSessionTool('mcp__codiby-code__ui_suggest_new_session')).toBe(true);
    expect(isSuggestNewSessionTool('mcp__codiby-code-sdk__suggest_archive')).toBe(false);
    expect(isSuggestNewSessionTool(undefined)).toBe(false);
  });
});

describe('pendingNewSessionSuggestion', () => {
  test('the latest offer stands until the user answers', () => {
    const call = offer(valid);
    expect(pendingNewSessionSuggestion([msg({ role: 'user', content: 'start it' }), call, msg({ content: 'Want a new session?' })]))
      .toEqual({ id: call.id, title: 'FEAT-H43 KW Acts', reason: 'Separate from the board tour', prompt: 'Implement FEAT-H43.', cwd: null });
  });

  test('a user message after it withdraws the offer', () => {
    expect(pendingNewSessionSuggestion([offer(valid), msg({ role: 'user', content: 'do it here' })])).toBeNull();
  });

  test('tool results in between do not count as an answer', () => {
    const call = offer(valid);
    expect(pendingNewSessionSuggestion([call, msg({ role: 'user', isToolResult: true, toolUseId: call.id })])?.id).toBe(call.id);
  });

  test('a failed call, or one without title or prompt, offers nothing', () => {
    expect(pendingNewSessionSuggestion([offer(valid, { toolResult: msg({ isError: true }) })])).toBeNull();
    expect(pendingNewSessionSuggestion([offer({ ...valid, title: '  ' })])).toBeNull();
    expect(pendingNewSessionSuggestion([offer({ ...valid, prompt: 3 })])).toBeNull();
  });

  test('keeps the folder when given', () => {
    expect(pendingNewSessionSuggestion([offer({ ...valid, cwd: '/repo/.wt/h43' })])?.cwd).toBe('/repo/.wt/h43');
  });
});

test('seededPrompt links back to the source session', () => {
  const s = pendingNewSessionSuggestion([offer(valid)])!;
  expect(seededPrompt(s, { id: 'abc', name: 'My Tickets' })).toBe('Implement FEAT-H43.\n\n_Started from [My Tickets](codiby-session:abc)._');
});
