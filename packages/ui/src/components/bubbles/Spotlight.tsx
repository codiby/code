/**
 * Quick launcher (⌥Space) rendered inside the bubble overlay: a centered,
 * Spotlight-style composer that starts a session in one of the recent project
 * folders. Enter hands the result to BubbleApp, which flies it into the bubble
 * stack; ⌘Enter opens it as a regular tab instead.
 *
 * The first row, selected on every open, is Disposable: a throwaway question
 * that runs in $HOME and archives itself after the chosen idle time.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { GitBranch, Timer } from 'lucide-react';
import type { ClaudeClient, SessionInfo } from '../../lib/claude-client';
import { getRecentDirs } from '../../lib/recent-dirs';

/** Shared with GroupComposer so both remember the same last provider. */
export const PROVIDER_KEY = 'claude-ui-last-provider';
const PROVIDERS = [
  { key: 'claude', label: 'Claude' },
  { key: 'codex', label: 'Codex' },
  { key: 'opencode', label: 'OpenCode' },
] as const;
const MAX_RESULTS = 6;
const TTL_KEY = 'claude-ui-disposable-ttl';
const HOUR = 60 * 60_000;
/** Must match DISPOSABLE_TTLS_MS on the bridge, which rejects anything else. */
const TTLS = [{ ms: HOUR, label: '1h' }, { ms: 24 * HOUR, label: '24h' }, { ms: 7 * 24 * HOUR, label: '7d' }] as const;

/** `disposableTtlMs` set → a disposable; `cwd` is then only a display stand-in,
 *  the bridge runs it in the user's home directory. */
export type Launch = { prompt: string; cwd: string; provider: string; mode: 'bubble' | 'tab'; disposableTtlMs?: number };

export const basename = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;
const tildify = (p: string) => p.replace(/^\/(Users|home)\/[^/]+/, '~');

export function Spotlight({
  client, sessions, colorFor, launching, onClose, onLaunch,
}: {
  client: ClaudeClient | null;
  sessions: SessionInfo[];
  colorFor: (cwd: string) => string;
  /** Enter was pressed: the card hands off to the flying orb and the scrim fades. */
  launching?: boolean;
  onClose: () => void;
  /** `card` is where the composer sat, so the launch animation starts there. */
  onLaunch: (launch: Launch, card: DOMRect) => void;
}) {
  const [text, setText] = useState('');
  // 0 is the Disposable row while it's shown; folders follow it.
  const [sel, setSel] = useState(0);
  const [ttl, setTtl] = useState(() => {
    const i = TTLS.findIndex(t => String(t.ms) === localStorage.getItem(TTL_KEY));
    return i === -1 ? 1 : i;
  });
  const [shown, setShown] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [flip, setFlip] = useState(false);
  const [shake, setShake] = useState(false);
  const [branch, setBranch] = useState<string | null>(null);
  const [provider, setProvider] = useState<string>(() => {
    const stored = localStorage.getItem(PROVIDER_KEY);
    return PROVIDERS.some(p => p.key === stored) ? stored! : 'claude';
  });
  const cardRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const r = requestAnimationFrame(() => setShown(true));
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    return () => { cancelAnimationFrame(r); clearTimeout(t); };
  }, []);

  // Last used folder first, then folders of recently active local sessions.
  const projects = useMemo(() => {
    const out: string[] = [];
    const push = (d?: string | null) => { if (d && !out.includes(d)) out.push(d); };
    getRecentDirs(null).forEach(push);
    [...sessions]
      .filter(s => !s.remoteId && s.cwd)
      .sort((a, b) => b.updated_at - a.updated_at)
      .forEach(s => push(s.cwd));
    return out;
  }, [sessions]);

  // `@query` at the end of the prompt searches the folder list.
  const query = text.match(/(?:^|\s)@(\S*)$/)?.[1] ?? null;
  const results = useMemo(() => {
    const q = query?.toLowerCase();
    const list = q ? projects.filter(p => p.toLowerCase().includes(q)) : projects;
    return list.slice(0, MAX_RESULTS);
  }, [projects, query]);
  // An `@` search is asking for a folder, so Disposable steps aside.
  const withDisposable = query === null;
  const rows = (withDisposable ? 1 : 0) + results.length;
  const disposable = withDisposable && sel === 0;
  const cwd = disposable ? null : results[Math.min(sel - (withDisposable ? 1 : 0), results.length - 1)] ?? null;
  const openDisposables = useMemo(
    () => sessions.filter(s => s.disposable_ttl_ms && s.status === 'open').length,
    [sessions],
  );

  useEffect(() => { setSel(0); }, [query]);

  useEffect(() => {
    setBranch(null);
    if (!client || !cwd) return;
    let dead = false;
    const t = setTimeout(() => {
      client.getGitInfo(cwd).then(i => { if (!dead) setBranch(i.is_git ? i.branch ?? null : null); }).catch(() => {});
    }, 120);
    return () => { dead = true; clearTimeout(t); };
  }, [client, cwd]);

  const close = () => {
    if (leaving) return;
    setLeaving(true);
    setTimeout(onClose, 220);
  };

  const cycleProvider = () => {
    setFlip(true);
    setTimeout(() => {
      setProvider(p => PROVIDERS[(PROVIDERS.findIndex(x => x.key === p) + 1) % PROVIDERS.length]!.key);
      setFlip(false);
    }, 160);
  };

  const pickTtl = (i: number) => {
    setTtl(i);
    setSel(0);
    try { localStorage.setItem(TTL_KEY, String(TTLS[i]!.ms)); } catch {}
  };

  const submit = (mode: Launch['mode']) => {
    const prompt = text.replace(/(?:^|\s)@\S*$/, '').trim();
    if (!prompt || (!cwd && !disposable) || !cardRef.current) {
      setShake(true);
      setTimeout(() => setShake(false), 400);
      return;
    }
    const card = cardRef.current.getBoundingClientRect();
    if (disposable) onLaunch({ prompt, cwd: '~', provider, mode, disposableTtlMs: TTLS[ttl]!.ms }, card);
    else onLaunch({ prompt, cwd: cwd!, provider, mode }, card);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(rows - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(0, s - 1)); }
    // ←/→ pick the lifetime, but only where the caret has nowhere to go, so
    // they still move through the prompt while it's being written.
    else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && disposable && !e.shiftKey && !e.altKey && !e.metaKey) {
      const el = e.currentTarget;
      const back = e.key === 'ArrowLeft';
      const atEdge = el.selectionStart === el.selectionEnd && el.selectionStart === (back ? 0 : el.value.length);
      const next = ttl + (back ? -1 : 1);
      if (atEdge && next >= 0 && next < TTLS.length) { e.preventDefault(); pickTtl(next); }
    }
    else if (e.key === 'Tab' && e.shiftKey && disposable) { e.preventDefault(); pickTtl((ttl + 1) % TTLS.length); }
    else if (e.key === 'Tab') { e.preventDefault(); cycleProvider(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(e.metaKey || e.ctrlKey ? 'tab' : 'bubble'); }
  };

  const energy = Math.min(1, text.trim().length / 40);
  const on = shown && !leaving && !launching;
  const providerLabel = PROVIDERS.find(p => p.key === provider)?.label ?? provider;

  return (
    <>
      <style>{CSS}</style>
      <div data-hit="" className={`sp-scrim ${on ? 'on' : ''}`} onMouseDown={close} />
      <div className={`sp-stage ${on ? 'on' : ''} ${disposable ? 'eph' : ''}`}>
        <div ref={cardRef} data-hit="" className={`sp-card ${shake ? 'shake' : ''}`}
          style={{ '--energy': energy, visibility: launching ? 'hidden' : undefined } as React.CSSProperties}
        >
          <div className="sp-aura" />
          <div className="sp-rim" />
          <div className="sp-inner">
            <div className="sp-top">
              <div className="sp-spark">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.9 6.1L20 10l-6.1 1.9L12 18l-1.9-6.1L4 10l6.1-1.9z" /><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z" /></svg>
              </div>
              <textarea
                ref={inputRef}
                rows={1}
                value={text}
                placeholder="What should we do? It opens as a bubble…"
                onChange={e => setText(e.target.value)}
                onKeyDown={onKeyDown}
              />
              <div className={`sp-enter ${energy > 0 ? 'ready' : ''}`}><kbd>↵</kbd></div>
            </div>

            <div className="sp-chips">
              {!disposable && (
                <span className="sp-chip">
                  <span className="sp-dot" style={{ background: cwd ? colorFor(cwd) : '#555' }} />
                  {cwd ? basename(cwd) : 'No recent folder'}
                </span>
              )}
              {!disposable && branch && <span className="sp-chip"><GitBranch size={12} />{branch}</span>}
              <button className="sp-chip sp-prov" onClick={cycleProvider} title="Switch provider (Tab)">
                <span className={`sp-lbl ${flip ? 'flip' : ''}`}>{providerLabel}</span>
              </button>
              <span className="sp-chip sp-bubble">🫧 opens as a bubble</span>
            </div>

            <div className="sp-sec">{query !== null ? `Folders matching “${query}”` : 'Project'}</div>
            <ul className="sp-results">
              {withDisposable && (
                <>
                  <li className={`sp-eph-row ${disposable ? 'on' : ''}`} onMouseDown={e => { e.preventDefault(); setSel(0); }}>
                    <span className="sp-ic sp-eph-ic"><Timer size={14} /></span>
                    <span className="min-w-0">
                      <div className="sp-nm">Disposable</div>
                      <div className="sp-pt truncate">
                        No project · archives after <b>{TTLS[ttl]!.label}</b> idle{openDisposables ? ` · ${openDisposables} open` : ''}
                      </div>
                    </span>
                    <span className="sp-ttl">
                      {TTLS.map((t, i) => (
                        <span key={t.ms} className={i === ttl ? 'on' : ''}
                          onMouseDown={e => { e.preventDefault(); e.stopPropagation(); pickTtl(i); }}
                        >{t.label}</span>
                      ))}
                    </span>
                  </li>
                  <div className="sp-sep" />
                </>
              )}
              {results.map((p, i) => (
                <li
                  key={p}
                  className={i + (withDisposable ? 1 : 0) === sel ? 'on' : ''}
                  style={{ animationDelay: `${(i + 1) * 35}ms` }}
                  onMouseDown={e => { e.preventDefault(); setSel(i + (withDisposable ? 1 : 0)); }}
                >
                  <span className="sp-ic" style={{ background: colorFor(p) }}>{basename(p).slice(0, 2).toUpperCase()}</span>
                  <span className="min-w-0">
                    <div className="sp-nm">{basename(p)}</div>
                    <div className="sp-pt truncate">{tildify(p)}</div>
                  </span>
                </li>
              ))}
              {results.length === 0 && !withDisposable && <li className="sp-empty">No matching folders</li>}
            </ul>

            <div className="sp-foot">
              <span><kbd>↵</kbd> Send to bubble</span>
              <span><kbd>⌘↵</kbd> Open in tab</span>
              <span><kbd>⇥</kbd> Provider</span>
              {disposable
                ? <span className="sp-hl"><kbd>←→</kbd> <kbd>⇧⇥</kbd> Lifetime</span>
                : <span><kbd>↑↓</kbd> Folder · <kbd>@</kbd> search</span>}
              <span className="sp-r"><kbd>esc</kbd></span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

const CSS = `
@property --sp-a { syntax: '<angle>'; inherits: false; initial-value: 0deg; }
@keyframes sp-rot { to { --sp-a: 360deg; } }
.sp-scrim { position: absolute; inset: 0; opacity: 0; transition: opacity .35s cubic-bezier(.16,1,.3,1);
  background: radial-gradient(900px 520px at 50% 40%, rgba(200,149,107,.12), transparent 70%), rgba(6,7,10,.55); }
.sp-scrim.on { opacity: 1; }
.sp-stage { position: absolute; left: 50%; top: 38%; width: min(680px, calc(100vw - 48px)); transform: translate(-50%, -50%); pointer-events: none; }
.sp-card { position: relative; opacity: 0; transform: translateY(18px) scale(.94); filter: blur(10px);
  transition: opacity .28s cubic-bezier(.16,1,.3,1), transform .6s cubic-bezier(.34,1.56,.64,1), filter .35s cubic-bezier(.16,1,.3,1); }
.sp-stage.on .sp-card { opacity: 1; transform: none; filter: none; }
.sp-card.shake { animation: sp-shake .4s; }
@keyframes sp-shake { 20%,60% { translate: -8px 0; } 40%,80% { translate: 8px 0; } }
.sp-aura { position: absolute; inset: -60px; z-index: -2; border-radius: 60px; filter: blur(50px); opacity: calc(.35 + var(--energy, 0) * .5);
  background: conic-gradient(from var(--sp-a), #c8956b, #bb9af7, #7aa2f7, #73daca, #c8956b); animation: sp-rot 6s linear infinite; transition: opacity .3s; }
.sp-rim { position: absolute; inset: 0; z-index: -1; border-radius: 22px; padding: 1.5px;
  background: conic-gradient(from var(--sp-a), rgba(200,149,107,.9), rgba(187,154,247,.6), rgba(122,162,247,.9), rgba(115,218,202,.5), rgba(200,149,107,.9));
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask-composite: exclude; animation: sp-rot 4s linear infinite; }
.sp-inner { border-radius: 22px; background: rgba(20,21,26,.94); box-shadow: 0 40px 120px rgba(0,0,0,.6), inset 0 1px 0 rgba(255,255,255,.06); overflow: hidden; }
.sp-top { display: flex; align-items: flex-start; gap: 12px; padding: 18px 18px 12px 20px; }
.sp-spark { width: 26px; height: 26px; flex: none; margin-top: 2px; border-radius: 8px; display: grid; place-items: center; color: #140f0a;
  background: linear-gradient(135deg, #c8956b, #bb9af7); box-shadow: 0 0 calc(8px + var(--energy, 0) * 18px) rgba(200,149,107,.6); }
.sp-top textarea { flex: 1; resize: none; border: 0; outline: 0; background: none; color: #f2f2f5; font: 500 19px/1.45 var(--font-sans);
  min-height: 30px; max-height: 180px; field-sizing: content; caret-color: #c8956b; -webkit-user-select: text; user-select: text; }
.sp-top textarea::placeholder { color: #5e606b; }
.sp-root kbd, .sp-card kbd { font-family: var(--font-mono); font-size: 10.5px; padding: 2px 6px; border-radius: 5px; background: rgba(255,255,255,.08);
  border: 1px solid rgba(255,255,255,.12); border-bottom-width: 2px; color: #cfd0d6; }
.sp-enter { align-self: center; opacity: .45; transition: .2s; }
.sp-enter.ready { opacity: 1; }
.sp-enter.ready kbd { background: rgba(200,149,107,.18); border-color: rgba(200,149,107,.5); color: #f1d3bb; }
.sp-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 18px 14px 58px; }
.sp-chip { display: flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 999px; background: rgba(255,255,255,.05);
  border: 1px solid rgba(255,255,255,.07); color: #b9bac3; font-size: 12px; }
.sp-dot { width: 8px; height: 8px; border-radius: 50%; }
.sp-prov { overflow: hidden; cursor: pointer; }
.sp-prov:hover { background: rgba(255,255,255,.09); color: #fff; }
.sp-lbl { display: inline-block; transition: transform .35s cubic-bezier(.34,1.56,.64,1), opacity .2s; }
.sp-lbl.flip { transform: translateY(-120%); opacity: 0; }
.sp-bubble { border-color: rgba(200,149,107,.35); color: #e9c7ab; background: rgba(200,149,107,.1); }
.sp-sec { padding: 10px 20px 6px; font-size: 10.5px; letter-spacing: .09em; text-transform: uppercase; color: #5f616c; font-weight: 600; border-top: 1px solid rgba(255,255,255,.05); }
.sp-results { list-style: none; margin: 0; padding: 0 8px 8px; }
.sp-results li { position: relative; display: flex; align-items: center; gap: 11px; padding: 8px 12px; border-radius: 12px; color: #aeb0b9; cursor: pointer;
  opacity: 0; transform: translateY(6px); animation: sp-rin .45s cubic-bezier(.16,1,.3,1) forwards; }
@keyframes sp-rin { to { opacity: 1; transform: none; } }
.sp-results li.on { background: rgba(255,255,255,.06); color: #fff; }
.sp-results li.on::before { content: ""; position: absolute; left: 0; top: 9px; bottom: 9px; width: 3px; border-radius: 3px; background: #c8956b; }
.sp-results .sp-empty { cursor: default; color: #5f616c; }
.sp-ic { width: 28px; height: 28px; flex: none; border-radius: 9px; display: grid; place-items: center; font-size: 11px; font-weight: 700; color: #111; }
.sp-nm { color: #e6e6ea; font-weight: 500; font-size: 13px; }
.sp-pt { font-family: var(--font-mono); font-size: 11px; color: #5f616c; }
.sp-foot { display: flex; gap: 16px; align-items: center; padding: 10px 20px; border-top: 1px solid rgba(255,255,255,.05); font-size: 11.5px; color: #6c6e79; background: rgba(0,0,0,.18); }
.sp-foot span { display: flex; gap: 6px; align-items: center; }
.sp-r { margin-left: auto; }
.sp-hl { color: #bff0e6; }
/* Disposable selected: teal instead of amber, dashed rim — reads as "temporary". */
.sp-stage.eph .sp-aura { opacity: calc(.18 + var(--energy, 0) * .3); background: conic-gradient(from var(--sp-a), #73daca, #7aa2f7, #2a2c34, #73daca); }
.sp-stage.eph .sp-rim { background: repeating-conic-gradient(from var(--sp-a), rgba(115,218,202,.85) 0 6deg, transparent 6deg 12deg); }
.sp-stage.eph .sp-spark { background: linear-gradient(135deg, #73daca, #7aa2f7); box-shadow: 0 0 calc(8px + var(--energy, 0) * 18px) rgba(115,218,202,.5); }
.sp-stage.eph .sp-top textarea { caret-color: #73daca; }
.sp-stage.eph .sp-enter.ready kbd { background: rgba(115,218,202,.14); border-color: rgba(115,218,202,.45); color: #bff0e6; }
.sp-stage.eph .sp-results li.on::before { background: #73daca; }
.sp-eph-ic { background: transparent; border: 1.5px dashed rgba(115,218,202,.55); color: #73daca; }
.sp-eph-row .sp-nm { color: #bff0e6; }
.sp-eph-row .sp-pt b { color: #8fbfb6; font-weight: 500; }
.sp-sep { height: 1px; margin: 4px 12px; background: rgba(255,255,255,.05); }
.sp-ttl { margin-left: auto; display: flex; gap: 2px; padding: 2px; border-radius: 7px; background: rgba(0,0,0,.25); border: 1px solid rgba(255,255,255,.06); transition: opacity .2s; }
.sp-ttl span { font-family: var(--font-mono); font-size: 10.5px; padding: 2px 6px; border-radius: 5px; color: #6c6e79; }
.sp-ttl span:hover { color: #cfd0d6; }
.sp-ttl span.on { background: rgba(115,218,202,.16); color: #bff0e6; }
.sp-results li:not(.on) .sp-ttl { opacity: 0; }
`;
