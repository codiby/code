import { describe, expect, test } from 'bun:test';
import { buildContext, buildPrompt, parseFront, stripActionLines } from './voice-agent';
import type { ChatMessage } from '../session/state';

describe('parseFront', () => {
  test('reads action, speech and a multi-line instruction', () => {
    expect(parseFront('ACTION: send\nSAY: Va, lo reviso.\nINSTRUCTION: Revisa el log de voz.\nBusca errores 402.')).toEqual({
      action: 'send',
      say: 'Va, lo reviso.',
      instruction: 'Revisa el log de voz.\nBusca errores 402.',
    });
  });

  test('case in labels and actions is accepted', () => {
    expect(parseFront('Action: Ask\nSay: ¿Cuál log?')?.action).toBe('ask');
  });

  test('placeholder values count as empty, never as speech', () => {
    expect(parseFront('ACTION: respond\nSAY: Onda, ¿qué se te ofrece?\nINSTRUCTION: (vacío)')?.instruction).toBe('');
    expect(parseFront('ACTION: wait\nSAY: (empty)\nINSTRUCTION: -')).toEqual({ action: 'wait', say: '', instruction: '' });
  });

  test('waiting has nothing to say', () => {
    expect(parseFront('ACTION: wait\nSAY:')).toEqual({ action: 'wait', say: '', instruction: '' });
  });

  test('no recognizable action is no decision — the caller sends as heard', () => {
    expect(parseFront('Entendido, lo reviso.')).toBeNull();
    expect(parseFront('ACTION: delete everything\nSAY: ok')).toBeNull();
  });

  test('sending without an instruction is no decision either', () => {
    expect(parseFront('ACTION: send\nSAY: Va.')).toBeNull();
  });
});

describe('stripActionLines', () => {
  test('control lines go, a labelled SAY keeps its words', () => {
    expect(stripActionLines('ACTION: respond\nSAY: Hola.\nINSTRUCTION: nothing')).toBe('Hola.');
  });

  test('a multi-line instruction is never read aloud', () => {
    expect(stripActionLines('ACTION: send\nSAY: Va.\nINSTRUCTION: Revisa el log.\nY luego el bridge.')).toBe('Va.');
  });

  test('plain speech passes through', () => {
    expect(stripActionLines('Listo, ya quedó.')).toBe('Listo, ya quedó.');
  });
});

let n = 0;
const msg = (m: Partial<ChatMessage>): ChatMessage => ({ id: String(n++), role: 'assistant', content: '', timestamp: n, ...m });

describe('buildContext', () => {
  test('keeps what was said and the steps taken, drops thinking and tool output', () => {
    const ctx = buildContext([
      msg({ role: 'user', content: 'revisa el log' }),
      msg({ isThinking: true, content: 'pensando…' }),
      msg({ toolName: 'Bash', toolInput: { command: 'tail server.log', description: 'Read server log' } }),
      msg({ isToolResult: true, content: 'mil líneas' }),
      msg({ content: 'El log muestra un error 402.' }),
    ]);
    expect(ctx).toBe('User: revisa el log\n[agent used Bash: Read server log]\nAgent: El log muestra un error 402.');
  });

  test('keeps only the most recent messages', () => {
    const many = Array.from({ length: 30 }, (_, i) => msg({ role: 'user', content: `m${i}` }));
    const lines = buildContext(many, 20).split('\n');
    expect(lines).toHaveLength(20);
    expect(lines[0]).toBe('User: m10');
    expect(lines[lines.length - 1]).toBe('User: m29');
  });

  test('clips long messages', () => {
    const ctx = buildContext([msg({ content: 'x'.repeat(2000) })]);
    expect(ctx.length).toBeLessThan(700);
  });
});

describe('buildPrompt', () => {
  test('names the mode and carries the payload', () => {
    const p = buildPrompt('front', 'User: hola', 'cambia la voz');
    expect(p).toContain('MODE front');
    expect(p).toContain('"cambia la voz"');
    expect(p).toContain('<conversation>\nUser: hola\n</conversation>');
  });

  test('carries the voice dialogue and flags a busy session', () => {
    const p = buildPrompt('front', '', 'el de voz', {
      busy: true,
      voiceLog: [{ who: 'user', text: 'revisa el log' }, { who: 'voice', text: '¿Cuál log?' }],
    });
    expect(p).toContain('<voice>\nUser: revisa el log\nYou: ¿Cuál log?\n</voice>');
    expect(p).toContain('IN PROGRESS');
  });
});
