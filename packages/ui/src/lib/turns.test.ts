import { describe, expect, test } from 'bun:test';
import type { ChatMessage } from './claude-client';
import { foldTurns, isTurnMedia, isTurnWork, type TurnWork } from './turns';

let seq = 0;
const id = () => `m${++seq}`;

const user = (content = 'do it', ts = 0): ChatMessage => ({ id: id(), role: 'user', content, timestamp: ts });
const text = (content: string, ts = 0): ChatMessage => ({ id: id(), role: 'assistant', content, timestamp: ts });
const thought = (): ChatMessage => ({ id: id(), role: 'assistant', content: 'hmm', timestamp: 0, isThinking: true });
const result = (content = 'ok', extra: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id: id(), role: 'assistant', content, timestamp: 0, isToolResult: true, ...extra });
const tool = (toolName: string, toolInput: unknown, res?: ChatMessage, ts = 0): ChatMessage =>
  ({ id: id(), role: 'assistant', content: '', timestamp: ts, toolName, toolInput, toolResult: res ?? result() });
const run = (...items: ChatMessage[]) => ({ toolRun: true as const, items });

type Item = ChatMessage | ReturnType<typeof run>;

function shape(out: unknown[]): string[] {
  return out.map(i => {
    if (isTurnWork(i)) return `fold(${(i as TurnWork<Item>).items.length})`;
    if ('toolRun' in (i as object)) return 'run';
    const m = i as ChatMessage;
    if (m.role === 'user') return 'user';
    if (m.toolName) return m.toolName;
    return m.isThinking ? 'thought' : `text:${m.content}`;
  });
}

describe('foldTurns', () => {
  test('folds the work of a finished turn and keeps the answer', () => {
    const items: Item[] = [
      user(),
      text('checking first'),
      run(tool('Read', { file_path: '/a.ts' }), tool('Bash', { command: 'bun test' })),
      text('now editing'),
      tool('Edit', { file_path: '/a.ts', old_string: 'a', new_string: 'b\nc' }),
      text('Done: it works.'),
    ];
    expect(shape(foldTurns(items, { live: false }))).toEqual(['user', 'fold(4)', 'text:Done: it works.']);
  });

  test('the turn still running is left alone', () => {
    const items: Item[] = [user(), text('checking'), tool('Read', { file_path: '/a.ts' })];
    expect(shape(foldTurns(items, { live: true }))).toEqual(['user', 'text:checking', 'Read']);
  });

  test('earlier turns fold while the latest one runs', () => {
    const items: Item[] = [
      user(), tool('Read', { file_path: '/a.ts' }), text('answer 1'),
      user(), text('working on it'),
    ];
    expect(shape(foldTurns(items, { live: true }))).toEqual(['user', 'fold(1)', 'text:answer 1', 'user', 'text:working on it']);
  });

  test('a turn without tools is untouched', () => {
    const items: Item[] = [user(), text('just an answer')];
    expect(shape(foldTurns(items, { live: false }))).toEqual(['user', 'text:just an answer']);
  });

  test('reasoning before the answer belongs to the work', () => {
    const items: Item[] = [user(), tool('Read', { file_path: '/a.ts' }), thought(), text('answer')];
    expect(shape(foldTurns(items, { live: false }))).toEqual(['user', 'fold(2)', 'text:answer']);
  });

  test('plans, questions and mockups stay visible', () => {
    const items: Item[] = [
      user(),
      tool('Read', { file_path: '/a.ts' }),
      tool('mcp__codiby-code-sdk__mockup_write', { name: 'x', html: '<p>' }),
      tool('Edit', { file_path: '/a.ts', old_string: 'a', new_string: 'b' }),
      tool('ExitPlanMode', { plan: 'p' }),
    ];
    expect(shape(foldTurns(items, { live: false }))).toEqual([
      'user', 'fold(2)', 'mcp__codiby-code-sdk__mockup_write', 'ExitPlanMode',
    ]);
  });

  test('stats sum files across the turn and count commands', () => {
    const items: Item[] = [
      user('go', 1000),
      tool('Edit', { file_path: '/a.ts', old_string: 'a', new_string: 'b\nc' }, result('ok', { timestamp: 2000 }), 1500),
      tool('Bash', { command: 'bun test' }, result('3 fail', { isError: true, timestamp: 4000 }), 3000),
      tool('Edit', { file_path: '/a.ts', old_string: 'x', new_string: 'y' }, result('ok', { timestamp: 5000 }), 4500),
      tool('Bash', { command: 'bun test' }, result('3 pass', { timestamp: 7000 }), 6000),
      text('done', 7500),
    ];
    const fold = foldTurns(items, { live: false }).find(isTurnWork)!;
    expect(fold.stats).toEqual({
      durationMs: 6000,
      files: [{ path: '/a.ts', added: 3, removed: 2 }],
      commands: 2,
      failedCommands: 1,
    });
  });

  test('a stopped last turn is marked', () => {
    const items: Item[] = [user(), tool('Bash', { command: 'sleep 9' })];
    const fold = foldTurns(items, { live: false, interrupted: true }).find(isTurnWork)!;
    expect(fold.stopped).toBe(true);
  });
});

describe('turn media', () => {
  const posted = (): ChatMessage =>
    ({ id: id(), role: 'system', content: '', timestamp: 0, images: [{ media_type: 'image/png', data: 'AAA' }] });
  const html = '<!doctype html><p>hi</p>';

  test('images and mockups folded into the work repeat under the answer', () => {
    const shot = JSON.stringify([{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBB' } }]);
    const items: Item[] = [
      user(),
      run(
        tool('mcp__codiby-code-sdk__post_image_to_session', { path: '/a.png' }),
        posted(),
        tool('Read', { file_path: '/b.jpg' }, result(shot)),
      ),
      // A mockup written by a sub-agent run stays inside the fold.
      { agent: tool('Agent', {}), children: [tool('mcp__codiby-code-sdk__mockup_write', { name: 'sidebar', html })] } as unknown as Item,
      tool('Bash', { command: 'true' }),
      text('done'),
    ];
    const out = foldTurns(items, { live: false });
    const media = out.find(isTurnMedia)!;
    expect(out.indexOf(media)).toBe(out.length - 1);
    expect(media.items).toEqual([
      { kind: 'image', src: 'data:image/png;base64,AAA' },
      { kind: 'image', src: 'data:image/jpeg;base64,BBB' },
      { kind: 'mockup', name: 'sidebar', html },
    ]);
  });

  test('an image posted after the last tool call folds too, instead of reading as the answer', () => {
    const post = 'mcp__codiby-code-sdk__post_image_to_session';
    const items: Item[] = [
      user(),
      tool(post, { path: '/a.png' }), posted(),
      tool(post, { path: '/b.png' }), { ...posted(), content: 'the list' },
      text('Here are both.'),
    ];
    const out = foldTurns(items, { live: false });
    expect(shape(out.filter(i => !isTurnMedia(i)))).toEqual(['user', 'fold(4)', 'text:Here are both.']);
    expect(out.find(isTurnMedia)!.items.map(i => (i.kind === 'image' ? i.caption : null))).toEqual([undefined, 'the list']);
  });

  test('no strip when the work showed nothing, or the mockup failed', () => {
    const items: Item[] = [
      user(),
      tool('mcp__codiby-code-sdk__mockup_write', { name: 'x', html }, result('boom', { isError: true })),
      tool('Bash', { command: 'true' }),
      text('done'),
    ];
    expect(foldTurns(items, { live: false }).some(isTurnMedia)).toBe(false);
  });
});
