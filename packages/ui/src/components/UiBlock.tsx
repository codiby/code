/**
 * Renders a ```ui block: a visual explanation inside the agent's answer.
 *
 * No frame, no header, no "source" toggle — each piece reads as part of the
 * message, like a list or a table would. The look belongs to the app: the
 * agent only picks components and fills them (grammar in lib/ui-block.ts).
 * `cx-html` is the escape hatch for what no component covers; it runs in a
 * sandboxed iframe (scripts, but no same-origin, so no access to the app) and
 * receives the theme as CSS variables so free HTML still matches the chat.
 */

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { renderInlineSubset } from '../lib/inline-md';
import { parseUiBlock, type UiNode, type UiTone } from '../lib/ui-block';

const inline = (text: string) => renderInlineSubset(text, 'font-mono text-[11px] text-violet-300 bg-surface-lighter px-1 py-px rounded', 'text-zinc-200 font-semibold');

const TONE_BG: Record<UiTone, string> = {
  accent: 'bg-violet-400', red: 'bg-red-400', amber: 'bg-amber-400', green: 'bg-green-400', blue: 'bg-blue-400', muted: 'bg-zinc-500',
};

function Label({ text }: { text: string }) {
  if (!text) return null;
  return <div className="text-[10.5px] uppercase tracking-[0.07em] font-semibold text-zinc-500 mb-2">{text}</div>;
}

function Callout({ node }: { node: Extract<UiNode, { kind: 'callout' }> }) {
  const style = {
    warn: { box: 'bg-amber-400/10 border-amber-400', icon: 'text-amber-400', glyph: '!' },
    info: { box: 'bg-blue-400/10 border-blue-400', icon: 'text-blue-400', glyph: 'i' },
    ok: { box: 'bg-green-400/10 border-green-400', icon: 'text-green-400', glyph: '✓' },
  }[node.tone];
  return (
    <div className={`flex gap-2.5 px-3 py-2 rounded-lg border-l-[3px] ${style.box}`}>
      <span className={`font-bold ${style.icon}`} aria-hidden>{style.glyph}</span>
      <div dangerouslySetInnerHTML={{ __html: inline(node.text) }} />
    </div>
  );
}

function Flow({ node }: { node: Extract<UiNode, { kind: 'flow' }> }) {
  const [cur, setCur] = useState(() => Math.max(0, node.steps.findIndex(s => s.hot)));
  const step = node.steps[Math.min(cur, node.steps.length - 1)];
  return (
    <div>
      <Label text={node.label} />
      <div className="flex items-stretch">
        {node.steps.map((s, i) => (
          <div key={i} className="contents">
            {i > 0 && <div className="flex items-center px-1.5 text-zinc-600" aria-hidden>→</div>}
            <button
              type="button"
              onClick={() => setCur(i)}
              className={`flex-1 min-w-0 text-left px-2.5 py-2 rounded-lg border transition-colors ${i === cur ? 'border-violet-400 bg-violet-400/10' : 'border-border bg-surface hover:border-border-light'}`}
            >
              <div className="flex items-center gap-1.5 font-semibold text-zinc-200 truncate">
                {s.hot && <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" aria-label="hot path" />}
                {s.title}
              </div>
              {s.sub && <div className="text-[10.5px] text-zinc-500 font-mono truncate">{s.sub}</div>}
            </button>
          </div>
        ))}
      </div>
      {step?.text && <div className="mt-2 px-0.5 text-zinc-400 min-h-[2.4em]" dangerouslySetInnerHTML={{ __html: inline(step.text) }} />}
    </div>
  );
}

function Bars({ node }: { node: Extract<UiNode, { kind: 'bars' }> }) {
  const [view, setView] = useState(0);
  const max = Math.max(1, ...node.bars.flatMap(b => b.values));
  // Percentages fill the track against 100; anything else against its own max.
  const scale = node.unit === '%' ? Math.max(100, max) : max;
  return (
    <div>
      <Label text={node.label} />
      {node.views.length > 1 && (
        <div className="inline-flex bg-surface border border-border rounded-lg p-0.5 mb-3">
          {node.views.map((v, i) => (
            <button key={i} type="button" onClick={() => setView(i)}
              className={`px-3 py-1 rounded-md text-[11.5px] transition-colors ${i === view ? 'bg-surface-lighter text-zinc-200' : 'text-zinc-400 hover:text-zinc-300'}`}>
              {v}
            </button>
          ))}
        </div>
      )}
      <div className="grid grid-cols-[minmax(80px,max-content)_1fr_auto] gap-x-3 gap-y-2 items-center">
        {node.bars.map((b, i) => (
          <div key={i} className="contents">
            <div className="text-zinc-400 truncate">{b.label}</div>
            <div className="h-2 bg-surface-lighter rounded overflow-hidden">
              <div className={`h-full rounded ${TONE_BG[b.tone]} transition-[width] duration-500 ease-out`} style={{ width: `${(b.values[view] / scale) * 100}%` }} />
            </div>
            <div className="font-mono text-[11px] text-zinc-400 text-right tabular-nums">{b.values[view]}{node.unit}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Stats({ node }: { node: Extract<UiNode, { kind: 'stats' }> }) {
  return (
    <div>
      <Label text={node.label} />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-2.5">
        {node.stats.map((s, i) => (
          <div key={i} className="bg-surface border border-border rounded-lg px-3 py-2">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-[17px] font-semibold text-zinc-100 tabular-nums">{s.value}</span>
              {s.delta && <span className={`text-[11.5px] font-semibold ${s.trend === 'good' ? 'text-green-400' : s.trend === 'bad' ? 'text-red-400' : 'text-zinc-400'}`}>{s.delta}</span>}
            </div>
            <div className="text-[11px] text-zinc-500">{s.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

const STATUS_STYLE: Record<string, string> = {
  M: 'text-amber-400 bg-amber-400/10', A: 'text-green-400 bg-green-400/10', D: 'text-red-400 bg-red-400/10',
};

function Files({ node }: { node: Extract<UiNode, { kind: 'files' }> }) {
  const open = (path: string) => window.dispatchEvent(new CustomEvent('codiby-code:open-file', { detail: { path } }));
  return (
    <div>
      <Label text={node.label} />
      <div className="bg-surface border border-border rounded-lg py-1.5">
        {node.files.map((f, i) => (
          <div key={i} className="flex items-center gap-2.5 px-3 py-0.5">
            <button type="button" onClick={() => open(f.path)} className="font-mono text-[11.5px] text-zinc-300 hover:text-violet-300 truncate text-left">{f.path}</button>
            <span className="flex-1 text-zinc-500 truncate">{f.note}</span>
            {f.status && <span className={`font-mono text-[10px] px-1.5 rounded ${STATUS_STYLE[f.status] || 'text-zinc-400 bg-surface-lighter'}`}>{f.status}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

function readAnswer(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function Choice({ node, storageKey }: { node: Extract<UiNode, { kind: 'choice' }>; storageKey: string }) {
  const [sent, setSent] = useState<string | null>(() => readAnswer(storageKey));
  const [picked, setPicked] = useState<string | null>(sent);
  const send = () => {
    if (!picked || sent) return;
    const text = node.label ? `${node.label}: ${picked}` : picked;
    try { localStorage.setItem(storageKey, picked); } catch { /* private mode */ }
    setSent(picked);
    window.dispatchEvent(new CustomEvent('codiby-code:send-message', { detail: { text } }));
  };
  return (
    <div>
      <Label text={node.label} />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-2.5">
        {node.choices.map((c, i) => {
          const on = picked === c.title;
          return (
            <button key={i} type="button" disabled={!!sent} onClick={() => setPicked(c.title)}
              className={`text-left p-3 rounded-lg border bg-surface transition-all ${on ? 'border-violet-400 ring-[3px] ring-violet-400/15' : 'border-border-light hover:border-violet-400/60'} ${sent && !on ? 'opacity-40' : ''} disabled:cursor-default`}>
              <div className="flex items-center gap-1.5 font-semibold text-zinc-200">
                {c.title}
                {c.recommended && <span className="text-[9.5px] font-semibold text-green-400 bg-green-400/10 rounded px-1.5">Recommended</span>}
              </div>
              {c.text && <div className="mt-1 text-[11.5px] text-zinc-400" dangerouslySetInnerHTML={{ __html: inline(c.text) }} />}
            </button>
          );
        })}
      </div>
      <div className="flex justify-end mt-2.5">
        <button type="button" onClick={send} disabled={!picked || !!sent}
          className="px-3.5 py-1.5 rounded-md text-[11.5px] font-semibold bg-violet-400 text-zinc-950 disabled:opacity-30 disabled:cursor-default">
          {sent ? 'Sent' : picked ? `Send: ${picked}` : 'Send'}
        </button>
      </div>
    </div>
  );
}

/** App tokens exposed to `cx-html`, under short names the prompt documents. */
const THEME_VARS: [string, string, string][] = [
  ['--bg', '--color-base', '#0f1012'],
  ['--surface', '--color-surface', '#17181b'],
  ['--surface-2', '--color-surface-light', '#1c1d21'],
  ['--surface-3', '--color-surface-lighter', '#25262d'],
  ['--border', '--color-border', '#2a2b30'],
  ['--border-2', '--color-border-light', '#3a3b40'],
  ['--text', '--color-zinc-200', '#e4e4e7'],
  ['--text-2', '--color-zinc-400', '#a1a1aa'],
  ['--muted', '--color-zinc-500', '#71717a'],
  ['--accent', '--color-violet-400', '#a78bfa'],
  ['--red', '--color-red-400', '#f87171'],
  ['--amber', '--color-amber-400', '#fbbf24'],
  ['--green', '--color-green-400', '#4ade80'],
  ['--blue', '--color-blue-400', '#60a5fa'],
  ['--font', '--font-sans', 'ui-sans-serif, system-ui, sans-serif'],
  ['--mono', '--font-mono', 'ui-monospace, Menlo, monospace'],
];

function themeCss(): string {
  const cs = typeof document !== 'undefined' ? getComputedStyle(document.documentElement) : null;
  const light = typeof document !== 'undefined' && document.documentElement.classList.contains('light');
  const vars = THEME_VARS.map(([name, src, fallback]) => `${name}:${cs?.getPropertyValue(src).trim() || fallback}`).join(';');
  return `:root{${vars};color-scheme:${light ? 'light' : 'dark'}}`;
}

/** Re-render when the app switches between light and dark. */
function useThemeKey(): number {
  const [key, setKey] = useState(0);
  useEffect(() => {
    const obs = new MutationObserver(() => setKey(k => k + 1));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  return key;
}

const MAX_HTML_HEIGHT = 1600;

function HtmlFrame({ html }: { html: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(80);
  const themeKey = useThemeKey();
  const srcDoc = useMemo(() => `<!doctype html><html><head><meta charset="utf-8"><style>${themeCss()}
html,body{margin:0;background:transparent;color:var(--text);font:12px/1.6 var(--font);overflow:hidden}
code{font-family:var(--mono)}</style></head><body>${html}
<script>(()=>{const post=()=>parent.postMessage({cxUiHeight:Math.ceil(document.documentElement.getBoundingClientRect().height)},'*');new ResizeObserver(post).observe(document.documentElement);addEventListener('load',post);post()})()</script></body></html>`,
  // themeKey is a trigger: themeCss() reads the live document, not a value.
  [html, themeKey]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow) return;
      const h = Number((e.data as { cxUiHeight?: unknown } | null)?.cxUiHeight);
      if (Number.isFinite(h) && h > 0) setHeight(Math.min(MAX_HTML_HEIGHT, h));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return (
    <iframe
      ref={ref}
      title="Agent visual"
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      className="block w-full border-0 bg-transparent"
      style={{ height }}
    />
  );
}

export const UiBlock = memo(function UiBlock({ source, blockId, renderMd }: {
  source: string;
  /** Stable per block within the thread; keys a choice's answer so it survives remounts. */
  blockId: string;
  renderMd: (text: string) => string;
}) {
  const nodes = useMemo(() => parseUiBlock(source), [source]);
  if (!nodes.length) return <pre className="text-[11px] text-zinc-500 whitespace-pre-wrap">{source}</pre>;
  return (
    <div className="my-1 flex flex-col gap-4">
      {nodes.map((node, i) => {
        switch (node.kind) {
          case 'md': return <div key={i} dangerouslySetInnerHTML={{ __html: renderMd(node.text) }} />;
          case 'callout': return <Callout key={i} node={node} />;
          case 'flow': return <Flow key={i} node={node} />;
          case 'bars': return <Bars key={i} node={node} />;
          case 'stats': return <Stats key={i} node={node} />;
          case 'files': return <Files key={i} node={node} />;
          case 'choice': return <Choice key={i} node={node} storageKey={`codiby-ui-choice:${blockId}:${i}`} />;
          case 'html': return <HtmlFrame key={i} html={node.html} />;
        }
      })}
    </div>
  );
});

export function UiBlockPending() {
  return (
    <div className="my-1 flex flex-col gap-2" aria-label="Drawing…">
      <div className="h-3 w-2/5 rounded bg-surface-lighter animate-pulse" />
      <div className="h-16 rounded-lg bg-surface-light animate-pulse" />
    </div>
  );
}
