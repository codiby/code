import type { ChatMessage } from '../src/api/types';
import {
  isSuggestNewSessionTool,
  pendingNewSessionSuggestion,
  seededPrompt,
} from '../src/lib/newSessionSuggestion';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(() => Promise.resolve(null)),
  setItem: jest.fn(() => Promise.resolve()),
}));

let n = 0;
const msg = (m: Partial<ChatMessage>): ChatMessage => ({
  id: `m${++n}`,
  role: 'assistant',
  content: '',
  timestamp: n,
  seq: n,
  toolName: null,
  toolInput: null,
  images: [],
  isThinking: false,
  thinkingRedacted: false,
  ...m,
});
const valid = { title: 'FEAT-H43 KW Acts', reason: 'Separate work', prompt: 'Implement FEAT-H43.' };
const offer = (input: Record<string, unknown>) =>
  msg({ toolName: 'mcp__codiby-code__ui_suggest_new_session', toolInput: input });

test('matches both tool names', () => {
  expect(isSuggestNewSessionTool('mcp__codiby-code-sdk__suggest_new_session')).toBe(true);
  expect(isSuggestNewSessionTool('mcp__codiby-code__ui_suggest_new_session')).toBe(true);
  expect(isSuggestNewSessionTool('mcp__codiby-code__ui_suggest_archive')).toBe(false);
});

test('stands until the user writes', () => {
  const call = offer(valid);
  expect(pendingNewSessionSuggestion([call, msg({ content: 'New session?' })])?.id).toBe(call.id);
  expect(pendingNewSessionSuggestion([call, msg({ role: 'user', content: 'here' })])).toBeNull();
  expect(
    pendingNewSessionSuggestion([call, msg({ role: 'user', isToolResult: true })])?.id,
  ).toBe(call.id);
});

test('needs a title and a prompt', () => {
  expect(pendingNewSessionSuggestion([offer({ ...valid, prompt: ' ' })])).toBeNull();
});

test('links back to the source', () => {
  const s = pendingNewSessionSuggestion([offer(valid)])!;
  expect(seededPrompt(s, { id: 'x', name: 'Tickets' })).toBe(
    'Implement FEAT-H43.\n\n_Started from [Tickets](codiby-session:x)._',
  );
});
