import { describe, expect, test } from 'bun:test';
import { langForPath, parseUnifiedDiff } from './unified-diff';

const SAMPLE = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,4 +10,5 @@ export function a() {
 const keep = 1
-const gone = 2
+const added = 2
+const alsoAdded = 3
 const tail = 4
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+one
+two
`;

describe('parseUnifiedDiff', () => {
  test('splits into files and counts each side', () => {
    const files = parseUnifiedDiff(SAMPLE);

    expect(files.map(f => f.path)).toEqual(['src/a.ts', 'src/new.ts']);
    expect(files[0]).toMatchObject({ status: 'modified', additions: 2, deletions: 1 });
    expect(files[1]).toMatchObject({ status: 'added', additions: 2, deletions: 0 });
  });

  test('numbers both sides so a comment on a line can be anchored to its row', () => {
    const rows = parseUnifiedDiff(SAMPLE)[0]!.rows.filter(r => r.kind !== 'hunk');

    // Hunk starts at old 10 / new 10. Context advances both, a deletion only
    // the left, an addition only the right.
    expect(rows.map(r => [r.kind, r.oldLine, r.newLine])).toEqual([
      ['ctx', 10, 10],
      ['del', 11, null],
      ['add', null, 11],
      ['add', null, 12],
      ['ctx', 12, 13],
    ]);
  });

  test('keeps the hunk header as its own row', () => {
    const first = parseUnifiedDiff(SAMPLE)[0]!.rows[0]!;

    expect(first.kind).toBe('hunk');
    expect(first.text).toStartWith('@@ -10,4 +10,5 @@');
  });

  test('"no newline at end of file" does not shift the line numbers', () => {
    const files = parseUnifiedDiff([
      'diff --git a/x b/x',
      '@@ -1,2 +1,2 @@',
      ' first',
      '-second',
      '\\ No newline at end of file',
      '+second!',
      '\\ No newline at end of file',
    ].join('\n'));
    const rows = files[0]!.rows.filter(r => r.kind !== 'hunk');

    expect(rows.map(r => [r.kind, r.oldLine, r.newLine])).toEqual([
      ['ctx', 1, 1],
      ['del', 2, null],
      ['add', null, 2],
    ]);
  });

  test('reads a rename from its rename headers', () => {
    const files = parseUnifiedDiff([
      'diff --git a/old/name.ts b/new/name.ts',
      'similarity index 98%',
      'rename from old/name.ts',
      'rename to new/name.ts',
    ].join('\n'));

    expect(files[0]).toMatchObject({ status: 'renamed', oldPath: 'old/name.ts', path: 'new/name.ts' });
  });

  test('marks a binary file instead of inventing rows for it', () => {
    const files = parseUnifiedDiff([
      'diff --git a/logo.png b/logo.png',
      'index 111..222 100644',
      'Binary files a/logo.png and b/logo.png differ',
    ].join('\n'));

    expect(files[0]!.binary).toBe(true);
    expect(files[0]!.rows).toHaveLength(0);
  });

  test('handles a path containing a space', () => {
    const files = parseUnifiedDiff('diff --git a/my dir/file.ts b/my dir/file.ts\n@@ -1 +1 @@\n-a\n+b');

    expect(files[0]!.path).toBe('my dir/file.ts');
  });

  test('an empty diff yields no files rather than a phantom one', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });
});

describe('langForPath', () => {
  test('maps common extensions and falls back to plaintext', () => {
    expect(langForPath('a/b/c.tsx')).toBe('tsx');
    expect(langForPath('script.sh')).toBe('bash');
    expect(langForPath('Makefile')).toBe('plaintext');
  });
});
