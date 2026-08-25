import { describe, expect, test } from 'bun:test';
import { splitBlockSegments } from './block-fences';

const LANGS = ['diffdoc', 'explain'] as const;
const split = (src: string) => splitBlockSegments(src, LANGS);

describe('splitBlockSegments', () => {
  test('leaves a document with no routed block untouched', () => {
    const src = 'hola\n\n```ts\nconst x = 1\n```';
    expect(split(src)).toEqual([{ type: 'md', text: src }]);
  });

  test('splits prose around a block', () => {
    expect(split('antes\n```diffdoc\nfile a.ts\n+x\n```\ndespues')).toEqual([
      { type: 'md', text: 'antes' },
      { type: 'block', lang: 'diffdoc', source: 'file a.ts\n+x' },
      { type: 'md', text: 'despues' },
    ]);
  });

  test('keeps each block tagged with its own language', () => {
    const segments = split('```explain\ngoal x\n# a\n```\ny\n```diffdoc\nfile b.ts\n+z\n```');
    expect(segments.map(s => (s.type === 'block' ? s.lang : s.type))).toEqual(['explain', 'md', 'diffdoc']);
  });

  test('a block quoted inside a longer fence stays markdown', () => {
    const src = '````md\n```diffdoc\nfile a.ts\n+x\n```\n````';
    expect(split(src)).toEqual([{ type: 'md', text: src }]);
  });

  test('an unterminated block reports as still streaming, with its language', () => {
    expect(split('texto\n```explain\ngoal x')).toEqual([
      { type: 'md', text: 'texto' },
      { type: 'pending', lang: 'explain' },
    ]);
  });

  test('an ordinary fence between two blocks does not swallow them', () => {
    const segments = split('```diffdoc\nfile a.ts\n+x\n```\n```js\nlet a\n```\n```explain\ngoal g\n# s\n```');
    expect(segments.map(s => (s.type === 'block' ? s.lang : s.type))).toEqual(['diffdoc', 'md', 'explain']);
  });
});
