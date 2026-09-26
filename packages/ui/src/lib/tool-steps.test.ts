import { describe, expect, test } from 'bun:test';
import type { ChatMessage } from './claude-client';
import {
  bashOutcome,
  buildToolSteps,
  diffStats,
  formatDuration,
  lineDiff,
  locateStartLine,
  searchMatches,
  shortCommand,
} from './tool-steps';

let seq = 0;
const nextId = () => `m${++seq}`;

function result(content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id: nextId(), role: 'assistant', content, timestamp: 0, isToolResult: true, ...extra };
}

function tool(toolName: string, toolInput: unknown, res?: ChatMessage, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id: nextId(), role: 'assistant', content: '', timestamp: 0, toolName, toolInput, toolResult: res, ...extra };
}

describe('lineDiff', () => {
  test('marks only the changed lines', () => {
    const rows = lineDiff('a\nb\nc', 'a\nB\nc');
    expect(rows.map(r => r.kind)).toEqual(['ctx', 'del', 'add', 'ctx']);
  });

  test('numbers both sides from the start line', () => {
    const rows = lineDiff('a\nb', 'a\nx\nb', 10);
    expect(rows).toEqual([
      { kind: 'ctx', text: 'a', oldNo: 10, newNo: 10 },
      { kind: 'add', text: 'x', oldNo: null, newNo: 11 },
      { kind: 'ctx', text: 'b', oldNo: 11, newNo: 12 },
    ]);
  });

  test('a new file is all additions', () => {
    expect(diffStats('', 'one\ntwo\n')).toEqual({ added: 2, removed: 0 });
  });
});

describe('locateStartLine', () => {
  test('reads the line number off Claude\'s numbered snippet', () => {
    const res = 'The file x.ts has been updated. Here\'s the result:\n   111→function f() {\n   112→  const y = 2\n   113→}';
    expect(locateStartLine(res, '  const y = 2\n}')).toBe(112);
  });

  test('null when the result has no numbered snippet', () => {
    expect(locateStartLine('ok', 'x')).toBeNull();
  });
});

describe('shortCommand', () => {
  test('drops the cd prefix and the output plumbing', () => {
    expect(shortCommand('cd /Users/me/src/app/packages/ui && bun test src/x.test.ts 2>&1 | tail -20')).toBe('bun test src/x.test.ts');
    expect(shortCommand('cd /a && cd b && bunx tsc --noEmit -p . 2>&1 | head -30')).toBe('bunx tsc --noEmit -p .');
  });

  test('keeps a plain command as is', () => {
    expect(shortCommand('git status')).toBe('git status');
  });
});

describe('bashOutcome', () => {
  test('test runners', () => {
    expect(bashOutcome(' 12 pass\n 0 fail\n', false)).toEqual({ text: '12 passed', ok: true });
    expect(bashOutcome('Tests: 2 failed, 10 passed', true)).toEqual({ text: '2 failed', ok: false });
  });

  test('type errors', () => {
    expect(bashOutcome('a.ts(1,2): error TS2345: …\nFound 2 errors in the same file.', true)).toEqual({ text: '2 errors', ok: false });
  });

  test('bare exit codes', () => {
    expect(bashOutcome('Exit code 127\ncommand not found', true)).toEqual({ text: 'exit 127', ok: false });
    expect(bashOutcome('boom\n[exit 1]', true)).toEqual({ text: 'exit 1', ok: false });
  });

  test('nothing to say about a quiet success', () => {
    expect(bashOutcome('done', false)).toBeNull();
  });
});

describe('searchMatches', () => {
  test('uses the count the tool reports', () => {
    expect(searchMatches(result('Found 7 files\na.ts'))).toBe(7);
    expect(searchMatches(result('No files found'))).toBe(0);
    expect(searchMatches(result('a.ts\nb.ts\n'))).toBe(2);
  });
});

describe('buildToolSteps', () => {
  test('consecutive reads fold into one step', () => {
    const steps = buildToolSteps([
      tool('Read', { file_path: '/r/a.ts' }, result('x')),
      tool('Read', { file_path: '/r/b.ts' }, result('x')),
      tool('Read', { file_path: '/r/a.ts' }, result('x')),
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: 'read', files: ['/r/a.ts', '/r/b.ts'] });
  });

  test('edits to the same file sum into one chip', () => {
    const steps = buildToolSteps([
      tool('Edit', { file_path: '/r/a.ts', old_string: 'a', new_string: 'a\nb' }, result('ok')),
      tool('Edit', { file_path: '/r/a.ts', old_string: 'x\ny', new_string: 'z' }, result('ok')),
      tool('Write', { file_path: '/r/new.ts', content: '1\n2\n3\n' }, result('File created successfully at: /r/new.ts')),
    ]);
    expect(steps).toHaveLength(1);
    const step = steps[0]!;
    if (step.kind !== 'change') throw new Error('expected change');
    expect(step.files.map(f => [f.path, f.added, f.removed, f.created])).toEqual([
      ['/r/a.ts', 2, 2, false],
      ['/r/new.ts', 3, 0, true],
    ]);
    expect(step.files[0]!.edits).toHaveLength(2);
  });

  test('reads the OpenCode argument names', () => {
    const steps = buildToolSteps([tool('edit', { filePath: '/r/a.ts', oldString: 'a', newString: 'b' }, result('ok'))]);
    expect(steps[0]).toMatchObject({ kind: 'change', files: [{ path: '/r/a.ts', added: 1, removed: 1 }] });
  });

  test('rebuilds a Codex change from its unified diff', () => {
    const diff = '@@ -3,2 +3,2 @@\n keep\n-old\n+new\n';
    const steps = buildToolSteps([tool('CodexEdit', { changes: [{ path: '/r/a.ts', kind: { type: 'update' }, diff }] }, result('update /r/a.ts'))]);
    expect(steps[0]).toMatchObject({ kind: 'change', files: [{ path: '/r/a.ts', added: 1, removed: 1, created: false }] });
  });

  test('a failed edit keeps its error instead of counting lines', () => {
    const steps = buildToolSteps([
      tool('Edit', { file_path: '/r/a.ts', old_string: 'a', new_string: 'b' }, result('String to replace not found', { isError: true })),
    ]);
    expect(steps[0]).toMatchObject({ kind: 'change', files: [{ added: 0, removed: 0, error: 'String to replace not found' }] });
  });

  test('bash steps carry the short command, outcome and duration', () => {
    const steps = buildToolSteps([
      tool('Bash', { command: 'cd /r && bun test 2>&1 | tail -5' }, result(' 12 pass\n 0 fail', { timestamp: 3100 }), { timestamp: 0 }),
    ]);
    expect(steps[0]).toMatchObject({ kind: 'bash', short: 'bun test', outcome: { text: '12 passed', ok: true } });
  });

  test('a call without a result is running', () => {
    const steps = buildToolSteps([tool('Bash', { command: 'sleep 5' })]);
    expect(steps[0]).toMatchObject({ kind: 'bash', running: true, outcome: null });
  });

  test('different kinds stay on their own lines, in order', () => {
    const steps = buildToolSteps([
      tool('Read', { file_path: '/r/a.ts' }, result('x')),
      tool('Grep', { pattern: 'foo' }, result('Found 3 files')),
      tool('Read', { file_path: '/r/b.ts' }, result('x')),
      tool('mcp__srv__do_thing', { name: 'x' }, result('ok')),
    ]);
    expect(steps.map(s => s.kind)).toEqual(['read', 'search', 'read', 'other']);
    expect(steps[3]).toMatchObject({ name: 'do thing', summary: 'x' });
  });
});

test('formatDuration', () => {
  expect(formatDuration(50)).toBeNull();
  expect(formatDuration(3100)).toBe('3.1s');
  expect(formatDuration(42_000)).toBe('42s');
  expect(formatDuration(125_000)).toBe('2m 5s');
});
