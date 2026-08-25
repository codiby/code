import { describe, expect, test } from 'bun:test';
import { diffDocToCode, parseDiffDoc, type DiffDocCodeRow } from './diff-doc';

const code = (src: string) => parseDiffDoc(src).rows.filter(r => r.kind !== 'note' && r.kind !== 'gap') as DiffDocCodeRow[];

describe('parseDiffDoc', () => {
  test('reads the file header and infers the language from the extension', () => {
    const block = parseDiffDoc('file packages/core/session/watcher.ts\n@@ 1\n-a\n+b');
    expect(block.error).toBeUndefined();
    expect(block.path).toBe('packages/core/session/watcher.ts');
    expect(block.lang).toBe('ts');
  });

  test('honours an explicit lang= override', () => {
    expect(parseDiffDoc('file Makefile lang=bash\n@@ 1\n-a\n+b').lang).toBe('bash');
  });

  test('rejects a block with no file header', () => {
    expect(parseDiffDoc('@@ 1\n-a\n+b').error).toBeTruthy();
  });

  test('rejects a block with no changed lines', () => {
    expect(parseDiffDoc('file a.ts\n@@ 1\n const x = 1').error).toBeTruthy();
  });

  test('numbers context, additions and removals independently', () => {
    const rows = code('file a.ts\n@@ 10\n ctx\n-gone\n+new\n+extra\n more');
    expect(rows.map(r => [r.kind, r.oldNo, r.newNo])).toEqual([
      ['ctx', 10, 10],
      ['del', 11, null],
      ['add', null, 11],
      ['add', null, 12],
      ['ctx', 12, 13],
    ]);
  });

  test('a hunk header can set the two sides independently', () => {
    const rows = code('file a.ts\n@@ 28 34\n ctx\n+added');
    expect([rows[0].oldNo, rows[0].newNo]).toEqual([28, 34]);
  });

  test('a gap advances both counters', () => {
    const block = parseDiffDoc('file a.ts\n@@ 1\n ctx\n~ 12\n+added');
    const gap = block.rows[1];
    expect(gap).toEqual({ kind: 'gap', count: 12 });
    expect((block.rows[2] as DiffDocCodeRow).newNo).toBe(14);
  });

  test('keeps prose notes in place', () => {
    const block = parseDiffDoc('file a.ts\n@@ 1\n+added\n> por que si\n ctx');
    expect(block.rows[1]).toEqual({ kind: 'note', text: 'por que si' });
  });

  test('counts additions and removals', () => {
    const block = parseDiffDoc('file a.ts\n@@ 1\n-a\n-b\n+c');
    expect([block.added, block.removed]).toEqual([1, 2]);
  });

  test('an empty line is a blank context line, not a dropped one', () => {
    const rows = code('file a.ts\n@@ 1\n first\n\n+third');
    expect(rows[1]).toMatchObject({ kind: 'ctx', code: '', oldNo: 2 });
  });

  test('marks the changed span of a one-token edit', () => {
    const rows = code('file a.ts\n@@ 1\n-  watch(dir, { recursive: true })\n+  watch(dir, { recursive: false })');
    expect(rows[0].code.slice(rows[0].mark!.start, rows[0].mark!.end)).toBe('tru');
    expect(rows[1].code.slice(rows[1].mark!.start, rows[1].mark!.end)).toBe('fals');
  });

  test('does not mark a full rewrite', () => {
    const rows = code('file a.ts\n@@ 1\n-const a = compute()\n+return null');
    expect(rows[0].mark).toBeUndefined();
  });

  test('does not mark when the runs are not 1:1', () => {
    const rows = code('file a.ts\n@@ 1\n-const alpha = 1\n+const alpha = 2\n+const beta = 3');
    expect(rows.every(r => !r.mark)).toBe(true);
  });

  test('copies back only the post-change lines, without sigils', () => {
    const block = parseDiffDoc('file a.ts\n@@ 1\n ctx\n-gone\n+kept');
    expect(diffDocToCode(block)).toBe('ctx\nkept');
  });
});
