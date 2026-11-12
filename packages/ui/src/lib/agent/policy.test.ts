import { describe, expect, test } from 'bun:test';
import { decidedViaText, ruleTitle, toolInputView } from './policy';

describe('ruleTitle', () => {
  test('a note wins', () => {
    expect(ruleTitle({ action: 'allow', toolGlob: 'Bash', pattern: '^git ', note: '  Read-only git  ' }, 'Shell')).toBe('Read-only git');
  });

  test('untitled rules read as a sentence instead of "Untitled rule"', () => {
    expect(ruleTitle({ action: 'allow', toolGlob: 'Bash', pattern: '^git (status|log)', note: null }, 'Shell commands')).toBe('Allow Bash calls matching the pattern');
    expect(ruleTitle({ action: 'deny', toolGlob: '*', pattern: null, note: '' }, 'Possible purchases')).toBe('Block possible purchases');
    expect(ruleTitle({ action: 'ask', toolGlob: '*', pattern: null, note: null }, null)).toBe('Ask before every tool call');
    expect(ruleTitle({ action: 'ask', toolGlob: 'mcp__codiby-code__gmail_send, Edit', pattern: null, note: null }, null)).toBe('Ask before gmail_send, Edit calls');
    expect(ruleTitle({ action: 'allow', toolGlob: 'browser_open,browser_navigate,browser_snapshot,browser_close', pattern: null, note: null }, null))
      .toBe('Allow browser_open, browser_navigate and 2 more calls');
  });
});

describe('decidedViaText', () => {
  test('hides what the decision pill already says', () => {
    for (const via of [null, 'policy', 'provider', 'expired', 'cancelled']) expect(decidedViaText(via)).toBeNull();
  });

  test('names where the owner answered', () => {
    expect(decidedViaText('app')).toBe('in the app');
    expect(decidedViaText('desktop')).toBe('in the app');
    expect(decidedViaText('push')).toBe('from your phone');
    expect(decidedViaText('telegram')).toBe('via Telegram');
    expect(decidedViaText('http_webhook')).toBe('via Webhook');
    expect(decidedViaText('some_new_channel')).toBe('via some new channel');
  });
});

describe('toolInputView', () => {
  test('objects become label/value pairs', () => {
    expect(toolInputView(JSON.stringify({ command: 'git status', run_in_background: false, to: ['a@x.com', 'b@x.com'], opts: { a: 1 }, none: null }))).toEqual({
      kind: 'fields',
      fields: [
        ['command', 'git status'],
        ['run in background', 'false'],
        ['to', 'a@x.com, b@x.com'],
        ['opts', '{"a":1}'],
        ['none', '—'],
      ],
    });
  });

  test('input cut mid-way by the log stays text and is flagged', () => {
    expect(toolInputView('{"to":"5216679876543@s.whatsapp.net","text":"Llego en 20')).toEqual({
      kind: 'text',
      text: '{"to":"5216679876543@s.whatsapp.net","text":"Llego en 20',
      truncated: true,
    });
  });

  test('non-objects and empty objects', () => {
    expect(toolInputView('"hello"')).toEqual({ kind: 'text', text: 'hello', truncated: false });
    expect(toolInputView('{}')).toEqual({ kind: 'text', text: 'No input', truncated: false });
    expect(toolInputView('plain words')).toEqual({ kind: 'text', text: 'plain words', truncated: false });
  });
});
