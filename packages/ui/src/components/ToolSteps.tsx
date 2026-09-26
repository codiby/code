import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, Eye, FilePlus, Pencil, Play, Search, Sparkles, Wrench, X, ExternalLink } from 'lucide-react';
import type { ChatMessage } from '../lib/claude-client';
import {
  basename,
  buildToolSteps,
  formatDuration,
  lineDiff,
  type DiffLine,
  type FileChange,
  type ToolStep,
} from '../lib/tool-steps';
import { detectOutputLanguage, languageFromPath } from '../lib/output-language';
import { highlightCode, highlightLines } from '../lib/highlight';
import { AnsiText } from './MessageBubble';

/** Past the fold, a finished run shows only its last few lines. */
const FOLD_AFTER = 5;
const FOLD_KEEP = 3;
const MAX_READ_CHIPS = 6;
const MAX_DIFF_ROWS = 3000;

// ---------------------------------------------------------------------------
// Theme

/** The app themes by toggling `light` on <html>; the diff tints are picked
 *  from it because Tailwind's accent colours don't remap. */
function useIsLight(): boolean {
  const [light, setLight] = useState(() => document.documentElement.classList.contains('light'));
  useEffect(() => {
    const root = document.documentElement;
    const obs = new MutationObserver(() => setLight(root.classList.contains('light')));
    obs.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  return light;
}

interface Palette {
  add: string;
  del: string;
  addBg: string;
  delBg: string;
  addMark: string;
  delMark: string;
  lineNo: string;
  /** Icon tint per kind of step. */
  read: string;
  search: string;
  edit: string;
  create: string;
  bash: string;
}

const DARK: Palette = {
  add: '#3fb950', del: '#f85149',
  addBg: 'rgba(46,160,67,.13)', delBg: 'rgba(248,81,73,.11)',
  addMark: 'rgba(46,160,67,.30)', delMark: 'rgba(248,81,73,.28)',
  lineNo: '#4b4c55',
  read: '#38bdf8', search: '#fbbf24', edit: '#a78bfa', create: '#4ade80', bash: '#71717a',
};

const LIGHT: Palette = {
  add: '#1a7f37', del: '#cf222e',
  addBg: 'rgba(26,127,55,.10)', delBg: 'rgba(207,34,46,.09)',
  addMark: 'rgba(26,127,55,.22)', delMark: 'rgba(207,34,46,.20)',
  lineNo: '#b0b3bb',
  read: '#0284c7', search: '#b45309', edit: '#7c3aed', create: '#15803d', bash: '#9ca3af',
};

function usePalette(): Palette {
  return useIsLight() ? LIGHT : DARK;
}

// ---------------------------------------------------------------------------
// Chat → window bridges

function sendToChat(text: string) {
  window.dispatchEvent(new CustomEvent('codiby-code:send-message', { detail: { text } }));
}

function openFile(path: string, line?: number | null) {
  window.dispatchEvent(new CustomEvent('codiby-code:open-file', { detail: { path, line: line ?? undefined } }));
}

/** `…/ui/src/components/` — enough of the directory to tell two files apart. */
function shortDir(path: string): string {
  const parts = path.split('/').filter(Boolean);
  parts.pop();
  if (parts.length === 0) return '';
  const tail = parts.slice(-3).join('/');
  return (parts.length > 3 ? '…/' : '') + tail + '/';
}

// ---------------------------------------------------------------------------
// Steps

type WindowState =
  | { type: 'diff'; stepId: string; path: string }
  | { type: 'output'; stepId: string };

/**
 * One line per thing the agent did: `Read a.ts b.ts`, `Edited TabBar.tsx +62 −8`,
 * `▶ bun test  12 passed`. Files and commands are chips; clicking one opens the
 * diff or the command's output in a window over the chat instead of unfolding
 * it inside the thread.
 */
export function ToolSteps({ items, hasContentAfter }: { items: ChatMessage[]; hasContentAfter?: boolean }) {
  const all = useMemo(() => buildToolSteps(items), [items]);
  // Finished reasoning isn't a line of its own — it rides on the step it led
  // to, as that step's tooltip. Only live thinking gets a line.
  const { steps, reasoning } = useMemo(() => {
    const out: ToolStep[] = [];
    const why = new Map<string, string>();
    let pending: string[] = [];
    for (const s of all) {
      if (s.kind === 'thought' && !s.running) {
        if (s.text.trim()) pending.push(s.text.trim());
        continue;
      }
      if (pending.length) { why.set(s.id, pending.join('\n\n')); pending = []; }
      out.push(s);
    }
    return { steps: out, reasoning: why };
  }, [all]);
  const [win, setWin] = useState<WindowState | null>(null);
  const [showAll, setShowAll] = useState(false);

  if (steps.length === 0) return null;

  const folded = !showAll && !!hasContentAfter && steps.length > FOLD_AFTER;
  const visible = folded ? steps.slice(-FOLD_KEEP) : steps;
  const openStep = win ? steps.find(s => s.id === win.stepId) : undefined;

  return (
    <div className="py-1 select-none">
      {folded && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="flex items-center gap-2 min-h-[22px] text-[11.5px] text-zinc-700 hover:text-zinc-500 transition-colors"
        >
          <span className="w-4 text-center">⋯</span>
          {steps.length - FOLD_KEEP} more
        </button>
      )}
      {visible.map(step => (
        <StepLine
          key={step.id}
          step={step}
          why={reasoning.get(step.id)}
          selectedPath={win?.type === 'diff' && win.stepId === step.id ? win.path : null}
          onOpenDiff={(path) => setWin({ type: 'diff', stepId: step.id, path })}
          onOpenOutput={() => setWin({ type: 'output', stepId: step.id })}
        />
      ))}
      {win?.type === 'diff' && openStep?.kind === 'change' && (
        <DiffWindow
          files={openStep.files}
          path={win.path}
          onPath={(path) => setWin({ ...win, path })}
          onClose={() => setWin(null)}
        />
      )}
      {win?.type === 'output' && (openStep?.kind === 'bash' || openStep?.kind === 'other') && (
        <OutputWindow step={openStep} onClose={() => setWin(null)} />
      )}
    </div>
  );
}

/** Tooltip-sized slice of the reasoning behind a step. */
function clip(text: string, max = 700): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function Line({
  icon, tone, running, why, children,
}: { icon: ReactNode; tone: string; running?: boolean; why?: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 min-h-[24px] py-[2px] text-[12.5px] text-zinc-500">
      <span
        title={why ? clip(why) : undefined}
        className={`w-4 h-5 flex items-center justify-center shrink-0 ${running ? 'text-teal-400 animate-pulse' : ''} ${why ? 'cursor-help' : ''}`}
        style={running ? undefined : { color: tone }}
      >
        {icon}
      </span>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0 leading-5">{children}</div>
    </div>
  );
}

/** The only boxed thing in a step: a file the agent changed. */
const chipBase =
  'inline-flex items-center gap-1.5 h-5 px-1.5 rounded-[5px] bg-surface-light border font-mono text-[11.5px] text-zinc-300 whitespace-nowrap max-w-[26rem] min-w-0 overflow-hidden';

function Chip({
  children, title, onClick, selected,
}: { children: ReactNode; title?: string; onClick: () => void; selected?: boolean }) {
  const border = selected ? 'border-zinc-500' : 'border-transparent';
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`${chipBase} ${border} hover:border-border-light hover:bg-surface-lighter transition-colors cursor-pointer`}
    >
      {children}
    </button>
  );
}

/** Secondary detail — files read, a pattern, a command: mono, quiet, still clickable. */
function Quiet({ children, title, onClick }: { children: ReactNode; title?: string; onClick?: () => void }) {
  const cls = 'font-mono text-[11.5px] text-zinc-500 truncate max-w-[30rem]';
  if (!onClick) return <span title={title} className={cls}>{children}</span>;
  return (
    <button type="button" title={title} onClick={onClick} className={`${cls} hover:text-zinc-300 transition-colors text-left`}>
      {children}
    </button>
  );
}

function Counts({ added, removed }: { added: number; removed: number }) {
  const p = usePalette();
  return (
    <>
      {added > 0 && <span className="shrink-0" style={{ color: p.add }}>+{added}</span>}
      {removed > 0 && <span className="shrink-0" style={{ color: p.del }}>−{removed}</span>}
    </>
  );
}

function Dim({ children }: { children: ReactNode }) {
  return <span className="text-[11.5px] text-zinc-600">{children}</span>;
}

function StepLine({
  step, why, selectedPath, onOpenDiff, onOpenOutput,
}: {
  step: ToolStep;
  why?: string;
  selectedPath: string | null;
  onOpenDiff: (path: string) => void;
  onOpenOutput: () => void;
}) {
  const p = usePalette();

  switch (step.kind) {
    case 'read': {
      const shown = step.files.slice(0, MAX_READ_CHIPS);
      return (
        <Line icon={<Eye size={13} />} tone={p.read} running={step.running} why={why}>
          <span>{step.running ? 'Reading' : 'Read'}</span>
          {shown.map(f => (
            <Quiet key={f} title={f} onClick={() => openFile(f)}>{basename(f)}</Quiet>
          ))}
          {step.files.length > shown.length && <Dim>+{step.files.length - shown.length}</Dim>}
        </Line>
      );
    }

    case 'search':
      return (
        <Line icon={<Search size={13} />} tone={p.search} running={step.running} why={why}>
          <span>{step.running ? 'Searching' : 'Searched'}</span>
          {step.queries.map((q, i) => (
            <span key={i} className="inline-flex items-center gap-1.5 min-w-0">
              <Quiet title={q.pattern}>"{q.pattern}"</Quiet>
              {q.matches != null && <Dim>{q.matches}</Dim>}
            </span>
          ))}
        </Line>
      );

    case 'change': {
      const edited = step.files.filter(f => !f.created);
      const created = step.files.filter(f => f.created);
      const chip = (f: FileChange) => (
        <Chip key={f.path} title={f.path} selected={selectedPath === f.path} onClick={() => onOpenDiff(f.path)}>
          <span className="truncate">{basename(f.path)}</span>
          {f.error ? <span style={{ color: p.del }}>failed</span> : <Counts added={f.added} removed={f.removed} />}
        </Chip>
      );
      return (
        <>
          {edited.length > 0 && (
            <Line icon={<Pencil size={12} />} tone={p.edit} running={step.running} why={why}>
              <span>{step.running ? 'Editing' : 'Edited'}</span>
              {edited.map(chip)}
            </Line>
          )}
          {created.length > 0 && (
            <Line icon={<FilePlus size={13} />} tone={p.create} running={step.running} why={edited.length ? undefined : why}>
              <span>{step.running ? 'Creating' : 'Created'}</span>
              {created.map(chip)}
            </Line>
          )}
        </>
      );
    }

    case 'bash': {
      const duration = formatDuration(step.durationMs);
      return (
        <Line icon={<Play size={10} fill="currentColor" />} tone={p.bash} running={step.running} why={why}>
          <Quiet title={step.command} onClick={onOpenOutput}>{step.short}</Quiet>
          {step.running && <Dim>running…</Dim>}
          {step.outcome && (
            <span className="font-mono text-[11.5px] shrink-0" style={{ color: step.outcome.ok ? p.add : p.del }}>
              {step.outcome.text}
            </span>
          )}
          {duration && <Dim>{duration}</Dim>}
        </Line>
      );
    }

    case 'thought':
      // Only live reasoning reaches here; finished thoughts ride on the next step.
      return (
        <Line icon={<Sparkles size={12} />} tone={p.bash} running>
          <span className="italic thinking-sweep">Thinking…</span>
        </Line>
      );

    case 'other':
      return (
        <Line icon={<Wrench size={12} />} tone={p.bash} running={step.running} why={why}>
          <button type="button" onClick={onOpenOutput} className="hover:text-zinc-300 transition-colors">
            {step.name}
          </button>
          {step.summary && <Quiet title={step.summary}>{step.summary}</Quiet>}
          {step.failed && <span className="font-mono text-[11.5px]" style={{ color: p.del }}>failed</span>}
        </Line>
      );
  }
}

// ---------------------------------------------------------------------------
// Window shell

function ToolWindow({
  title, actions, children, footer, onClose, onKey,
}: {
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  onKey?: (e: KeyboardEvent) => void;
}) {
  const onKeyRef = useRef(onKey);
  onKeyRef.current = onKey;
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      onKeyRef.current?.(e);
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[1000] flex items-start justify-center pt-[8vh] px-6 select-text">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[1.5px]" onClick={onClose} />
      <div className="relative w-full max-w-[960px] h-[min(620px,80vh)] flex flex-col rounded-xl overflow-hidden bg-surface border border-border shadow-2xl shadow-black/40">
        <div className="h-10 shrink-0 flex items-center gap-3 pl-4 pr-2 border-b border-border">
          <div className="flex items-center gap-2 min-w-0 flex-1 text-[12.5px]">{title}</div>
          {actions}
          <button
            type="button"
            onClick={onClose}
            title="Close (Esc)"
            className="w-7 h-7 flex items-center justify-center rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-surface-light transition-colors"
          >
            <X size={14} />
          </button>
        </div>
        <div className="flex-1 min-h-0 flex">{children}</div>
        {footer}
      </div>
    </div>,
    document.body,
  );
}

/** "Tell the agent about this" — a one-line composer at the bottom of a window. */
function WindowComposer({ placeholder, build, onSent }: { placeholder: string; build: (text: string) => string; onSent: () => void }) {
  const [text, setText] = useState('');
  const send = () => {
    const t = text.trim();
    if (!t) return;
    sendToChat(build(t));
    setText('');
    onSent();
  };
  return (
    <div className="h-12 shrink-0 flex items-center gap-2 px-3 border-t border-border">
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) { e.preventDefault(); send(); }
        }}
        placeholder={placeholder}
        className="flex-1 h-8 px-3 rounded-lg bg-base border border-border text-[12.5px] text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-border-light"
      />
      <button
        type="button"
        disabled={!text.trim()}
        onClick={send}
        className="h-8 px-3 rounded-lg bg-zinc-100 text-zinc-900 text-[12px] font-medium disabled:opacity-40 transition-opacity"
      >
        Send to chat
      </button>
    </div>
  );
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="flex p-px rounded-md border border-border">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={`h-6 px-2.5 rounded-[5px] text-[11.5px] transition-colors ${value === v ? 'bg-surface-light text-zinc-200 font-medium' : 'text-zinc-500 hover:text-zinc-300'}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function WindowButton({ onClick, children, title }: { onClick: () => void; children: ReactNode; title?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="h-7 px-2 flex items-center gap-1.5 rounded-md text-[12px] text-zinc-500 hover:text-zinc-200 hover:bg-surface-light transition-colors"
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Diff window

type Mode = 'unified' | 'split';

function DiffWindow({
  files, path, onPath, onClose,
}: { files: FileChange[]; path: string; onPath: (p: string) => void; onClose: () => void }) {
  const [mode, setMode] = useState<Mode>('unified');
  const file = files.find(f => f.path === path) ?? files[0]!;
  const idx = files.indexOf(file);
  const firstLine = file.edits.find(e => e.startLine != null)?.startLine ?? null;
  const lang = languageFromPath(file.path);
  const hunks = useMemo(() => file.edits.map(e => ({
    rows: lineDiff(e.oldText, e.newText, e.startLine),
    oldHtml: lang ? highlightLines(e.oldText, lang) : null,
    newHtml: lang ? highlightLines(e.newText, lang) : null,
  })), [file, lang]);

  const step = (delta: number) => {
    const next = files[(idx + delta + files.length) % files.length];
    if (next) onPath(next.path);
  };

  return (
    <ToolWindow
      onClose={onClose}
      onKey={(e) => {
        if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); step(1); }
        else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
      }}
      title={
        <>
          <span className="text-zinc-600">{file.created ? 'Created' : 'Edited'}</span>
          <span className="font-semibold text-zinc-100">{basename(file.path)}</span>
          <span className="font-mono text-[11.5px] flex gap-1.5"><Counts added={file.added} removed={file.removed} /></span>
          <span className="font-mono text-[11px] text-zinc-600 truncate">{shortDir(file.path)}</span>
        </>
      }
      actions={
        <>
          <Segmented value={mode} options={[['unified', 'Unified'], ['split', 'Split']]} onChange={setMode} />
          <WindowButton onClick={() => { openFile(file.path, firstLine); onClose(); }} title="Open the file in the editor">
            <ExternalLink size={12} /> Open in editor
          </WindowButton>
        </>
      }
      footer={
        <WindowComposer
          placeholder={`Comment on this change for the agent…`}
          build={(t) => `About the change to \`${file.path}\`${firstLine ? ` (around line ${firstLine})` : ''}:\n\n${t}`}
          onSent={onClose}
        />
      }
    >
      {files.length > 1 && (
        <div className="w-56 shrink-0 border-r border-border p-2 overflow-auto bg-base/40">
          <div className="px-2 pt-1 pb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">In this step</div>
          {files.map(f => (
            <button
              key={f.path}
              type="button"
              title={f.path}
              onClick={() => onPath(f.path)}
              className={`w-full h-7 px-2 flex items-center gap-2 rounded-md font-mono text-[11.5px] text-left transition-colors ${f === file ? 'bg-surface-lighter text-zinc-100' : 'text-zinc-300 hover:bg-surface-light'}`}
            >
              <span className="flex-1 truncate">{basename(f.path)}</span>
              {f.error ? <span className="text-red-500">!</span> : <span className="flex gap-1.5"><Counts added={f.added} removed={f.removed} /></span>}
            </button>
          ))}
          <div className="px-2 pt-4 text-[11px] leading-6 text-zinc-600">
            <Kbd>J</Kbd> <Kbd>K</Kbd> file · <Kbd>Esc</Kbd> close
          </div>
        </div>
      )}
      <div className="flex-1 min-w-0 overflow-auto font-mono text-[12px] leading-[1.7] text-zinc-300">
        {file.error && (
          <div className="m-3 px-3 py-2 rounded-md border border-red-500/30 bg-red-500/10 text-[12px] text-red-400 whitespace-pre-wrap font-sans">
            {file.error}
          </div>
        )}
        {hunks.map((h, i) => (
          <DiffHunk
            key={i}
            label={file.edits.length > 1 ? `Edit ${i + 1} of ${file.edits.length}` : null}
            rows={h.rows}
            oldHtml={h.oldHtml}
            newHtml={h.newHtml}
            startLine={file.edits[i]!.startLine}
            mode={mode}
          />
        ))}
      </div>
    </ToolWindow>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return <span className="px-1 rounded bg-surface-lighter text-zinc-500 text-[10px] font-medium">{children}</span>;
}

/** Common prefix/suffix of a replaced line, so only the part that changed gets marked. */
function changedSpan(a: string, b: string): [number, number, number] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  return [pre, suf, 0];
}

function Marked({ text, other, color }: { text: string; other: string | null; color: string }) {
  if (other == null || !text) return <>{text || ' '}</>;
  const [pre, suf] = changedSpan(text, other);
  const mid = text.slice(pre, text.length - suf);
  // A line that changed wholesale reads better unmarked than fully marked.
  if (!mid || mid.length > text.length * 0.8) return <>{text}</>;
  return (
    <>
      {text.slice(0, pre)}
      <mark style={{ background: color, color: 'inherit', borderRadius: 2 }}>{mid}</mark>
      {text.slice(text.length - suf)}
    </>
  );
}

/** A deleted line immediately replaced by one added line is a modification —
 *  pair them so the changed part of each can be marked. */
function partners(rows: DiffLine[]): Map<number, number> {
  const map = new Map<number, number>();
  let i = 0;
  while (i < rows.length) {
    if (rows[i]!.kind !== 'del') { i++; continue; }
    let d = i;
    while (d < rows.length && rows[d]!.kind === 'del') d++;
    let a = d;
    while (a < rows.length && rows[a]!.kind === 'add') a++;
    const dels = d - i;
    const adds = a - d;
    if (dels === adds) for (let k = 0; k < dels; k++) { map.set(i + k, d + k); map.set(d + k, i + k); }
    i = a;
  }
  return map;
}

function DiffHunk({
  rows, oldHtml, newHtml, label, startLine, mode,
}: {
  rows: DiffLine[];
  /** Each side highlighted as a whole, one entry per line (`highlightLines`). */
  oldHtml: string[] | null;
  newHtml: string[] | null;
  label: string | null;
  startLine: number | null;
  mode: Mode;
}) {
  const p = usePalette();
  const clipped = useMemo(() => (rows.length > MAX_DIFF_ROWS ? rows.slice(0, MAX_DIFF_ROWS) : rows), [rows]);
  const pairs = useMemo(() => partners(clipped), [clipped]);
  // Walk the rows to find which line of which side each one shows.
  const html = useMemo(() => {
    if (!oldHtml || !newHtml) return null;
    const map = new Map<DiffLine, string>();
    let ai = 0;
    let bi = 0;
    for (const r of rows) {
      if (r.kind === 'del') map.set(r, oldHtml[ai++] ?? '');
      else { map.set(r, newHtml[bi++] ?? ''); if (r.kind === 'ctx') ai++; }
    }
    return map;
  }, [rows, oldHtml, newHtml]);
  const code = (r: DiffLine, other: string | null) => {
    const h = html?.get(r);
    if (h != null) return <span className="dd-code" dangerouslySetInnerHTML={{ __html: h || ' ' }} />;
    return r.kind === 'ctx' ? (r.text || ' ') : <Marked text={r.text} other={other} color={mark(r.kind)} />;
  };
  // Without a label or a known line there is nothing to say above the rows.
  const header = (label || startLine) ? (
    <div className="sticky top-0 z-10 flex justify-between px-4 py-1 text-[11px] text-zinc-600 bg-surface-light border-b border-border">
      <span>{label ?? `Line ${startLine}`}</span>
      {label && startLine && <span>line {startLine}</span>}
    </div>
  ) : null;
  const bg = (k: DiffLine['kind']) => (k === 'add' ? p.addBg : k === 'del' ? p.delBg : undefined);
  const sign = (k: DiffLine['kind']) => (k === 'add' ? '+' : k === 'del' ? '−' : '');
  const mark = (k: DiffLine['kind']) => (k === 'add' ? p.addMark : p.delMark);

  const more = rows.length - clipped.length;

  if (mode === 'split') {
    const left: (DiffLine | null)[] = [];
    const right: (DiffLine | null)[] = [];
    let i = 0;
    while (i < clipped.length) {
      const r = clipped[i]!;
      if (r.kind === 'ctx') { left.push(r); right.push(r); i++; continue; }
      const dels: DiffLine[] = [];
      const adds: DiffLine[] = [];
      while (i < clipped.length && clipped[i]!.kind === 'del') dels.push(clipped[i++]!);
      while (i < clipped.length && clipped[i]!.kind === 'add') adds.push(clipped[i++]!);
      const n = Math.max(dels.length, adds.length);
      for (let k = 0; k < n; k++) { left.push(dels[k] ?? null); right.push(adds[k] ?? null); }
    }
    const cell = (r: DiffLine | null, other: DiffLine | null, side: 'old' | 'new', key: number) => (
      <div key={key} className="grid grid-cols-[40px_16px_1fr] whitespace-pre min-h-[20px]" style={{ background: r ? bg(r.kind) : undefined }}>
        <span className="text-right pr-2 text-[11px] select-none" style={{ color: p.lineNo }}>{r ? (side === 'old' ? r.oldNo : r.newNo) ?? '' : ''}</span>
        <span className="select-none" style={{ color: r?.kind === 'add' ? p.add : p.del }}>{r ? sign(r.kind) : ''}</span>
        <span className="pr-3">
          {r && code(r, other && other.kind !== 'ctx' ? other.text : null)}
        </span>
      </div>
    );
    return (
      <div className="border-b border-border">
        {header}
        <div className="grid grid-cols-2">
          <div className="border-r border-border overflow-x-auto">{left.map((r, k) => cell(r, right[k] ?? null, 'old', k))}</div>
          <div className="overflow-x-auto">{right.map((r, k) => cell(r, left[k] ?? null, 'new', k))}</div>
        </div>
        {more > 0 && <div className="px-4 py-1 text-[11px] text-zinc-600">… {more} more lines</div>}
      </div>
    );
  }

  return (
    <div className="border-b border-border">
      {header}
      {clipped.map((r, i) => {
        const partner = pairs.get(i);
        return (
          <div key={i} className="grid grid-cols-[44px_44px_18px_1fr] whitespace-pre min-h-[20px]" style={{ background: bg(r.kind) }}>
            <span className="text-right pr-2.5 text-[11px] select-none" style={{ color: p.lineNo }}>{r.oldNo ?? ''}</span>
            <span className="text-right pr-2.5 text-[11px] select-none" style={{ color: p.lineNo }}>{r.newNo ?? ''}</span>
            <span className="select-none" style={{ color: r.kind === 'add' ? p.add : p.del }}>{sign(r.kind)}</span>
            <span className="pr-4">
              {code(r, partner != null ? clipped[partner]!.text : null)}
            </span>
          </div>
        );
      })}
      {more > 0 && <div className="px-4 py-1 text-[11px] text-zinc-600">… {more} more lines</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Output window (shell commands and any other tool)

function OutputWindow({
  step, onClose,
}: { step: Extract<ToolStep, { kind: 'bash' | 'other' }>; onClose: () => void }) {
  const p = usePalette();
  const [copied, setCopied] = useState(false);
  const isBash = step.kind === 'bash';
  const output = isBash ? step.output : step.message.toolResult?.content ?? '';
  const input = isBash
    ? null
    : typeof step.message.toolInput === 'string'
      ? step.message.toolInput
      : JSON.stringify(step.message.toolInput ?? {}, null, 2);
  const duration = isBash ? formatDuration(step.durationMs) : null;
  const failed = isBash ? step.failed || (step.outcome ? !step.outcome.ok : false) : step.failed;
  const label = isBash ? step.short : step.name;
  const command = isBash ? step.command : undefined;
  // `sed … a.tsx` prints TSX, a tool returning JSON returns JSON: colour it
  // like the editor would. Anything unsure stays plain (or keeps its ANSI).
  const lang = useMemo(() => (step.running ? '' : detectOutputLanguage(output, command)), [step.running, output, command]);
  const highlighted = useMemo(() => (lang ? highlightCode(output, lang) : null), [lang, output]);

  const copy = () => {
    void navigator.clipboard?.writeText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <ToolWindow
      onClose={onClose}
      title={
        <>
          <span className="text-zinc-600">{isBash ? 'Bash' : 'Tool'}</span>
          <span className="font-mono text-[12px] text-zinc-100 truncate">{label}</span>
          {step.running
            ? <span className="text-[11.5px] text-zinc-500">running…</span>
            : isBash && step.outcome
              ? <span className="font-mono text-[11.5px]" style={{ color: step.outcome.ok ? p.add : p.del }}>{step.outcome.text}</span>
              : failed
                ? <span className="font-mono text-[11.5px]" style={{ color: p.del }}>failed</span>
                : null}
          {duration && <span className="text-[11.5px] text-zinc-600">{duration}</span>}
        </>
      }
      actions={
        <>
        {lang && <span className="px-1.5 h-5 flex items-center rounded bg-surface-light font-mono text-[10.5px] text-zinc-500">{lang}</span>}
        <WindowButton onClick={copy} title="Copy output">
          {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'Copied' : 'Copy'}
        </WindowButton>
        </>
      }
      footer={
        <WindowComposer
          placeholder="Tell the agent something about this output…"
          build={(t) => `About the output of \`${label}\`:\n\n${t}`}
          onSent={onClose}
        />
      }
    >
      <div className="flex-1 min-w-0 overflow-auto bg-base/40 px-4 py-3 font-mono text-[12px] leading-[1.65] text-zinc-300 whitespace-pre-wrap break-all">
        {isBash && <div className="text-zinc-500 mb-2">$ {step.command}</div>}
        {input && (
          <>
            <div className="text-[10px] font-sans font-semibold uppercase tracking-wider text-zinc-600 mb-1">Input</div>
            <div className="text-zinc-400 mb-4">{input}</div>
            <div className="text-[10px] font-sans font-semibold uppercase tracking-wider text-zinc-600 mb-1">Result</div>
          </>
        )}
        {highlighted
          ? <div className="dd-code" dangerouslySetInnerHTML={{ __html: highlighted }} />
          : output
            ? <AnsiText text={output} />
            : <span className="text-zinc-600">{step.running ? 'Waiting for output…' : 'No output'}</span>}
      </div>
    </ToolWindow>
  );
}
