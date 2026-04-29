import { useMemo } from 'react';

// LCS cell count beyond which we stop computing a proper line-diff and just
// render the current content as one big "changed region". 1.2 M cells ≈ a
// 1100×1100 file, which is way past anything you'd want to review on a phone.
const MAX_LCS_CELLS = 1_200_000;

export type DiffRow =
  | { type: 'eq'; line: string; oldN: number; newN: number }
  | { type: 'add'; line: string; newN: number }
  | { type: 'del'; line: string; oldN: number };

/**
 * Classic Myers-ish LCS line diff. Simple, predictable, and cheap enough for
 * files that fit in `MAX_LCS_CELLS`.
 */
export function diffLines(aText: string, bText: string): { rows: DiffRow[]; truncated: boolean } {
  const A = aText.split('\n');
  const B = bText.split('\n');
  const m = A.length;
  const n = B.length;

  if (m * n > MAX_LCS_CELLS) {
    const rows: DiffRow[] = B.map((line, i) => ({ type: 'add', line, newN: i + 1 }));
    return { rows, truncated: true };
  }

  const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (A[i - 1] === B[j - 1]) dp[i]![j]! = dp[i - 1]![j - 1]! + 1;
      else dp[i]![j]! = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }

  const rows: DiffRow[] = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (A[i - 1] === B[j - 1]) {
      rows.push({ type: 'eq', line: A[i - 1]!, oldN: i, newN: j });
      i--; j--;
    } else if (dp[i - 1]![j]! > dp[i]![j - 1]!) {
      // Strict `>` so that on ties we descend into the ADD branch first.
      // Because we backtrack from end→start and reverse at the end, this
      // flips the final output to the conventional "deletions before
      // additions" ordering git diff uses.
      rows.push({ type: 'del', line: A[i - 1]!, oldN: i });
      i--;
    } else {
      rows.push({ type: 'add', line: B[j - 1]!, newN: j });
      j--;
    }
  }
  while (i > 0) { rows.push({ type: 'del', line: A[i - 1]!, oldN: i }); i--; }
  while (j > 0) { rows.push({ type: 'add', line: B[j - 1]!, newN: j }); j--; }

  return { rows: rows.reverse(), truncated: false };
}

type SplitCell = { line: string; num: number; type: 'eq' | 'add' | 'del' } | null;
type SplitRow =
  | { kind: 'pair'; left: SplitCell; right: SplitCell }
  | { kind: 'skip'; count: number };
type UnifiedRow = DiffRow | { type: 'skip'; count: number };

function toSplitRows(rows: DiffRow[]): SplitRow[] {
  const out: SplitRow[] = [];
  let i = 0;
  while (i < rows.length) {
    const r = rows[i]!;
    if (r.type === 'eq') {
      out.push({
        kind: 'pair',
        left: { line: r.line, num: r.oldN, type: 'eq' },
        right: { line: r.line, num: r.newN, type: 'eq' },
      });
      i++;
      continue;
    }
    const dels: Extract<DiffRow, { type: 'del' }>[] = [];
    const adds: Extract<DiffRow, { type: 'add' }>[] = [];
    while (i < rows.length && rows[i]!.type !== 'eq') {
      const cur = rows[i]!;
      if (cur.type === 'del') dels.push(cur);
      else if (cur.type === 'add') adds.push(cur);
      i++;
    }
    const max = Math.max(dels.length, adds.length);
    for (let k = 0; k < max; k++) {
      const d = dels[k];
      const a = adds[k];
      out.push({
        kind: 'pair',
        left: d ? { line: d.line, num: d.oldN, type: 'del' } : null,
        right: a ? { line: a.line, num: a.newN, type: 'add' } : null,
      });
    }
  }
  return out;
}

function collapseContext(rows: DiffRow[], context = 3): UnifiedRow[] {
  const out: UnifiedRow[] = [];
  const changeIdx = new Set<number>();
  rows.forEach((r, idx) => { if (r.type !== 'eq') changeIdx.add(idx); });
  const keep = new Array(rows.length).fill(false);
  for (const idx of changeIdx) {
    for (let k = idx - context; k <= idx + context; k++) {
      if (k >= 0 && k < rows.length) keep[k] = true;
    }
  }
  let skipCount = 0;
  for (let i = 0; i < rows.length; i++) {
    if (keep[i]) {
      if (skipCount > 0) { out.push({ type: 'skip', count: skipCount }); skipCount = 0; }
      out.push(rows[i]!);
    } else {
      skipCount++;
    }
  }
  if (skipCount > 0) out.push({ type: 'skip', count: skipCount });
  return out;
}

function collapseSplitContext(pairs: SplitRow[], context = 3): SplitRow[] {
  const out: SplitRow[] = [];
  const changeIdx = new Set<number>();
  pairs.forEach((p, idx) => {
    if (p.kind === 'pair' && (p.left?.type !== 'eq' || p.right?.type !== 'eq')) changeIdx.add(idx);
  });
  const keep = new Array(pairs.length).fill(false);
  for (const idx of changeIdx) {
    for (let k = idx - context; k <= idx + context; k++) {
      if (k >= 0 && k < pairs.length) keep[k] = true;
    }
  }
  let skipCount = 0;
  for (let i = 0; i < pairs.length; i++) {
    if (keep[i]) {
      if (skipCount > 0) { out.push({ kind: 'skip', count: skipCount }); skipCount = 0; }
      out.push(pairs[i]!);
    } else {
      skipCount++;
    }
  }
  if (skipCount > 0) out.push({ kind: 'skip', count: skipCount });
  return out;
}

interface DiffViewProps {
  original: string;
  current: string;
  /** Unified (one column, `+`/`-` prefix) or split (side-by-side). Default `unified`. */
  mode?: 'unified' | 'split';
  /** Show unchanged lines too? Default false — only hunks + 3-line context. */
  showAllContext?: boolean;
  /** Wrap long lines in unified mode. Default false (horizontal scroll). Split
   *  mode always wraps since column widths are too narrow for overflow. */
  wrap?: boolean;
  /** When set, the outer container caps its height and scrolls internally. */
  maxHeight?: number | string;
  /** Extra classes merged into the outer scroll container. */
  className?: string;
}

/**
 * Pure diff renderer — takes two strings and shows colored line-level diff.
 * Used standalone inline (permission cards, tool bubbles) or wrapped by a
 * full-screen modal.
 */
export function DiffView({
  original,
  current,
  mode = 'unified',
  showAllContext = false,
  wrap = false,
  maxHeight,
  className = '',
}: DiffViewProps) {
  const { rows, truncated } = useMemo(() => diffLines(original, current), [original, current]);

  const unifiedDisplay = useMemo(
    () => (showAllContext ? rows : collapseContext(rows, 3)),
    [rows, showAllContext],
  );

  const splitDisplay = useMemo<SplitRow[]>(() => {
    if (mode !== 'split') return [];
    const pairs = toSplitRows(rows);
    return showAllContext ? pairs : collapseSplitContext(pairs, 3);
  }, [mode, rows, showAllContext]);

  return (
    <div
      className={`overflow-auto bg-black/40 ${className}`}
      style={maxHeight != null ? { maxHeight } : undefined}
    >
      {truncated && (
        <div className="px-3 py-1.5 text-[10px] text-amber-400/80 bg-amber-500/5 border-b border-amber-500/20">
          File too large for full diff — showing current contents only.
        </div>
      )}
      {rows.length === 0 ? (
        <div className="px-3 py-3 text-[11px] text-zinc-500 text-center">No differences.</div>
      ) : mode === 'split' ? (
        <div className="font-mono text-[11px] leading-5">
          {splitDisplay.map((row, i) => {
            if (row.kind === 'skip') {
              return (
                <div
                  key={`skip-${i}`}
                  className="px-2 py-0.5 text-zinc-600 text-center bg-zinc-900/50 border-y border-white/5 select-none"
                >
                  … {row.count} unchanged line{row.count === 1 ? '' : 's'}
                </div>
              );
            }
            const renderCell = (cell: SplitCell) => {
              if (!cell) {
                return <div className="flex-1 min-w-0 bg-white/[0.02] border-l-2 border-transparent" />;
              }
              const bg =
                cell.type === 'add' ? 'bg-green-500/10 border-l-2 border-green-500/60' :
                cell.type === 'del' ? 'bg-red-500/10 border-l-2 border-red-500/60' :
                'border-l-2 border-transparent';
              const text =
                cell.type === 'add' ? 'text-green-100' :
                cell.type === 'del' ? 'text-red-100' :
                'text-zinc-400';
              return (
                <div className={`flex-1 min-w-0 flex ${bg}`}>
                  <span className="shrink-0 w-7 text-right pr-1 text-zinc-600 text-[10px] select-none tabular-nums">
                    {cell.num}
                  </span>
                  <span className={`${text} whitespace-pre-wrap break-all flex-1 pr-1`}>
                    {cell.line || ' '}
                  </span>
                </div>
              );
            };
            return (
              <div key={i} className="flex border-b border-white/[0.03]">
                {renderCell(row.left)}
                <div className="shrink-0 w-px bg-white/10 self-stretch" />
                {renderCell(row.right)}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="font-mono text-[11px] leading-5">
          {unifiedDisplay.map((row, i) => {
            if (row.type === 'skip') {
              return (
                <div
                  key={`skip-${i}`}
                  className="px-2 py-0.5 text-zinc-600 text-center bg-zinc-900/50 border-y border-white/5 select-none"
                >
                  … {row.count} unchanged line{row.count === 1 ? '' : 's'}
                </div>
              );
            }
            const bg =
              row.type === 'add' ? 'bg-green-500/10 border-l-2 border-green-500/60' :
              row.type === 'del' ? 'bg-red-500/10 border-l-2 border-red-500/60' :
              'border-l-2 border-transparent';
            const text =
              row.type === 'add' ? 'text-green-100' :
              row.type === 'del' ? 'text-red-100' :
              'text-zinc-400';
            const prefix = row.type === 'add' ? '+' : row.type === 'del' ? '−' : ' ';
            const oldN = row.type === 'eq' || row.type === 'del' ? String((row as any).oldN) : '';
            const newN = row.type === 'eq' || row.type === 'add' ? String((row as any).newN) : '';
            return (
              <div key={i} className={`${bg} flex`}>
                <span className="shrink-0 w-8 text-right pr-1 text-zinc-600 text-[10px] select-none tabular-nums">{oldN}</span>
                <span className="shrink-0 w-8 text-right pr-1 text-zinc-600 text-[10px] select-none tabular-nums border-r border-white/5">{newN}</span>
                <span className="shrink-0 w-4 text-center text-zinc-500 select-none">{prefix}</span>
                <span className={`${text} ${wrap ? 'whitespace-pre-wrap break-all' : 'whitespace-pre'} flex-1 pr-2`}>
                  {row.line || ' '}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Cheap summary counts — caller can show "+12 −4" without waiting for the
 * full render path. Uses the same LCS under the hood, so prefer calling this
 * via `useMemo` if you already have the diff computed elsewhere.
 */
export function diffCounts(original: string, current: string): { added: number; removed: number } {
  const { rows } = diffLines(original, current);
  let added = 0, removed = 0;
  for (const r of rows) {
    if (r.type === 'add') added++;
    else if (r.type === 'del') removed++;
  }
  return { added, removed };
}
