import { describe, expect, test } from 'bun:test';
import type { ChatMessage } from './claude-client';
import { isSuggestArchiveTool, pendingArchiveSuggestion } from './archive-suggestion';

let n = 0;
const msg = (m: Partial<ChatMessage>): ChatMessage => ({ id: `m${++n}`, role: 'assistant', content: '', timestamp: n, ...m });
const suggest = (reason: unknown, extra: Partial<ChatMessage> = {}) =>
  msg({ toolName: 'mcp__codiby-code-sdk__suggest_archive', toolInput: { reason }, ...extra });

describe('isSuggestArchiveTool', () => {
  test('matches both servers and nothing else', () => {
    expect(isSuggestArchiveTool('mcp__codiby-code-sdk__suggest_archive')).toBe(true);
    expect(isSuggestArchiveTool('mcp__codiby-code__ui_suggest_archive')).toBe(true);
    expect(isSuggestArchiveTool('mcp__other__not_suggest_archive_really')).toBe(false);
    expect(isSuggestArchiveTool(undefined)).toBe(false);
  });
});

describe('pendingArchiveSuggestion', () => {
  test('the latest call stands while the agent keeps talking', () => {
    const call = suggest(' PR #318 opened ');
    const got = pendingArchiveSuggestion([msg({ role: 'user', content: 'fix it' }), call, msg({ content: 'Done.' })]);
    expect(got).toEqual({ id: call.id, reason: 'PR #318 opened' });
  });

  test('a user message after it withdraws the suggestion', () => {
    expect(pendingArchiveSuggestion([suggest('done'), msg({ role: 'user', content: 'one more thing' })])).toBeNull();
  });

  test('tool results in between do not count as the user answering', () => {
    const call = suggest('done');
    expect(pendingArchiveSuggestion([call, msg({ role: 'user', isToolResult: true, toolUseId: call.id })])?.id).toBe(call.id);
  });

  test('a failed call or an empty reason suggests nothing', () => {
    expect(pendingArchiveSuggestion([suggest('done', { toolResult: msg({ isError: true }) })])).toBeNull();
    expect(pendingArchiveSuggestion([suggest('   ')])).toBeNull();
    expect(pendingArchiveSuggestion([suggest(42)])).toBeNull();
  });

  test('no call, no suggestion', () => {
    expect(pendingArchiveSuggestion([msg({ content: 'hi' })])).toBeNull();
  });
});
