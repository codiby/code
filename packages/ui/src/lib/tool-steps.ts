import type { ChatMessage } from './claude-client';
import { shortToolName } from './tool-runs';

/**
 * Turns a run of tool calls into the handful of one-line "steps" the thread
 * shows: `Read a.ts b.ts`, `Edited TabBar.tsx +62 −8`, `▶ bun test  12 passed`.
 *
 * The reader wants to know *what happened*, not which tool was called with
 * which absolute path — so consecutive calls of the same kind fold into one
 * line, several edits to the same file fold into one chip, and a shell
 * command is reduced to the part that says what it runs plus its outcome.
 *
 * Tool names and argument shapes differ per provider (Claude `Edit` with
 * `file_path`/`old_string`, OpenCode `edit` with `filePath`/`oldString`, Codex
 * `CodexEdit` with a list of unified diffs), so everything is read through the
 * normalisers below rather than assuming Claude's schema.
 */

export interface FileEdit {
  oldText: string;
  newText: string;
  /** 1-based line where the edit starts in the file, when the tool result says so. */
  startLine: number | null;
}

export interface FileChange {
  path: string;
  added: number;
  removed: number;
  /** The file did not exist before this run. */
  created: boolean;
  edits: FileEdit[];
  /** Error text of a call that failed (e.g. `old_string` not found). */
  error: string | null;
}

interface StepBase {
  /** Id of the first message folded into the step — stable React key. */
  id: string;
  running: boolean;
}

export type ToolStep =
  | (StepBase & { kind: 'read'; files: string[] })
  | (StepBase & { kind: 'search'; queries: { pattern: string; matches: number | null }[] })
  | (StepBase & { kind: 'change'; files: FileChange[] })
  | (StepBase & {
      kind: 'bash';
      command: string;
      short: string;
      outcome: BashOutcome | null;
      failed: boolean;
      durationMs: number | null;
      output: string;
    })
  | (StepBase & { kind: 'thought'; text: string })
  | (StepBase & { kind: 'other'; name: string; summary: string; failed: boolean; message: ChatMessage });

export interface BashOutcome {
  text: string;
  ok: boolean;
}

type Input = Record<string, unknown>;

function inputOf(m: ChatMessage): Input {
  return m.toolInput && typeof m.toolInput === 'object' ? (m.toolInput as Input) : {};
}

function str(input: Input, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = input[k];
    if (typeof v === 'string') return v;
  }
  return null;
}

type Category = 'read' | 'search' | 'change' | 'bash' | 'thought' | 'other';

function categoryOf(m: ChatMessage): Category {
  if (m.isThinking) return 'thought';
  const name = (m.toolName ?? '').toLowerCase();
  const input = inputOf(m);
  if (name === 'read' && str(input, 'file_path', 'filePath', 'path')) return 'read';
  if (name === 'grep' || name === 'glob') return 'search';
  if (name === 'bash' && str(input, 'command')) return 'bash';
  if (name === 'codexedit' && Array.isArray(input.changes)) return 'change';
  if ((name === 'edit' || name === 'multiedit' || name === 'write') && str(input, 'file_path', 'filePath', 'path')) {
    return 'change';
  }
  return 'other';
}

export function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

// ---------------------------------------------------------------------------
// Line diff

export type DiffLineKind = 'ctx' | 'add' | 'del';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

/** Above this many cells the LCS table costs more than the view is worth; the
 *  diff degrades to "everything removed, everything added". */
const MAX_LCS_CELLS = 4_000_000;

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  // A trailing newline is the end of the last line, not an extra empty one.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line-level diff of two snippets, numbered from `start` on both sides. */
export function lineDiff(oldText: string, newText: string, start: number | null = null): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const ops: DiffLineKind[] = [];

  // Trim the common head and tail first: an edit usually touches a few lines
  // in the middle of a larger snippet, and this keeps the table small.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);

  for (let i = 0; i < head; i++) ops.push('ctx');
  if (am.length * bm.length > MAX_LCS_CELLS) {
    for (let i = 0; i < am.length; i++) ops.push('del');
    for (let i = 0; i < bm.length; i++) ops.push('add');
  } else {
    const n = am.length;
    const m = bm.length;
    const table: Uint32Array[] = [];
    for (let i = 0; i <= n; i++) table.push(new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i]![j] = am[i] === bm[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) { ops.push('ctx'); i++; j++; }
      else if (table[i + 1]![j]! >= table[i]![j + 1]!) { ops.push('del'); i++; }
      else { ops.push('add'); j++; }
    }
    while (i++ < n) ops.push('del');
    while (j++ < m) ops.push('add');
  }
  for (let i = 0; i < tail; i++) ops.push('ctx');

  const out: DiffLine[] = [];
  let ai = 0;
  let bi = 0;
  const num = (idx: number) => (start == null ? null : start + idx);
  for (const op of ops) {
    if (op === 'ctx') { out.push({ kind: 'ctx', text: b[bi]!, oldNo: num(ai), newNo: num(bi) }); ai++; bi++; }
    else if (op === 'del') { out.push({ kind: 'del', text: a[ai]!, oldNo: num(ai), newNo: null }); ai++; }
    else { out.push({ kind: 'add', text: b[bi]!, oldNo: null, newNo: num(bi) }); bi++; }
  }
  return out;
}

export function diffStats(oldText: string, newText: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lineDiff(oldText, newText)) {
    if (l.kind === 'add') added++;
    else if (l.kind === 'del') removed++;
  }
  return { added, removed };
}

/**
 * Claude's Edit result quotes the edited region with line numbers
 * (`   112→  const x = 1`). Finding the first non-blank line of the new text in
 * that quote gives the real line the edit starts at, so the diff window can
 * number its rows the way the editor will.
 */
export function locateStartLine(result: string | undefined, newText: string): number | null {
  if (!result) return null;
  const numbered = new Map<string, number>();
  for (const line of result.split('\n')) {
    const m = line.match(/^\s*(\d+)(?:→|\t)(.*)$/);
    if (m && !numbered.has(m[2]!)) numbered.set(m[2]!, Number(m[1]));
  }
  if (numbered.size === 0) return null;
  const lines = splitLines(newText);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.trim()) continue;
    const n = numbered.get(lines[i]!);
    if (n != null) return Math.max(1, n - i);
    return null;
  }
  return null;
}

/** A Codex file change carries a unified diff; rebuild the two sides from it. */
function sidesFromUnified(diff: string): FileEdit[] {
  const edits: FileEdit[] = [];
  let cur: { old: string[]; neu: string[]; start: number | null } | null = null;
  const flush = () => {
    if (cur) edits.push({ oldText: cur.old.join('\n'), newText: cur.neu.join('\n'), startLine: cur.start });
    cur = null;
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) { flush(); cur = { old: [], neu: [], start: Number(hunk[1]) }; continue; }
    if (!cur) cur = { old: [], neu: [], start: null };
    if (line.startsWith('+')) cur.neu.push(line.slice(1));
    else if (line.startsWith('-')) cur.old.push(line.slice(1));
    else if (line.startsWith(' ')) { cur.old.push(line.slice(1)); cur.neu.push(line.slice(1)); }
  }
  flush();
  return edits;
}

interface RawChange {
  path: string;
  created: boolean;
  edits: FileEdit[];
}

function changesOf(m: ChatMessage): RawChange[] {
  const input = inputOf(m);
  const name = (m.toolName ?? '').toLowerCase();
  const result = m.toolResult?.content;

  if (name === 'codexedit') {
    return (input.changes as unknown[]).flatMap((c): RawChange[] => {
      if (!c || typeof c !== 'object') return [];
      const change = c as Input;
      const path = str(change, 'path');
      if (!path) return [];
      const kindRaw = change.kind;
      const kind = typeof kindRaw === 'string' ? kindRaw : (kindRaw as Input | undefined)?.type;
      const diff = str(change, 'diff', 'unified_diff') ?? '';
      const created = kind === 'add';
      const edits = created && !/^@@/m.test(diff)
        ? [{ oldText: '', newText: diff, startLine: 1 }]
        : sidesFromUnified(diff);
      return [{ path, created, edits }];
    });
  }

  const path = str(input, 'file_path', 'filePath', 'path')!;
  if (name === 'write') {
    const content = str(input, 'content') ?? '';
    // Claude answers "File created successfully"; an overwrite says "updated".
    // Without a result yet, assume the common case: a new file.
    const created = !result || /creat/i.test(result);
    return [{ path, created, edits: [{ oldText: '', newText: content, startLine: 1 }] }];
  }
  if (name === 'multiedit' && Array.isArray(input.edits)) {
    const edits = (input.edits as unknown[]).flatMap((e): FileEdit[] => {
      if (!e || typeof e !== 'object') return [];
      const o = str(e as Input, 'old_string', 'oldString');
      const n = str(e as Input, 'new_string', 'newString');
      return o == null || n == null ? [] : [{ oldText: o, newText: n, startLine: locateStartLine(result, n) }];
    });
    return [{ path, created: false, edits }];
  }
  const oldText = str(input, 'old_string', 'oldString') ?? '';
  const newText = str(input, 'new_string', 'newString') ?? '';
  return [{ path, created: false, edits: [{ oldText, newText, startLine: locateStartLine(result, newText) }] }];
}

// ---------------------------------------------------------------------------
// Shell commands

/**
 * `cd /Users/me/src/app/packages/ui && bun test src/x.test.ts 2>&1 | tail -20`
 * → `bun test src/x.test.ts`. The directory hop and the output plumbing are
 * how the agent ran it, not what it ran.
 */
export function shortCommand(command: string): string {
  let s = command.trim().split('\n')[0]!.trim();
  for (;;) {
    const next = s.replace(/^cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*/, '');
    if (next === s) break;
    s = next;
  }
  for (;;) {
    const next = s
      .replace(/\s*\|\s*(tail|head)(\s+-n)?(\s+-?\d+)?\s*$/, '')
      .replace(/\s*2>&1\s*$/, '')
      .replace(/\s*2>\/dev\/null\s*$/, '');
    if (next === s) break;
    s = next;
  }
  s = s.replace(/\s+2>&1(?=\s|$)/g, '');
  return s.length > 90 ? s.slice(0, 87) + '…' : s;
}

/** What a finished command amounted to, in the two or three words that matter. */
export function bashOutcome(output: string, isError: boolean): BashOutcome | null {
  const failMatch = output.match(/(\d+)\s+(?:tests?\s+)?fail(?:ed|ing|ures?)?\b/i);
  const passMatch = output.match(/(\d+)\s+(?:tests?\s+)?pass(?:ed|ing)?\b/i);
  const failed = failMatch ? Number(failMatch[1]) : 0;
  if (failed > 0) return { text: `${failed} failed`, ok: false };
  if (passMatch) return { text: `${passMatch[1]} passed`, ok: true };

  const found = output.match(/Found (\d+) errors?/);
  const tsErrors = found ? Number(found[1]) : (output.match(/error TS\d+/g) ?? []).length;
  if (tsErrors > 0) return { text: `${tsErrors} error${tsErrors === 1 ? '' : 's'}`, ok: false };

  const exit = output.match(/\[exit (\d+)\]\s*$/) ?? output.match(/^Exit code (\d+)/m);
  if (exit && exit[1] !== '0') return { text: `exit ${exit[1]}`, ok: false };
  if (isError) return { text: 'failed', ok: false };
  return null;
}

/** Grep/Glob: how many hits, when the result says so plainly. */
export function searchMatches(result: ChatMessage | undefined): number | null {
  if (!result || result.isError) return null;
  const text = result.content ?? '';
  const found = text.match(/^Found (\d+)/m);
  if (found) return Number(found[1]);
  if (/^No (files|matches) found/m.test(text)) return 0;
  const lines = text.split('\n').filter(l => l.trim());
  return lines.length > 0 ? lines.length : null;
}

function toolSummary(m: ChatMessage): string {
  const input = inputOf(m);
  const pick = str(input, 'description', 'query', 'url', 'pattern', 'name', 'file_path', 'filePath', 'path', 'command');
  if (pick) return pick.length > 80 ? pick.slice(0, 77) + '…' : pick;
  if (typeof m.toolInput === 'string') return m.toolInput.slice(0, 80);
  return '';
}

// ---------------------------------------------------------------------------
// Folding

export function buildToolSteps(items: ChatMessage[]): ToolStep[] {
  const steps: ToolStep[] = [];

  for (const m of items) {
    const cat = categoryOf(m);
    const prev = steps[steps.length - 1];
    const running = !m.isThinking && !m.toolResult;
    const failed = !!m.toolResult?.isError;

    if (cat === 'thought') {
      steps.push({ kind: 'thought', id: m.id, running: !!m.streaming, text: m.content });
      continue;
    }

    if (cat === 'read') {
      const path = str(inputOf(m), 'file_path', 'filePath', 'path')!;
      if (prev?.kind === 'read') {
        if (!prev.files.includes(path)) prev.files.push(path);
        prev.running ||= running;
      } else {
        steps.push({ kind: 'read', id: m.id, running, files: [path] });
      }
      continue;
    }

    if (cat === 'search') {
      const input = inputOf(m);
      const pattern = str(input, 'pattern', 'query') ?? '';
      const query = { pattern, matches: searchMatches(m.toolResult) };
      if (prev?.kind === 'search') {
        prev.queries.push(query);
        prev.running ||= running;
      } else {
        steps.push({ kind: 'search', id: m.id, running, queries: [query] });
      }
      continue;
    }

    if (cat === 'change') {
      const step = prev?.kind === 'change' ? prev : null;
      const target: Extract<ToolStep, { kind: 'change' }> = step ?? { kind: 'change', id: m.id, running: false, files: [] };
      target.running ||= running;
      for (const raw of changesOf(m)) {
        let file = target.files.find(f => f.path === raw.path);
        if (!file) {
          file = { path: raw.path, added: 0, removed: 0, created: raw.created, edits: [], error: null };
          target.files.push(file);
        }
        if (failed) {
          file.error = m.toolResult?.content?.trim() || 'Edit failed';
          continue;
        }
        for (const e of raw.edits) {
          const s = diffStats(e.oldText, e.newText);
          file.added += s.added;
          file.removed += s.removed;
          file.edits.push(e);
        }
      }
      if (!step) steps.push(target);
      continue;
    }

    if (cat === 'bash') {
      const command = str(inputOf(m), 'command')!;
      const output = m.toolResult?.content ?? '';
      const end = m.toolResult?.timestamp;
      steps.push({
        kind: 'bash',
        id: m.id,
        running,
        command,
        short: shortCommand(command),
        outcome: running ? null : bashOutcome(output, failed),
        failed,
        durationMs: end && m.timestamp && end >= m.timestamp ? end - m.timestamp : null,
        output,
      });
      continue;
    }

    steps.push({
      kind: 'other',
      id: m.id,
      running,
      name: shortToolName(m.toolName ?? 'Tool'),
      summary: toolSummary(m),
      failed,
      message: m,
    });
  }

  return steps;
}

export function formatDuration(ms: number | null): string | null {
  if (ms == null || ms < 100) return null;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}
