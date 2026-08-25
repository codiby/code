/**
 * Grammar for the ```diffdoc fenced block.
 *
 * A `diffdoc` is a diff the agent *types into its own answer*, so the change
 * reads as part of the document — a typeset figure with prose notes anchored
 * between the hunks — instead of as a separate tool card the reader has to
 * mentally re-attach to the surrounding explanation.
 *
 * This module is deliberately pure (no DOM, no React, no Prism) so the grammar
 * can be unit-tested on its own; rendering lives in components/DiffDoc.tsx and
 * the fence routing is a ~10-line segmentation step in components/Markdown.tsx.
 *
 * Shape of a block:
 *
 *     file packages/core/session/watcher.ts
 *     @@ 28
 *     +const SKIP = new Set(['node_modules', '.git'])
 *
 *     > A `Set` rather than a glob: micromatch ran once per entry of the tree.
 *     ~ 12
 *     @@ 44 46
 *      async function walk(dir: string) {
 *     -  for (const e of await readdir(dir)) {
 *     +  for (const e of await readdir(dir, { withFileTypes: true })) {
 */

/** A code line of the diff. `mark` is the intra-line changed span, if any. */
export interface DiffDocCodeRow {
  kind: 'ctx' | 'add' | 'del';
  /** 1-based line number on the left (pre-change) side; null on additions. */
  oldNo: number | null;
  /** 1-based line number on the right (post-change) side; null on removals. */
  newNo: number | null;
  code: string;
  mark?: { start: number; end: number };
}

/** Prose typeset *inside* the diff, anchored to the lines just above it. */
export interface DiffDocNoteRow {
  kind: 'note';
  text: string;
}

/** A run of unchanged lines the agent chose not to reproduce. */
export interface DiffDocGapRow {
  kind: 'gap';
  count: number;
}

export type DiffDocRow = DiffDocCodeRow | DiffDocNoteRow | DiffDocGapRow;

export interface DiffDocBlock {
  path: string;
  /** Fence-language hint for the syntax highlighter ('' when unknown). */
  lang: string;
  rows: DiffDocRow[];
  added: number;
  removed: number;
  /** Set when the source is malformed; callers fall back to a plain block. */
  error?: string;
}

const FILE_RE = /^file\s+(\S+)(?:\s+lang=([\w+#-]+))?\s*$/;
const HUNK_RE = /^@@\s*(\d+)(?:\s*[,\s]\s*(\d+))?\s*$/;

/**
 * Intra-line highlight is only worth showing when the two lines are clearly the
 * *same* line edited. Below this many shared characters, or above this share of
 * the line changed, the pair is a rewrite and tinting a span inside it is noise.
 */
const MARK_MIN_COMMON = 8;
const MARK_MAX_CHANGED_RATIO = 0.6;

/** Language hint from a `lang=` override or the path's extension. */
function langFor(path: string, override?: string): string {
  if (override) return override.toLowerCase();
  const ext = /\.([A-Za-z0-9+#]+)$/.exec(path);
  return ext ? ext[1].toLowerCase() : '';
}

/**
 * Tag the changed span inside a 1:1 replacement so a one-token edit
 * (`recursive: true` → `false`) reads at a glance. Mutates both rows.
 */
function markPair(del: DiffDocCodeRow, add: DiffDocCodeRow): void {
  const a = del.code;
  const b = add.code;
  const max = Math.min(a.length, b.length);

  let start = 0;
  while (start < max && a[start] === b[start]) start++;

  let tail = 0;
  while (tail < max - start && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

  const aEnd = a.length - tail;
  const bEnd = b.length - tail;
  const changed = Math.max(aEnd - start, bEnd - start);
  if (changed <= 0) return;

  const longest = Math.max(a.length, b.length);
  if (longest - changed < MARK_MIN_COMMON) return;
  if (changed > longest * MARK_MAX_CHANGED_RATIO) return;

  del.mark = { start, end: aEnd };
  add.mark = { start, end: bEnd };
}

/**
 * Pair each removal with the addition at the same offset in the following run,
 * but only when the two runs are the same length — that's the case where the
 * lines line up 1:1 and an intra-line highlight is trustworthy.
 */
function markRuns(rows: DiffDocRow[]): void {
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].kind !== 'del') continue;
    let d = i;
    while (d < rows.length && rows[d].kind === 'del') d++;
    let a = d;
    while (a < rows.length && rows[a].kind === 'add') a++;
    const dels = d - i;
    const adds = a - d;
    if (dels > 0 && dels === adds) {
      for (let k = 0; k < dels; k++) {
        markPair(rows[i + k] as DiffDocCodeRow, rows[d + k] as DiffDocCodeRow);
      }
    }
    i = a - 1;
  }
}

/**
 * Parse the body of a ```diffdoc fence. Never throws: anything it can't make
 * sense of comes back as `error`, and the caller renders a plain code block
 * rather than showing the reader a broken figure.
 */
export function parseDiffDoc(source: string): DiffDocBlock {
  const empty = (error: string): DiffDocBlock => ({ path: '', lang: '', rows: [], added: 0, removed: 0, error });

  const lines = source.replace(/\s+$/, '').split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length) return empty('empty block');

  const head = FILE_RE.exec(lines[i].trim());
  if (!head) return empty('first line must be `file <path>`');
  const path = head[1];
  const lang = langFor(path, head[2]);
  i++;

  const rows: DiffDocRow[] = [];
  let oldNo = 1;
  let newNo = 1;
  let added = 0;
  let removed = 0;

  for (; i < lines.length; i++) {
    const raw = lines[i];

    const hunk = HUNK_RE.exec(raw.trim());
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = hunk[2] ? Number(hunk[2]) : oldNo;
      continue;
    }

    // Prose note. Sits where it was written, between the lines it explains.
    if (raw.startsWith('>')) {
      const text = raw.slice(1).trim();
      if (text) rows.push({ kind: 'note', text });
      continue;
    }

    // Elided run of unchanged lines — advances both counters so the numbers
    // below the gap stay truthful.
    if (raw.startsWith('~')) {
      const count = Math.max(0, Number(raw.slice(1).trim()) || 0);
      rows.push({ kind: 'gap', count });
      oldNo += count;
      newNo += count;
      continue;
    }

    if (raw.startsWith('+')) {
      rows.push({ kind: 'add', oldNo: null, newNo, code: raw.slice(1) });
      newNo++;
      added++;
      continue;
    }

    if (raw.startsWith('-')) {
      rows.push({ kind: 'del', oldNo, newNo: null, code: raw.slice(1) });
      oldNo++;
      removed++;
      continue;
    }

    // Context. Agents routinely strip the trailing space off a blank context
    // line, so an empty line counts as one rather than being dropped.
    const code = raw.startsWith(' ') ? raw.slice(1) : raw;
    rows.push({ kind: 'ctx', oldNo, newNo, code });
    oldNo++;
    newNo++;
  }

  if (!rows.some(r => r.kind === 'add' || r.kind === 'del')) {
    return empty('no + or - lines');
  }

  markRuns(rows);
  return { path, lang, rows, added, removed };
}

/**
 * The post-change text of the lines the block actually shows — what the copy
 * button hands over. Gaps are elided lines we were never given, so they can
 * only be marked, not reconstructed.
 */
export function diffDocToCode(block: DiffDocBlock): string {
  return block.rows
    .filter(r => r.kind === 'ctx' || r.kind === 'add')
    .map(r => (r as DiffDocCodeRow).code)
    .join('\n');
}
