/**
 * Renders a ```diffdoc block as a typeset figure inside the agent's answer.
 *
 * The point of the format is that the change reads as *part of the document*:
 * no tool header, no result footer, no card. What frames it is a hairline in
 * the margin and a caption with the path — the same grammar as a block quote —
 * and prose notes can sit between the hunks, right against the lines they
 * explain. See lib/diff-doc.ts for the grammar.
 */

import { memo, useMemo, useState } from 'react';
import { highlightCode, normalizeLang } from '../lib/highlight';
import { renderInlineSubset } from '../lib/inline-md';
import {
  diffDocToCode,
  parseDiffDoc,
  type DiffDocBlock,
  type DiffDocCodeRow,
} from '../lib/diff-doc';

/**
 * Wrap the plain-text range [start, end) of already-highlighted HTML in a
 * `<mark>`. Offsets are counted in *rendered* characters, so tags are skipped
 * and an entity counts as one. A range crossing a token boundary is emitted as
 * several marks rather than one that would straddle the tag — the visual result
 * is identical and the markup stays well-formed.
 */
function wrapRange(html: string, start: number, end: number): string {
  if (end <= start) return html;
  const OPEN = '<mark class="dd-mark">';
  let out = '';
  let pos = 0;
  let open = false;
  let i = 0;

  while (i < html.length) {
    if (html[i] === '<') {
      const close = html.indexOf('>', i);
      const tag = html.slice(i, close < 0 ? html.length : close + 1);
      if (open) {
        out += '</mark>';
        open = false;
      }
      out += tag;
      i += tag.length;
      continue;
    }

    let len = 1;
    if (html[i] === '&') {
      const semi = html.indexOf(';', i);
      if (semi > i && semi - i <= 8) len = semi - i + 1;
    }
    if (pos >= start && pos < end && !open) {
      out += OPEN;
      open = true;
    }
    out += html.slice(i, i + len);
    pos++;
    i += len;
    if (open && pos >= end) {
      out += '</mark>';
      open = false;
    }
  }

  return open ? out + '</mark>' : out;
}

const renderNoteHtml = (text: string) => renderInlineSubset(text, 'dd-note-code', 'dd-note-strong');

function openFile(path: string, line?: number) {
  window.dispatchEvent(new CustomEvent('codiby-code:open-file', { detail: { path, line } }));
}

/** Caption: dimmed directory, emphasised basename, +/− stat, hover actions. */
function Caption({ block }: { block: DiffDocBlock }) {
  const [copied, setCopied] = useState(false);
  const slash = block.path.lastIndexOf('/');
  const dir = slash >= 0 ? block.path.slice(0, slash + 1) : '';
  const name = slash >= 0 ? block.path.slice(slash + 1) : block.path;

  const copy = () => {
    navigator.clipboard?.writeText(diffDocToCode(block)).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  return (
    <figcaption className="flex items-baseline gap-2.5 mb-1.5">
      <button
        type="button"
        onClick={() => openFile(block.path)}
        title={`Open ${block.path}`}
        className="font-mono text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors truncate"
      >
        {dir}
        <span className="text-zinc-300 font-medium">{name}</span>
      </button>
      <span className="font-mono text-[10.5px] shrink-0 tabular-nums">
        <span className="dd-stat-add">+{block.added}</span>
        <span className="dd-stat-del ml-1.5">−{block.removed}</span>
      </span>
      <span className="ml-auto flex gap-0.5 opacity-0 group-hover/dd:opacity-100 transition-opacity shrink-0">
        <button
          type="button"
          onClick={copy}
          className="px-1.5 py-0.5 rounded text-[10.5px] text-zinc-500 hover:text-zinc-200 hover:bg-surface-light transition-colors"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          type="button"
          onClick={() => openFile(block.path)}
          className="px-1.5 py-0.5 rounded text-[10.5px] text-zinc-500 hover:text-zinc-200 hover:bg-surface-light transition-colors"
        >
          Open
        </button>
      </span>
    </figcaption>
  );
}

/**
 * Two gutters — pre-change and post-change line numbers — because a single one
 * would print the same number twice across a removal/addition pair and leave
 * the reader guessing which side it meant. Only the post-change number is
 * clickable: it is the line that still exists on disk to jump to.
 */
function CodeRow({ row, grammar, path }: { row: DiffDocCodeRow; grammar: string; path: string }) {
  const html = useMemo(() => {
    const base = highlightCode(row.code, grammar);
    return row.mark ? wrapRange(base, row.mark.start, row.mark.end) : base;
  }, [row.code, row.mark?.start, row.mark?.end, grammar]);

  const sigil = row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' ';

  return (
    <div className={`dd-row dd-row-${row.kind}`}>
      <span className="dd-ln">{row.oldNo}</span>
      {row.newNo === null ? (
        <span className="dd-ln" />
      ) : (
        <button type="button" className="dd-ln dd-ln-link" onClick={() => openFile(path, row.newNo ?? undefined)}>
          {row.newNo}
        </button>
      )}
      <span className="dd-sg">{sigil}</span>
      <code className="dd-code" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

export const DiffDoc = memo(function DiffDoc({ source }: { source: string }) {
  const block = useMemo(() => parseDiffDoc(source), [source]);
  const grammar = useMemo(() => normalizeLang(block.lang), [block.lang]);

  // Malformed block: fall back to the raw source as a diff-highlighted code
  // block. A broken figure would lose the agent's content; this keeps it.
  if (block.error) {
    return (
      <pre
        className="my-2 text-[11px] bg-[#0d0d0d] border border-border rounded px-3 py-2 font-mono overflow-x-auto leading-snug language-diff"
        title={`diffdoc: ${block.error}`}
      >
        <code
          className="language-diff"
          dangerouslySetInnerHTML={{ __html: highlightCode(source, 'diff') }}
        />
      </pre>
    );
  }

  return (
    <figure className="dd group/dd">
      <Caption block={block} />
      <div className="dd-body">
        {block.rows.map((row, i) => {
          if (row.kind === 'note') {
            return (
              <div key={i} className="dd-note">
                <span className="dd-note-rule" aria-hidden />
                <span dangerouslySetInnerHTML={{ __html: renderNoteHtml(row.text) }} />
              </div>
            );
          }
          if (row.kind === 'gap') {
            return (
              <div key={i} className="dd-gap">
                <span className="dd-gap-dots" aria-hidden>⋯</span>
                {row.count > 0 ? `${row.count} unchanged lines` : 'unchanged lines'}
              </div>
            );
          }
          return <CodeRow key={i} row={row} grammar={grammar} path={block.path} />;
        })}
      </div>
    </figure>
  );
});

/** Placeholder while the closing fence of a streaming block hasn't arrived. */
export function DiffDocPending() {
  return (
    <figure className="dd">
      <div className="dd-pending">
        <span className="dd-pending-bar" aria-hidden />
        <span className="dd-pending-bar" aria-hidden />
        <span className="dd-pending-bar" aria-hidden />
      </div>
    </figure>
  );
}
