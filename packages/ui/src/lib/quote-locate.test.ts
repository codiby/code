import { describe, expect, test } from 'bun:test';
import { locateQuote } from './quote-locate';

describe('locateQuote', () => {
  test('finds a quote inside one text node', () => {
    expect(locateQuote(['Hola mundo cruel'], 'mundo')).toEqual({ startChunk: 0, startOffset: 5, endChunk: 0, endOffset: 10 });
  });

  test('spans list items whose selection text has line breaks the DOM does not', () => {
    const chunks = ['Agrupar por repo.', 'Mover archivadas.'];
    expect(locateQuote(chunks, 'repo.\n\nMover')).toEqual({ startChunk: 0, startOffset: 12, endChunk: 1, endOffset: 5 });
  });

  test('missing or blank quotes give nothing', () => {
    expect(locateQuote(['abc'], 'xyz')).toBeNull();
    expect(locateQuote(['abc'], '  ')).toBeNull();
  });
});
