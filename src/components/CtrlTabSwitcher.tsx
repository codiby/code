/**
 * Ctrl+Tab session switcher.
 *
 * macOS-style hold-to-show overlay: Ctrl+Tab opens it and pre-selects the
 * second-most-recently-used session (so a single Ctrl+Tab + release swaps
 * to the previous session). Repeat-Tab advances the highlight, Shift+Tab
 * goes back, Esc cancels, releasing Ctrl commits.
 *
 * Layout matches the `ctrl-tab-switcher` mockup: 800x460 modal, compact
 * grouped list on the left, chat preview on the right. Sessions awaiting
 * permission pulse a soft red halo so the eye catches them in a glance.
 */

import { useEffect, useMemo, useRef } from 'react';
import type { ChatMessage, SessionInfo } from '../lib/claude-client';
import { GROUP_HEX_COLOR, type TabGroupInfo } from '../lib/tab-groups';

interface SwitcherSessionState {
  messages: ChatMessage[];
  isStreaming: boolean;
  permRequest: unknown;
}

interface Props {
  open: boolean;
  /** Sessions in MRU order — most recently active first. The host (ChatApp)
   *  owns MRU bookkeeping; the switcher just renders the given order. */
  sessions: SessionInfo[];
  selectedIdx: number;
  sessionStates: Record<string, SwitcherSessionState>;
  /** Last message activity per session — used for the "now / 3m / 2h" age
   *  label on each row. */
  sessionLastMessageAt: Record<string, number>;
  tabGroups: Record<string, TabGroupInfo>;
  tabGroupMap: Record<string, string>;
  /** Hover/keyboard nav. Parent owns the index so it can be advanced from
   *  the global keydown handler too. */
  onSelectIdx: (idx: number) => void;
  /** Commit the highlight — picks `sessions[selectedIdx]`. */
  onCommit: () => void;
  /** Esc / backdrop click. */
  onClose: () => void;
}

const UNGROUPED_KEY = '__ungrouped__';
const UNGROUPED_LABEL = 'Ungrouped';
const PREVIEW_MESSAGE_COUNT = 5;

function formatAge(ts: number | undefined, now: number): string {
  if (!ts) return '';
  const diff = Math.max(0, now - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 45) return 'now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk}w`;
  return `${Math.floor(day / 30)}mo`;
}

function shortenCwd(cwd: string): string {
  if (!cwd) return '';
  const home = (typeof window !== 'undefined' && (window as any).codiby?.home) || '';
  if (home && cwd.startsWith(home)) return '~' + cwd.slice(home.length);
  return cwd;
}

type RowStatus = 'streaming' | 'attn' | 'done' | 'idle';

function deriveStatus(state: SwitcherSessionState | undefined): RowStatus {
  if (!state) return 'idle';
  if (state.permRequest) return 'attn';
  if (state.isStreaming) return 'streaming';
  // Most recent message ending an assistant turn = "done". Cheap proxy: the
  // last message is from the assistant and there's no isToolResult tail.
  const last = state.messages[state.messages.length - 1];
  if (last && last.role === 'assistant' && !last.isToolResult && !last.toolName) return 'done';
  return 'idle';
}

function statusBadge(status: RowStatus): { label: string; cls: string } {
  switch (status) {
    case 'streaming': return { label: '● streaming',       cls: 'badge-live' };
    case 'attn':      return { label: '● awaiting input',  cls: 'badge-attn' };
    case 'done':      return { label: 'turn complete',     cls: 'badge-done' };
    default:          return { label: 'idle',              cls: 'badge-done' };
  }
}

/** Last N visible messages — skips tool-use bookkeeping that doesn't help
 *  identify the session at a glance. */
function previewMessages(messages: ChatMessage[]): ChatMessage[] {
  const visible = messages.filter(m => {
    if (m.role === 'system') return false;
    if (m.toolName === 'TodoWrite') return false;
    return true;
  });
  return visible.slice(-PREVIEW_MESSAGE_COUNT);
}

/** Trim and dedent message body for the preview pane. */
function clipBody(text: string, max = 220): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max - 1) + '…';
}

export function CtrlTabSwitcher(props: Props) {
  const {
    open, sessions, selectedIdx, sessionStates, sessionLastMessageAt,
    tabGroups, tabGroupMap, onSelectIdx, onCommit, onClose,
  } = props;

  const now = useMemo(() => Date.now(), [open, selectedIdx]);
  const selectedRef = useRef<HTMLDivElement | null>(null);

  // Keep the highlighted row in view as the user Tabs through.
  useEffect(() => {
    if (!open) return;
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [open, selectedIdx]);

  // Group sessions in their given (MRU) order — first appearance of each
  // group wins position. Sessions without a group land under "Ungrouped".
  const grouped = useMemo(() => {
    const order: string[] = [];
    const buckets = new Map<string, { key: string; label: string; color?: string; items: Array<{ s: SessionInfo; i: number }> }>();
    sessions.forEach((s, i) => {
      const gid = tabGroupMap[s.id] || UNGROUPED_KEY;
      if (!buckets.has(gid)) {
        const grp = tabGroups[gid];
        buckets.set(gid, {
          key: gid,
          label: grp?.name || UNGROUPED_LABEL,
          color: grp?.color,
          items: [],
        });
        order.push(gid);
      }
      buckets.get(gid)!.items.push({ s, i });
    });
    return order.map(k => buckets.get(k)!);
  }, [sessions, tabGroups, tabGroupMap]);

  if (!open) return null;

  const selected = sessions[selectedIdx];
  const selectedState = selected ? sessionStates[selected.id] : undefined;
  const selectedStatus = deriveStatus(selectedState);
  const selectedBadge = statusBadge(selectedStatus);
  const selectedGroupId = selected ? tabGroupMap[selected.id] : undefined;
  const selectedGroupColor = selectedGroupId ? tabGroups[selectedGroupId]?.color : undefined;
  const selectedMessages = selectedState ? previewMessages(selectedState.messages) : [];

  return (
    <>
      <style>{SWITCHER_CSS}</style>
      <div
        className="cts-backdrop"
        onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <div className="cts-switcher" role="dialog" aria-label="Switch session">
          {/* ----- left pane: grouped MRU list ----- */}
          <div className="cts-pane-left">
            <div className="cts-header">
              <span>Switch session</span>
              <span className="cts-count">{sessions.length} open</span>
            </div>
            <div className="cts-list">
              {grouped.map(g => (
                <div key={g.key}>
                  <div className="cts-group-label">
                    <span
                      className="cts-gd"
                      style={{ background: g.color ? GROUP_HEX_COLOR[g.color] : 'var(--cts-faint)' }}
                    />
                    <span>{g.label}</span>
                  </div>
                  {g.items.map(({ s, i }) => {
                    const status = deriveStatus(sessionStates[s.id]);
                    const isSel = i === selectedIdx;
                    const age = formatAge(sessionLastMessageAt[s.id] || s.updated_at, now);
                    return (
                      <div
                        key={s.id}
                        ref={isSel ? selectedRef : undefined}
                        className={[
                          'cts-row',
                          isSel ? 'cts-row--selected' : '',
                          status === 'attn' ? 'cts-row--attn' : '',
                        ].join(' ').trim()}
                        onMouseEnter={() => onSelectIdx(i)}
                        onClick={onCommit}
                      >
                        <div className={`cts-dot cts-dot--${status}`} />
                        <div className="cts-main">
                          <div className="cts-name">{s.name || 'Untitled session'}</div>
                          <div className="cts-cwd">{shortenCwd(s.cwd)}</div>
                        </div>
                        <div className="cts-age">{age}</div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            <div className="cts-footer">
              <span><kbd>Tab</kbd> next</span>
              <span className="cts-sep">·</span>
              <span><kbd>⇧Tab</kbd> prev</span>
              <span className="cts-sep">·</span>
              <span>Release <kbd>Ctrl</kbd> to switch</span>
            </div>
          </div>

          {/* ----- right pane: preview ----- */}
          <div className="cts-pane-right">
            {selected ? (
              <>
                <div className="cts-preview-header">
                  <div className="cts-title-row">
                    <span
                      className="cts-group-stripe"
                      style={{ background: selectedGroupColor ? GROUP_HEX_COLOR[selectedGroupColor] : 'transparent' }}
                    />
                    <span className="cts-title">{selected.name || 'Untitled session'}</span>
                    <div className="cts-badges">
                      <span className={`cts-badge ${selectedBadge.cls}`}>{selectedBadge.label}</span>
                    </div>
                  </div>
                  <div className="cts-meta-row">
                    <span className="cts-cwd-mono">{shortenCwd(selected.cwd)}</span>
                    {selected.model && (<><span className="cts-sep">·</span><span>{selected.model}</span></>)}
                    <span className="cts-sep">·</span>
                    <span>last activity {formatAge(sessionLastMessageAt[selected.id] || selected.updated_at, now)}</span>
                  </div>
                </div>
                <div className="cts-preview-body">
                  {selectedMessages.length === 0 ? (
                    <div className="cts-preview-empty">No messages yet.</div>
                  ) : (
                    selectedMessages.map(m => <PreviewMessage key={m.id} msg={m} />)
                  )}
                </div>
                <div className="cts-preview-footer">
                  <span><kbd>↵</kbd> or release <kbd>Ctrl</kbd> to open</span>
                  <span className="cts-spacer" />
                  <button className="cts-open-btn" onMouseDown={(e) => { e.preventDefault(); onCommit(); }}>
                    Open session
                  </button>
                </div>
              </>
            ) : (
              <div className="cts-preview-empty">No session selected.</div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function PreviewMessage({ msg }: { msg: ChatMessage }) {
  // Tool calls → compact chip with the tool name + a short arg summary.
  if (msg.toolName && !msg.isToolResult) {
    const arg = summarizeToolInput(msg.toolName, msg.toolInput);
    return (
      <div className="cts-msg">
        <div className="cts-who">claude</div>
        <div className="cts-tool"><span className="cts-tool-tag">{msg.toolName}</span> {arg}</div>
      </div>
    );
  }
  // Tool results render as a chip too — usually noise in a quick scan, but
  // showing them keeps the conversation flow readable.
  if (msg.isToolResult) {
    const body = typeof msg.content === 'string' ? clipBody(msg.content, 120) : '(result)';
    return (
      <div className="cts-msg">
        <div className="cts-who">result</div>
        <div className="cts-tool">{body || '(empty)'}</div>
      </div>
    );
  }
  const isUser = msg.role === 'user';
  return (
    <div className={`cts-msg ${isUser ? 'cts-msg--user' : ''}`}>
      <div className="cts-who">{isUser ? 'you' : 'claude'}</div>
      <div className="cts-body">{clipBody(msg.content)}</div>
    </div>
  );
}

function summarizeToolInput(toolName: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  // Tools that have a strong "primary arg" — show that. Everything else
  // gets a comma-joined string of short scalar values.
  const primaryByTool: Record<string, string[]> = {
    Read: ['file_path'],
    Edit: ['file_path'],
    Write: ['file_path'],
    Grep: ['pattern'],
    Glob: ['pattern'],
    Bash: ['command'],
    Agent: ['description'],
  };
  const keys = primaryByTool[toolName] || Object.keys(i).slice(0, 1);
  const v = keys.map(k => i[k]).find(x => typeof x === 'string') as string | undefined;
  return v ? clipBody(v, 100) : '';
}

/* -----------------------------------------------------------------------
 * Styles — inlined so the component owns its visual contract and can't be
 * styled away by ambient css. CSS variables are scoped to .cts-backdrop.
 * --------------------------------------------------------------------- */
const SWITCHER_CSS = `
.cts-backdrop {
  --cts-bg: #1a1b21;
  --cts-bg-right: #16171c;
  --cts-border: #2a2b32;
  --cts-border-light: #3a3b42;
  --cts-text: #e6e7ea;
  --cts-dim: #8a8c93;
  --cts-faint: #5a5c63;
  --cts-accent: #7c5cff;
  --cts-green: #3ecf8e;
  --cts-red: #ef5b6b;
  --cts-blue: #60a5fa;
  --cts-surface-3: #2a2b32;
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.45);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  z-index: 200;
  display: grid;
  place-items: center;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, sans-serif;
  font-size: 13px;
  color: var(--cts-text);
  -webkit-font-smoothing: antialiased;
}
.cts-switcher {
  display: grid;
  grid-template-columns: 340px 460px;
  width: 800px;
  max-width: 92vw;
  height: 460px;
  background: var(--cts-bg);
  border: 1px solid var(--cts-border-light);
  border-radius: 12px;
  box-shadow: 0 24px 80px rgba(0,0,0,0.6), 0 2px 8px rgba(0,0,0,0.4);
  overflow: hidden;
}
.cts-pane-left { display: flex; flex-direction: column; border-right: 1px solid var(--cts-border); min-width: 0; }
.cts-header {
  padding: 9px 14px;
  border-bottom: 1px solid var(--cts-border);
  display: flex; align-items: center; justify-content: space-between;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--cts-faint);
}
.cts-count { color: var(--cts-dim); text-transform: none; letter-spacing: 0; font-size: 11px; }
.cts-list { flex: 1; overflow-y: auto; padding: 4px 0 6px; }
.cts-group-label {
  display: flex; align-items: center; gap: 7px;
  padding: 8px 14px 4px;
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--cts-faint);
}
.cts-gd { width: 5px; height: 5px; border-radius: 50%; flex: none; }
.cts-row {
  display: grid;
  grid-template-columns: 10px 1fr auto;
  align-items: center;
  gap: 10px;
  padding: 6px 12px;
  margin: 0 6px;
  border-radius: 6px;
  cursor: pointer;
  min-width: 0;
}
.cts-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--cts-faint); justify-self: center; }
.cts-dot--streaming { background: var(--cts-accent); box-shadow: 0 0 0 2px rgba(124,92,255,0.18); }
.cts-dot--done      { background: var(--cts-green); }
.cts-dot--attn      { background: var(--cts-red); animation: cts-dot-pulse 1.4s ease-in-out infinite; }
@keyframes cts-dot-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(239,91,107,0.55); }
  50%      { box-shadow: 0 0 0 5px rgba(239,91,107,0); }
}
.cts-row--attn { background: linear-gradient(90deg, rgba(239,91,107,0.06), transparent 60%); }
.cts-row--attn.cts-row--selected {
  background:
    linear-gradient(90deg, rgba(239,91,107,0.10), transparent 60%),
    var(--cts-surface-3);
}
.cts-main { min-width: 0; }
.cts-name {
  color: var(--cts-text);
  font-size: 12.5px;
  font-weight: 500;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.cts-cwd {
  color: var(--cts-faint);
  font-size: 10.5px;
  font-family: ui-monospace, monospace;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.cts-age { color: var(--cts-faint); font-size: 10px; font-variant-numeric: tabular-nums; }
.cts-row:hover { background: rgba(255,255,255,0.03); }
.cts-row--selected { background: var(--cts-surface-3); }
.cts-row--selected .cts-name { color: white; }
.cts-row--selected .cts-cwd  { color: var(--cts-dim); }
.cts-footer {
  display: flex; align-items: center; gap: 12px;
  padding: 7px 14px;
  border-top: 1px solid var(--cts-border);
  color: var(--cts-faint);
  font-size: 10.5px;
}
.cts-sep { color: var(--cts-border-light); }
kbd {
  background: var(--cts-surface-3);
  border: 1px solid var(--cts-border-light);
  border-radius: 4px;
  padding: 1px 5px;
  font: 11px ui-monospace, monospace;
  color: var(--cts-text);
}
.cts-pane-right { display: flex; flex-direction: column; min-width: 0; background: var(--cts-bg-right); }
.cts-preview-header {
  padding: 11px 16px 10px;
  border-bottom: 1px solid var(--cts-border);
  display: flex; flex-direction: column; gap: 4px;
}
.cts-title-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.cts-group-stripe { width: 3px; height: 14px; border-radius: 2px; flex: none; }
.cts-title {
  flex: 1;
  color: var(--cts-text);
  font-size: 13.5px;
  font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.cts-badges { display: flex; gap: 6px; }
.cts-badge {
  font-size: 10px;
  color: var(--cts-dim);
  padding: 1px 7px;
  border: 1px solid var(--cts-border);
  border-radius: 999px;
  white-space: nowrap;
}
.cts-badge.badge-live {
  color: var(--cts-accent);
  border-color: rgba(124,92,255,0.4);
  background: rgba(124,92,255,0.08);
}
.cts-badge.badge-attn {
  color: var(--cts-red);
  border-color: rgba(239,91,107,0.4);
  background: rgba(239,91,107,0.08);
  animation: cts-badge-pulse 1.4s ease-in-out infinite;
}
@keyframes cts-badge-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(239,91,107,0.4); }
  50%      { box-shadow: 0 0 0 4px rgba(239,91,107,0); }
}
.cts-meta-row { display: flex; align-items: center; gap: 8px; color: var(--cts-faint); font-size: 11px; min-width: 0; }
.cts-cwd-mono {
  font-family: ui-monospace, monospace;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  min-width: 0;
}
.cts-preview-body {
  flex: 1; overflow-y: auto;
  padding: 12px 16px;
  display: flex; flex-direction: column; gap: 10px;
  font-size: 12px;
  color: var(--cts-dim);
}
.cts-preview-empty {
  flex: 1; display: grid; place-items: center;
  color: var(--cts-faint); font-size: 12px;
}
.cts-msg { display: flex; flex-direction: column; gap: 3px; }
.cts-who { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--cts-faint); }
.cts-msg--user .cts-who { color: var(--cts-accent); }
.cts-body {
  color: var(--cts-dim);
  line-height: 1.45;
  background: rgba(255,255,255,0.02);
  padding: 7px 10px;
  border-radius: 6px;
  border: 1px solid var(--cts-border);
  word-break: break-word;
}
.cts-msg--user .cts-body {
  background: rgba(124,92,255,0.06);
  border-color: rgba(124,92,255,0.18);
  color: var(--cts-text);
}
.cts-tool {
  display: inline-flex; align-items: center; gap: 6px;
  font-family: ui-monospace, monospace;
  font-size: 11px;
  color: var(--cts-dim);
  padding: 5px 9px;
  background: rgba(96,165,250,0.05);
  border: 1px solid rgba(96,165,250,0.15);
  border-radius: 6px;
  width: fit-content;
  max-width: 100%;
  word-break: break-all;
}
.cts-tool-tag { color: var(--cts-blue); font-weight: 600; }
.cts-preview-footer {
  padding: 8px 16px;
  border-top: 1px solid var(--cts-border);
  display: flex; align-items: center; gap: 8px;
  color: var(--cts-faint);
  font-size: 11px;
}
.cts-spacer { flex: 1; }
.cts-open-btn {
  background: var(--cts-accent);
  color: white;
  border: 0;
  border-radius: 6px;
  padding: 5px 12px;
  font: inherit; font-size: 11px;
  cursor: pointer;
}
.cts-open-btn:hover { filter: brightness(1.1); }
`;
