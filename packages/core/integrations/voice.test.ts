import { describe, expect, test } from 'bun:test';
import { chunkForSpeech, hasStopIntent, isEcho, isStopCommand, repeats, toSpeakable, words } from './voice';

describe('hasStopIntent', () => {
  test('explicit orders to stop', () => {
    for (const t of ['Para, para.', 'Detente', 'Cancela eso', 'Basta ya', 'Olvídalo', 'Ya no lo quiero', 'stop']) {
      expect(hasStopIntent(t)).toBe(true);
    }
  });

  test('a call for attention or a greeting is not one', () => {
    for (const t of ['Oye, Codin.', 'Hola', '¿Qué onda?', 'Oye, una pregunta']) {
      expect(hasStopIntent(t)).toBe(false);
    }
  });
});

describe('repeats', () => {
  test('a summary that restates the ack is a repeat', () => {
    expect(repeats('¿Qué es lo que está raro? Cuéntame y lo reviso.', ['Dime qué está raro y lo reviso.'])).toBe(true);
  });

  test('results after an ack of intent are new', () => {
    expect(repeats(
      'Listo, cambié la voz a Estrella, que es mexicana, y bajé la velocidad.',
      ['Claro, voy a cambiar la voz a Estrella.'],
    )).toBe(false);
  });

  test('nothing said yet means nothing to repeat', () => {
    expect(repeats('Hola', [])).toBe(false);
  });
});

describe('words', () => {
  test('lowercases and drops accents and punctuation', () => {
    expect(words('¡Detente, Claude! ¿Qué pasó?')).toEqual(['detente', 'claude', 'que', 'paso']);
  });
});

describe('isEcho', () => {
  const reply = new Set(words('El servidor de voz ya funciona. Revisa el archivo de configuración.'));

  test('the reply heard back through the mic is echo', () => {
    expect(isEcho('servidor de voz ya funciona', reply)).toBe(true);
  });

  test('the user saying something else is not', () => {
    expect(isEcho('oye espera tengo una pregunta', reply)).toBe(false);
  });

  test('a single word is never judged echo', () => {
    expect(isEcho('voz', reply)).toBe(false);
  });
});

describe('isStopCommand', () => {
  test('short stop phrases', () => {
    expect(isStopCommand('Para.')).toBe(true);
    expect(isStopCommand('¡Espera, espera!')).toBe(true);
    expect(isStopCommand('stop')).toBe(true);
  });

  test('a real message that starts with a stop word is not one', () => {
    expect(isStopCommand('Para el servidor y reinícialo')).toBe(false);
    expect(isStopCommand('Espera, cambia la voz a Diana')).toBe(false);
  });
});

describe('toSpeakable', () => {
  test('drops code fences and URLs, keeps link text', () => {
    const md = 'Revisa [el PR](https://github.com/x/y/pull/1).\n\n```ts\nconst a = 1\n```\nListo en https://example.com hoy.';
    expect(toSpeakable(md)).toBe('Revisa el PR.\nListo en hoy.');
  });

  test('strips headings, bullets and emphasis', () => {
    const md = '## Resumen\n- **Servidor**: listo\n- _Cliente_: `voice.ts`';
    expect(toSpeakable(md)).toBe('Resumen\nServidor: listo\nCliente: voice.ts');
  });

  test('flattens tables into comma-separated rows', () => {
    const md = '| A | B |\n|---|---|\n| 1 | 2 |';
    expect(toSpeakable(md)).not.toContain('|');
    expect(toSpeakable(md)).not.toContain('---');
  });

  test('leaves snake_case identifiers alone', () => {
    expect(toSpeakable('usa max_tokens aquí')).toBe('usa max_tokens aquí');
  });
});

describe('chunkForSpeech', () => {
  test('short text stays one chunk', () => {
    expect(chunkForSpeech('Hola. ¿Qué tal?')).toEqual(['Hola. ¿Qué tal?']);
  });

  test('splits on sentence boundaries under the limit', () => {
    const chunks = chunkForSpeech('Uno dos. Tres cuatro. Cinco seis.', 12);
    expect(chunks).toEqual(['Uno dos.', 'Tres cuatro.', 'Cinco seis.']);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(12);
  });

  test('hard-cuts a sentence longer than the limit', () => {
    const chunks = chunkForSpeech('a'.repeat(25), 10);
    expect(chunks.join('')).toBe('a'.repeat(25));
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(10);
  });

  test('empty text yields no chunks', () => {
    expect(chunkForSpeech('   ')).toEqual([]);
  });
});
