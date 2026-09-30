import { describe, expect, test } from 'bun:test';
import { buildContext, buildPrompt, parseFront, stripActionLines } from './voice-agent';
import type { ChatMessage } from '../session/state';

describe('parseFront', () => {
  test('reads action, speech and a multi-line instruction', () => {
    expect(parseFront('ACCION: enviar\nDECIR: Va, lo reviso.\nINSTRUCCION: Revisa el log de voz.\nBusca errores 402.')).toEqual({
      action: 'enviar',
      say: 'Va, lo reviso.',
      instruction: 'Revisa el log de voz.\nBusca errores 402.',
    });
  });

  test('accents and case in labels are accepted', () => {
    expect(parseFront('ACCIÓN: Preguntar\nDECIR: ¿Cuál log?')?.action).toBe('preguntar');
  });

  test('placeholder values count as empty, never as speech', () => {
    expect(parseFront('ACCION: responder\nDECIR: Onda, ¿qué se te ofrece?\nINSTRUCCION: (vacío)')?.instruction).toBe('');
    expect(parseFront('ACCION: esperar\nDECIR: (vacío)\nINSTRUCCION: -')).toEqual({ action: 'esperar', say: '', instruction: '' });
  });

  test('waiting has nothing to say', () => {
    expect(parseFront('ACCION: esperar\nDECIR:')).toEqual({ action: 'esperar', say: '', instruction: '' });
  });

  test('no recognizable action is no decision — the caller sends as heard', () => {
    expect(parseFront('Entendido, lo reviso.')).toBeNull();
    expect(parseFront('ACCION: borrar todo\nDECIR: ok')).toBeNull();
  });

  test('sending without an instruction is no decision either', () => {
    expect(parseFront('ACCION: enviar\nDECIR: Va.')).toBeNull();
  });
});

describe('stripActionLines', () => {
  test('control lines go, a labelled DECIR keeps its words', () => {
    expect(stripActionLines('ACCION: responder\nDECIR: Hola.\nINSTRUCCION: nada')).toBe('Hola.');
  });

  test('a multi-line instruction is never read aloud', () => {
    expect(stripActionLines('ACCION: enviar\nDECIR: Va.\nINSTRUCCION: Revisa el log.\nY luego el bridge.')).toBe('Va.');
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
    expect(ctx).toBe('Usuario: revisa el log\n[agente usó Bash: Read server log]\nAgente: El log muestra un error 402.');
  });

  test('keeps only the most recent messages', () => {
    const many = Array.from({ length: 30 }, (_, i) => msg({ role: 'user', content: `m${i}` }));
    const lines = buildContext(many, 20).split('\n');
    expect(lines).toHaveLength(20);
    expect(lines[0]).toBe('Usuario: m10');
    expect(lines[lines.length - 1]).toBe('Usuario: m29');
  });

  test('clips long messages', () => {
    const ctx = buildContext([msg({ content: 'x'.repeat(2000) })]);
    expect(ctx.length).toBeLessThan(700);
  });
});

describe('buildPrompt', () => {
  test('names the mode and carries the payload', () => {
    const p = buildPrompt('front', 'Usuario: hola', 'cambia la voz');
    expect(p).toContain('MODO front');
    expect(p).toContain('"cambia la voz"');
    expect(p).toContain('<conversacion>\nUsuario: hola\n</conversacion>');
  });

  test('carries the voice dialogue and flags a busy session', () => {
    const p = buildPrompt('front', '', 'el de voz', {
      busy: true,
      voiceLog: [{ who: 'usuario', text: 'revisa el log' }, { who: 'voz', text: '¿Cuál log?' }],
    });
    expect(p).toContain('<voz>\nUsuario: revisa el log\nTú: ¿Cuál log?\n</voz>');
    expect(p).toContain('EN CURSO');
  });
});
