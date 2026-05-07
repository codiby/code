import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, type ReactNode } from 'react';
import { ArrowDown, Send as SendIcon, Sparkles } from 'lucide-react';
import { Button, Select, SelectTrigger, SelectValue, SelectPopover, SelectIndicator, ListBox, ListBoxItem } from '@heroui/react';
import Editor, { DiffEditor, type Monaco } from '@monaco-editor/react';
import { DiffReview, type ReviewComment } from './DiffReview';
import { Providers } from './Providers';
import { TabBar } from './TabBar';
import { FileExplorer } from './FileExplorer';
import { MessageBubble, AgentBubble, ToolRunBubble, groupMessages, collapseToolRuns, AnsiText } from './MessageBubble';
import { Markdown } from './Markdown';
import { NewSessionModal } from './NewSessionModal';
import { WorktreeModal } from './WorktreeModal';
import { BypassWarningModal, shouldWarnBypass } from './BypassWarningModal';
import { useSlashCommands, SlashCommandList } from './SlashCommandPicker';
import { useFileMention, FileMentionList } from './FileMentionPicker';
import { CommandPalette, type PaletteAction } from './CommandPalette';
import { SettingsPanel } from './SettingsPanel';
import { PluginLinkedItemPickers, PluginDetailView, PluginSidebarPanels } from './PluginExtensionPoints';
import { PRDetail, type PRInfo } from './PRDetail';
import { useFileIndex } from '../lib/fuzzy-file-search';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import type { editor as MonacoEditor } from 'monaco-editor';
import {
  ClaudeClient,
  resolveServerUrl,
  type ChatMessage,
  type ConnectionStatus,
  type PermissionRequest,
  type SessionInfo,
  type SessionInitInfo,
  type SessionState,
} from '../lib/claude-client';
import { LspClient } from '../lib/lsp-client';
import { DebugPanel } from './DebugPanel';
import { type MockupComment } from '../lib/mockup-inspector';
import { MockupPanel } from './MockupPanel';
import { PlanPanel, type PlanComment } from './PlanPanel';

type PendingMessage = {
  id: string;
  text: string;
  images?: { media_type: string; data: string }[];
};

// Local UI extensions on top of server SessionState
type LocalSessionState = SessionState & {
  editorDirty: boolean;
  contextTokens: number;
  pendingMessages: PendingMessage[];
  // Live HTML mockup preview shown in the side panel. UI-only — the bridge
  // server doesn't track this field, so the merge in `onSessionState` must
  // preserve `openMockup`/`lastMockup` from the existing local state.
  openMockup: { name: string; html: string } | null;
  // Most recent mockup, kept after the user closes the panel so the chat
  // header can offer a one-click "reopen" button.
  lastMockup: { name: string; html: string } | null;
  // Inspector comments per mockup name. Keyed by mockup name so they
  // survive `mockup_edit` re-broadcasts and tab switches.
  mockupComments: Record<string, MockupComment[]>;
  mockupInspect: boolean;
  // ExitPlanMode plan rendered in the side panel. UI-only — same merge
  // caveat as `openMockup`. `planRequestId` tracks the most recent perm
  // request id we auto-opened for so we don't reopen the panel after the
  // user closes it manually while permission is still pending.
  openPlan: { content: string; allowedPrompts?: { tool: string; prompt: string }[] } | null;
  lastPlan: { content: string; allowedPrompts?: { tool: string; prompt: string }[] } | null;
  planComments: PlanComment[];
  planRequestId: string | null;
};

type AskQuestion = { question: string; header?: string; options?: { label: string; description?: string }[]; multiSelect?: boolean };

function AskUserQuestionForm({ questions, onSubmit }: { questions: AskQuestion[]; onSubmit: (answers: Record<string, string>) => void }) {
  // Per-question state. `selections[i]` is the chosen option label OR the
  // typed custom text when `customMode[i]` is true. Claude's AskUserQuestion
  // tool keys answers by question text (its tool_result formatter looks up
  // `answers[question.question]`), so translate at the submit boundary.
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [customMode, setCustomMode] = useState<Record<string, boolean>>({});

  const buildAnswers = (sels: Record<string, string>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [key, val] of Object.entries(sels)) {
      const q = questions[Number(key)]?.question;
      const trimmed = val.trim();
      if (q && trimmed) out[q] = trimmed;
    }
    return out;
  };

  const handleSelect = (qIdx: number, label: string) => {
    const key = String(qIdx);
    setCustomMode(prev => ({ ...prev, [key]: false }));
    setSelections(prev => ({ ...prev, [key]: label }));
    if (questions.length === 1) {
      onSubmit(buildAnswers({ [key]: label }));
    }
  };

  const handleEnterCustom = (qIdx: number) => {
    const key = String(qIdx);
    setCustomMode(prev => ({ ...prev, [key]: true }));
    setSelections(prev => ({ ...prev, [key]: '' }));
  };

  const handleCustomChange = (qIdx: number, text: string) => {
    const key = String(qIdx);
    setSelections(prev => ({ ...prev, [key]: text }));
  };

  const submitCustomSingle = (qIdx: number) => {
    const key = String(qIdx);
    const val = (selections[key] || '').trim();
    if (!val) return;
    onSubmit(buildAnswers({ [key]: val }));
  };

  const allAnswered = questions.every((_, i) => (selections[String(i)] || '').trim());

  return (
    <div className="space-y-3 mb-2">
      {questions.map((q, i) => {
        const key = String(i);
        const isCustom = customMode[key] === true;
        const selected = !isCustom ? selections[key] : undefined;
        return (
          <div key={i}>
            {q.header && (
              <span className="inline-block text-[10px] font-semibold text-violet-400 bg-violet-400/10 px-1.5 py-0.5 rounded mb-1">
                {q.header}
              </span>
            )}
            <p className="text-[12px] text-zinc-300 leading-relaxed mb-1.5">{q.question}</p>
            {q.options && q.options.length > 0 && (
              <div className="space-y-1">
                {q.options.map((opt, j) => (
                  <button
                    key={j}
                    onClick={() => handleSelect(i, opt.label)}
                    className={`w-full text-left px-3 py-2 rounded-lg border transition-all ${
                      selected === opt.label
                        ? 'border-violet-400/50 bg-violet-500/10 ring-1 ring-violet-400/20'
                        : 'border-border hover:border-zinc-600 hover:bg-surface-light/50'
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <span className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center shrink-0 mt-0.5 ${
                        selected === opt.label ? 'border-violet-400' : 'border-zinc-600'
                      }`}>
                        {selected === opt.label && <span className="w-1.5 h-1.5 rounded-full bg-violet-400" />}
                      </span>
                      <div>
                        <span className="text-[12px] font-medium text-zinc-200">{opt.label}</span>
                        {opt.description && <p className="text-[11px] text-zinc-500 mt-0.5 leading-snug">{opt.description}</p>}
                      </div>
                    </div>
                  </button>
                ))}
                {isCustom ? (
                  <div className="flex items-stretch gap-1">
                    <input
                      autoFocus
                      type="text"
                      value={selections[key] || ''}
                      onChange={(e) => handleCustomChange(i, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && questions.length === 1) {
                          e.preventDefault();
                          submitCustomSingle(i);
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          setCustomMode(prev => ({ ...prev, [key]: false }));
                          setSelections(prev => ({ ...prev, [key]: '' }));
                        }
                      }}
                      placeholder="Type your own answer…"
                      className="flex-1 px-3 py-2 rounded-lg border border-violet-400/50 bg-violet-500/10 ring-1 ring-violet-400/20 text-[12px] text-zinc-100 placeholder:text-zinc-500 outline-none"
                    />
                    {questions.length === 1 && (
                      <button
                        type="button"
                        disabled={!(selections[key] || '').trim()}
                        onClick={() => submitCustomSingle(i)}
                        className="px-3 rounded-lg text-[12px] bg-violet-600/20 text-violet-300 hover:bg-violet-600/30 disabled:opacity-40 transition-colors"
                      >
                        Send
                      </button>
                    )}
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleEnterCustom(i)}
                    className="w-full text-left px-3 py-2 rounded-lg border border-dashed border-border text-[12px] text-zinc-500 hover:text-zinc-300 hover:border-zinc-600 transition-colors"
                  >
                    + Other (write your own answer)
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
      {questions.length > 1 && (
        <button
          disabled={!allAnswered}
          onClick={() => onSubmit(buildAnswers(selections))}
          className="px-3 py-1 rounded text-[12px] bg-violet-600/15 text-violet-400 hover:bg-violet-600/25 transition-colors disabled:opacity-40"
        >
          Submit answers
        </button>
      )}
    </div>
  );
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
const MOD_KEY = IS_MAC ? '⌘' : 'Ctrl';

function formatRelativeTime(ts: number): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 4) return `${w}w ago`;
  return new Date(ts).toLocaleDateString();
}

function WelcomeScreen({
  sessions,
  closedSessionIds,
  archivedSessionIds,
  sessionLastMessageAt,
  onNewSession,
  onReopenSession,
  onOpenCommandPalette,
  onOpenSettings,
  onOpenSearch,
  onToggleExplorer,
}: {
  sessions: SessionInfo[];
  closedSessionIds: Set<string>;
  archivedSessionIds: Set<string>;
  sessionLastMessageAt: Record<string, number>;
  onNewSession: () => void;
  onReopenSession: (id: string) => void;
  onOpenCommandPalette: () => void;
  onOpenSettings: () => void;
  onOpenSearch: () => void;
  onToggleExplorer: () => void;
}) {
  const recents = useMemo(() => {
    return sessions
      .filter(s => closedSessionIds.has(s.id) && !archivedSessionIds.has(s.id))
      .map(s => ({ session: s, ts: sessionLastMessageAt[s.id] || 0 }))
      .sort((a, b) => b.ts - a.ts);
  }, [sessions, closedSessionIds, archivedSessionIds, sessionLastMessageAt]);

  const startActions: { icon: ReactNode; label: string; hint: string; shortcut?: string; onClick: () => void }[] = [
    {
      icon: (
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M12 18v-6" strokeLinecap="round" /><path d="M9 15h6" strokeLinecap="round" /></svg>
      ),
      label: 'New Session',
      hint: 'Start a fresh Claude session',
      onClick: onNewSession,
    },
    {
      icon: (
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 9h10M7 13h6" strokeLinecap="round" /></svg>
      ),
      label: 'Command Palette',
      hint: 'Run a command, jump to a file',
      shortcut: `${MOD_KEY} K`,
      onClick: onOpenCommandPalette,
    },
    {
      icon: (
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="11" cy="11" r="7" /><path d="M16 16L21 21" strokeLinecap="round" /></svg>
      ),
      label: 'Search Across Files',
      hint: 'Search the current workspace',
      shortcut: `${MOD_KEY} ⇧ F`,
      onClick: onOpenSearch,
    },
    {
      icon: (
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M3 7V17C3 18.1046 3.89543 19 5 19H19C20.1046 19 21 18.1046 21 17V9C21 7.89543 20.1046 7 19 7H13L11 5H5C3.89543 5 3 5.89543 3 7Z" /></svg>
      ),
      label: 'Toggle File Explorer',
      hint: 'Show or hide the side panel',
      shortcut: `${MOD_KEY} B`,
      onClick: onToggleExplorer,
    },
    {
      icon: (
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></svg>
      ),
      label: 'Settings',
      hint: 'Open settings panel',
      onClick: onOpenSettings,
    },
  ];

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl px-10 py-14">
        {/* Header */}
        <div className="mb-10">
          <img src="/brand/codiby-logo.svg" alt="Codiby" className="h-12 w-auto mb-2 select-none" draggable={false} />
          <p className="text-sm text-zinc-500">Editing evolved with Claude.</p>
        </div>

        {/* Two-column: Start | Recent */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-12 mb-12">
          {/* Start */}
          <div>
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 mb-3">Start</h2>
            <div className="space-y-1">
              {startActions.map(action => (
                <button
                  key={action.label}
                  onClick={action.onClick}
                  className="w-full group flex items-center gap-3 px-2 py-1.5 rounded text-left text-[13px] text-zinc-400 hover:text-zinc-200 hover:bg-surface-light transition-colors"
                >
                  <span className="text-zinc-500 group-hover:text-violet-400 transition-colors">{action.icon}</span>
                  <span className="flex-1 truncate">{action.label}</span>
                  {action.shortcut && (
                    <span className="text-[11px] text-zinc-600 font-mono shrink-0">{action.shortcut}</span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* Recent */}
          <div>
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 mb-3">Recent</h2>
            {recents.length === 0 ? (
              <p className="text-[13px] text-zinc-600">No recent sessions yet.</p>
            ) : (
              <div className="space-y-1">
                {recents.slice(0, 8).map(({ session, ts }) => (
                  <button
                    key={session.id}
                    onClick={() => onReopenSession(session.id)}
                    className="w-full group flex items-center gap-3 px-2 py-1.5 rounded text-left text-[13px] hover:bg-surface-light transition-colors"
                    title={session.cwd}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-zinc-300 group-hover:text-zinc-100 truncate">{session.name}</div>
                      <div className="text-[11px] text-zinc-600 font-mono truncate">{session.cwd}</div>
                    </div>
                    {ts > 0 && (
                      <span className="text-[11px] text-zinc-600 shrink-0">{formatRelativeTime(ts)}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Tips footer */}
        <div className="border-t border-border pt-6">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 mb-3">Tips</h2>
          <ul className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-1.5 text-[12px] text-zinc-500">
            <li>Press <span className="text-zinc-300 font-mono bg-surface px-1.5 py-0.5 rounded border border-border">{MOD_KEY} K</span> to open the command palette.</li>
            <li>Press <span className="text-zinc-300 font-mono bg-surface px-1.5 py-0.5 rounded border border-border">{MOD_KEY} B</span> to toggle the file explorer.</li>
            <li>Press <span className="text-zinc-300 font-mono bg-surface px-1.5 py-0.5 rounded border border-border">{MOD_KEY} L</span> to focus the chat input.</li>
            <li>Press <span className="text-zinc-300 font-mono bg-surface px-1.5 py-0.5 rounded border border-border">⇧ Tab</span> in chat to cycle permission modes.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

function SearchPanel({ client, rootPath, onFileOpen, onClose }: { client: ClaudeClient | null; rootPath: string | null; onFileOpen: (path: string, line?: number) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ file: string; line: number; text: string }[]>([]);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => { inputRef.current?.focus(); }, []);

  const doSearch = (q: string) => {
    if (!client || !rootPath || !q.trim()) { setResults([]); return; }
    setSearching(true);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      client.searchFiles(rootPath, q.trim()).then(r => { setResults(r); setSearching(false); }).catch(() => { setResults([]); setSearching(false); });
    }, 300);
  };

  return (
    <aside className="w-60 border-r border-border bg-[#161616] flex flex-col shrink-0">
      <div className="px-3 py-2 flex items-center justify-between border-b border-border shrink-0">
        <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">Search</span>
        <button className="text-zinc-600 hover:text-zinc-300 text-sm" onClick={onClose}>&#x2715;</button>
      </div>
      <div className="px-2 py-2 border-b border-border shrink-0">
        <input
          ref={inputRef}
          value={query}
          onChange={e => { setQuery(e.target.value); doSearch(e.target.value); }}
          onKeyDown={e => { if (e.key === 'Escape') onClose(); }}
          placeholder="Search in files..."
          className="w-full bg-surface border border-border rounded px-2 py-1 text-[12px] text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-zinc-500"
        />
      </div>
      <div className="flex-1 overflow-y-auto">
        {searching && <p className="text-[11px] text-zinc-600 text-center py-4">Searching...</p>}
        {!searching && query && results.length === 0 && <p className="text-[11px] text-zinc-600 text-center py-4">No results</p>}
        {results.map((r, i) => {
          const relFile = rootPath && r.file.startsWith('./') ? r.file.slice(2) : r.file;
          return (
            <div
              key={i}
              className="px-2 py-1 hover:bg-surface-light/50 cursor-pointer transition-colors border-b border-border/30"
              onClick={() => onFileOpen(rootPath ? `${rootPath}/${relFile}` : relFile, r.line)}
            >
              <div className="flex items-center gap-1">
                <span className="text-[11px] text-zinc-400 truncate">{relFile}</span>
                <span className="text-[10px] text-zinc-600 shrink-0">:{r.line}</span>
              </div>
              <p className="text-[10px] text-zinc-500 font-mono truncate leading-snug">{r.text}</p>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

// Shared chime helper — used by both the desktop ChatApp and the mobile UI
// so the audio cue on permission requests / turn completion is identical.
import { playChime } from '../lib/chime';

export function ChatApp() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  // Sessions have three lifecycle states stored in two parallel sets:
  //   open     — id is in NEITHER set (rendered in the tab bar)
  //   closed   — id is in `closedSessionIds` only (rendered under the
  //              "+" dropdown's CLOSED section, can be reopened)
  //   archived — id is in `archivedSessionIds` (hidden from tabs AND
  //              from the "+" dropdown; reachable from the future
  //              archived-sessions management page only)
  // When a session moves closed → archived we remove it from
  // `closedSessionIds` and add it to `archivedSessionIds` so the two
  // sets stay disjoint.
  const [closedSessionIds, setClosedSessionIds] = useState<Set<string>>(new Set());
  const closedIdsRef = useRef(closedSessionIds);
  const [archivedSessionIds, setArchivedSessionIds] = useState<Set<string>>(new Set());
  const archivedIdsRef = useRef(archivedSessionIds);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Bridge spawn mode (`service` = server auto-booted every active session at
  // startup; `app` = sessions are only spawned when the user activates a tab,
  // via `notifyActiveTab`). Tracked in a ref because `onSessions` reads it
  // synchronously on the very first delivery and we want to skip the legacy
  // bulk auto-resume when the server is already handling spawn-on-demand.
  const spawnModeRef = useRef<'app' | 'service'>('service');
  const [tabOrder, setTabOrder] = useState<string[]>([]);
  const [tabGroups, setTabGroups] = useState<Record<string, { id: string; name: string; color: string; cwd?: string; icon?: string }>>({});
  const [tabGroupMap, setTabGroupMap] = useState<Record<string, string>>({});
  const [pinnedSessionIds, setPinnedSessionIds] = useState<Set<string>>(new Set());
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(new Set());
  const [autoGroupSessions, setAutoGroupSessions] = useState(false);

  // Preferences are loaded inside the client connection effect below (before WS connect)

  const persistPrefs = (patch: Record<string, unknown>) => {
    resolveServerUrl().then(base =>
      fetch(`${base}/preferences`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }).catch(() => {})
    );
  };

  const GROUP_COLORS = ['blue', 'green', 'amber', 'violet', 'red', 'pink'];
  let groupColorIdx = Object.keys(tabGroups).length;

  const handleCreateGroup = (tabIds: string[]) => {
    const groupId = crypto.randomUUID();
    const color = GROUP_COLORS[groupColorIdx++ % GROUP_COLORS.length]!;
    // A group always belongs to a project — capture the cwd from the first
    // member tab. This becomes the default cwd for any "+ New session in
    // group" actions later. Falls back to the active session's cwd, then
    // root, if no member is found.
    const firstMember = sessions.find(s => tabIds.includes(s.id));
    const groupCwd = firstMember?.cwd || sessions.find(s => s.id === activeId)?.cwd || '/';
    const groupName = firstMember?.cwd
      ? (firstMember.cwd.split('/').filter(Boolean).pop() || `Group ${Object.keys(tabGroups).length + 1}`)
      : `Group ${Object.keys(tabGroups).length + 1}`;
    const newGroups = { ...tabGroups, [groupId]: { id: groupId, name: groupName, color, cwd: groupCwd } };
    const newMap = { ...tabGroupMap };
    for (const id of tabIds) newMap[id] = groupId;
    setTabGroups(newGroups);
    setTabGroupMap(newMap);
    setExpandedGroupIds(prev => {
      const next = new Set(prev);
      next.add(groupId);
      return next;
    });
    persistPrefs({ tabGroups: newGroups, tabGroupMap: newMap });
  };

  /** Create a new session whose cwd matches the group's saved project path,
   *  then add it to the group automatically. Triggered from the group's
   *  dropdown menu. Falls back to the first member's cwd for legacy groups
   *  created before the cwd field existed, and backfills group.cwd at the
   *  same time so it persists for next time. */
  const handleNewSessionInGroup = async (groupId: string) => {
    const c = clientRef.current;
    if (!c) return;
    const group = tabGroups[groupId];
    if (!group) return;
    const firstMember = sessions.find(s => tabGroupMap[s.id] === groupId);
    const cwd = group.cwd || firstMember?.cwd || '';
    if (!cwd) return;
    try {
      const session = await c.createSession(cwd);
      const newMap = { ...tabGroupMap, [session.id]: groupId };
      setTabGroupMap(newMap);
      // Persist the inferred cwd back into the group so subsequent
      // dropdown opens don't need the fallback path.
      let nextGroups = tabGroups;
      if (!group.cwd) {
        nextGroups = { ...tabGroups, [groupId]: { ...group, cwd } };
        setTabGroups(nextGroups);
      }
      setExpandedGroupIds(prev => { const next = new Set(prev); next.add(groupId); return next; });
      setActiveId(session.id);
      c.subscribe(session.id);
      subscribedRef.current.add(session.id);
      persistPrefs({ tabGroupMap: newMap, ...(group.cwd ? {} : { tabGroups: nextGroups }) });
    } catch (err) {
      console.error('[ChatApp] Failed to create session in group:', err);
    }
  };

  /** Open the worktree creation modal targeted at a group's repo. On
   *  success (handleWorktreeCreatedForGroup), spawn a session in the new
   *  worktree path and bind it to the group. Falls back to the first
   *  member's cwd for legacy groups, same as handleNewSessionInGroup. */
  const handleNewSessionInWorktreeForGroup = async (groupId: string) => {
    const c = clientRef.current;
    if (!c) return;
    const group = tabGroups[groupId];
    if (!group) return;
    const firstMember = sessions.find(s => tabGroupMap[s.id] === groupId);
    const cwd = group.cwd || firstMember?.cwd || '';
    if (!cwd) return;
    let hasEnv: boolean | undefined;
    let packageManager: string | undefined;
    let worktrees: { path: string; branch: string }[] | undefined;
    try {
      const info = await c.getGitInfo(cwd);
      hasEnv = info.has_env;
      packageManager = info.package_manager;
      worktrees = info.worktrees;
    } catch {
      // GitInfo is best-effort prefill; keep going with defaults.
    }
    setWorktreeForGroup({ groupId, cwd, hasEnv, packageManager, worktrees });
  };

  const handleWorktreeCreatedForGroup = async (groupId: string, originalCwd: string, worktreePath: string) => {
    const c = clientRef.current;
    if (!c) return;
    const group = tabGroups[groupId];
    if (!group) return;
    try {
      const session = await c.createSession(worktreePath);
      const newMap = { ...tabGroupMap, [session.id]: groupId };
      setTabGroupMap(newMap);
      let nextGroups = tabGroups;
      // Backfill the group's cwd with the original repo path (NOT the
      // worktree path) for legacy groups, so future opens skip the
      // first-member fallback.
      if (!group.cwd) {
        nextGroups = { ...tabGroups, [groupId]: { ...group, cwd: originalCwd } };
        setTabGroups(nextGroups);
      }
      setExpandedGroupIds(prev => { const next = new Set(prev); next.add(groupId); return next; });
      setActiveId(session.id);
      c.subscribe(session.id);
      subscribedRef.current.add(session.id);
      persistPrefs({ tabGroupMap: newMap, ...(group.cwd ? {} : { tabGroups: nextGroups }) });
    } catch (err) {
      console.error('[ChatApp] Failed to create session in worktree for group:', err);
    } finally {
      setWorktreeForGroup(null);
    }
  };

  const handleGroupTabs = (tabIdA: string, tabIdB: string) => {
    handleCreateGroup([tabIdA, tabIdB]);
  };

  const handleAddToGroup = (tabId: string, groupId: string) => {
    const newMap = { ...tabGroupMap, [tabId]: groupId };
    setTabGroupMap(newMap);
    setExpandedGroupIds(prev => {
      const next = new Set(prev);
      next.add(groupId);
      return next;
    });
    persistPrefs({ tabGroupMap: newMap });
  };

  const handleUngroupTab = (tabId: string) => {
    const newMap = { ...tabGroupMap };
    const groupId = newMap[tabId];
    delete newMap[tabId];
    // Delete group if empty
    const newGroups = { ...tabGroups };
    if (groupId && !Object.values(newMap).includes(groupId)) {
      delete newGroups[groupId];
      setExpandedGroupIds(prev => {
        if (!prev.has(groupId)) return prev;
        const next = new Set(prev); next.delete(groupId); return next;
      });
    }
    setTabGroupMap(newMap);
    setTabGroups(newGroups);
    persistPrefs({ tabGroups: newGroups, tabGroupMap: newMap });
  };

  const lastActivePerGroup = useRef<Record<string, string>>({});

  // Track last active session per group, and auto-expand the active
  // session's group so the selected tab is always visible in the sidebar.
  useEffect(() => {
    if (!activeId) return;
    const groupId = tabGroupMap[activeId];
    if (!groupId) return;
    lastActivePerGroup.current[groupId] = activeId;
    setExpandedGroupIds(prev => {
      if (prev.has(groupId)) return prev;
      const next = new Set(prev);
      next.add(groupId);
      return next;
    });
  }, [activeId, tabGroupMap]);

  // Invariant: a group with zero members in `tabGroupMap` should not exist.
  // Prune orphans automatically so any flow that removes a tab from a group
  // (purge, future close/archive cleanup, etc.) leaves no dead group behind.
  useEffect(() => {
    const usedGroupIds = new Set(Object.values(tabGroupMap));
    const orphaned = Object.keys(tabGroups).filter(id => !usedGroupIds.has(id));
    if (orphaned.length === 0) return;
    const nextGroups = { ...tabGroups };
    for (const id of orphaned) delete nextGroups[id];
    setTabGroups(nextGroups);
    setExpandedGroupIds(prev => {
      let changed = false;
      const next = new Set(prev);
      for (const id of orphaned) if (next.delete(id)) changed = true;
      return changed ? next : prev;
    });
    persistPrefs({ tabGroups: nextGroups });
  }, [tabGroupMap, tabGroups]);

  const handleToggleGroup = (groupId: string) => {
    setExpandedGroupIds(prev => {
      // Collapse if already expanded
      if (prev.has(groupId)) {
        const next = new Set(prev); next.delete(groupId); return next;
      }
      // Multiple groups stay expanded (Arc/Zen-style sidebar).
      const next = new Set(prev);
      next.add(groupId);
      // Select last focused session in the just-expanded group
      const lastId = lastActivePerGroup.current[groupId];
      const members = sessions.filter(s => tabGroupMap[s.id] === groupId);
      const target = lastId && members.some(m => m.id === lastId) ? lastId : members[0]?.id;
      if (target) setActiveId(target);
      return next;
    });
  };

  const handleRenameGroup = (groupId: string, name: string) => {
    const newGroups = { ...tabGroups, [groupId]: { ...tabGroups[groupId]!, name } };
    setTabGroups(newGroups);
    persistPrefs({ tabGroups: newGroups });
  };

  const handleDeleteGroup = (groupId: string) => {
    if (!tabGroups[groupId]) return;
    const newGroups = { ...tabGroups };
    delete newGroups[groupId];
    const newMap: Record<string, string> = {};
    for (const [sid, gid] of Object.entries(tabGroupMap)) {
      if (gid !== groupId) newMap[sid] = gid;
    }
    setTabGroups(newGroups);
    setTabGroupMap(newMap);
    setExpandedGroupIds(prev => {
      if (!prev.has(groupId)) return prev;
      const next = new Set(prev); next.delete(groupId); return next;
    });
    persistPrefs({ tabGroups: newGroups, tabGroupMap: newMap });
  };

  const handleChangeGroupColor = (groupId: string, color: string) => {
    const newGroups = { ...tabGroups, [groupId]: { ...tabGroups[groupId]!, color } };
    setTabGroups(newGroups);
    persistPrefs({ tabGroups: newGroups });
  };

  const handleChangeGroupIcon = (groupId: string, icon: string | null) => {
    const current = tabGroups[groupId];
    if (!current) return;
    // null clears the icon (reverts to the colored dot). Otherwise spread
    // and overwrite. Use omit-pattern to actually remove the key when null.
    const next = { ...current };
    if (icon == null) delete next.icon;
    else next.icon = icon;
    const newGroups = { ...tabGroups, [groupId]: next };
    setTabGroups(newGroups);
    persistPrefs({ tabGroups: newGroups });
  };

  const handleTogglePin = (sessionId: string) => {
    setPinnedSessionIds(prev => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      persistPrefs({ pinnedSessionIds: [...next] });
      return next;
    });
  };

  const [statuses, setStatuses] = useState<Record<string, ConnectionStatus>>({});
  // Server is the source of truth for session state. This map is populated only by server messages.
  const [sessionStates, setSessionStates] = useState<Record<string, LocalSessionState>>({});
  const historyIdxRef = useRef(-1);
  const historyDraftRef = useRef('');
  const subscribedRef = useRef(new Set<string>());
  const [pastedImages, setPastedImages] = useState<{ media_type: string; data: string; preview: string }[]>([]);
  // Pulled once from the bridge on mount via /providers/opencode/info.
  // `null` = probe in flight, `{available: false}` = opencode binary is
  // missing or its first boot failed (in which case the New Session
  // modal hides the OpenCode option). Populated from opencode's
  // provider.list, so it reflects whichever providers the user has
  // authenticated for.
  const [opencodeInfo, setOpencodeInfo] = useState<{ available: boolean; models: Array<{ id: string; label: string; providerName: string }> } | null>(null);
  // Per-message-id set of interactive terminals the user has minimized via the
  // shells badge bar or bubble header. Transient UI state; not persisted.
  const [minimizedShells, setMinimizedShells] = useState<Set<string>>(new Set());
  const toggleShellMinimized = useCallback((msgId: string) => {
    setMinimizedShells(prev => {
      const next = new Set(prev);
      if (next.has(msgId)) next.delete(msgId); else next.add(msgId);
      return next;
    });
  }, []);
  // Which interactive terminal's xterm is currently visible in the sticky bottom
  // panel. Switching the active shell keeps all the others mounted (hidden) so
  // scrollback + running processes survive. Per-session via a map keyed by sessionId.
  const [activeShellBySession, setActiveShellBySession] = useState<Record<string, string>>({});
  const [visibleMessageCount, setVisibleMessageCount] = useState(200);
  const [showNewSession, setShowNewSession] = useState(false);
  const [worktreeForGroup, setWorktreeForGroup] = useState<{
    groupId: string;
    cwd: string;
    hasEnv?: boolean;
    packageManager?: string;
    worktrees?: { path: string; branch: string }[];
  } | null>(null);
  const [turnCompleteIds, setTurnCompleteIds] = useState<Set<string>>(new Set());
  const [showPalette, setShowPalette] = useState(false);
  const [explorerCollapsed, setExplorerCollapsed] = useState(false);
  const [sidebarView, setSidebarView] = useState<'explorer' | 'search' | 'plugins' | 'settings'>('explorer');
  // Tracks whether a plugin's <PluginDetailView /> is currently visible. Updated
  // from the codiby-code:linked-item-changed event so the right panel can claim space.
  const [pluginDetailOpen, setPluginDetailOpen] = useState(false);
  const [prLinks, setPrLinks] = useState<Record<string, { prNumber: number; title: string; url: string; headRefName: string; state: string }>>({});
  const [showPrDropdown, setShowPrDropdown] = useState(false);
  const [sessionPrs, setSessionPrs] = useState<{ number: number; title: string; headRefName: string; state: string; url: string; isDraft: boolean }[]>([]);
  const [openPR, setOpenPR] = useState<PRInfo | null>(null);

  const gitModifiedCacheRef = useRef<Record<string, { staged: Set<string>; unstaged: Set<string>; untracked: Set<string> }>>({});
  const [gitModified, setGitModified] = useState<{ staged: Set<string>; unstaged: Set<string>; untracked: Set<string> }>({ staged: new Set(), unstaged: new Set(), untracked: new Set() });
  const [client, setClient] = useState<ClaudeClient | null>(null);
  const clientRef = useRef<ClaudeClient | null>(null);
  const serverUrlRef = useRef<string>('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const permRequestRef = useRef<HTMLDivElement>(null);
  const [chatSplitPct, setChatSplitPct] = useState(() => {
    try { return Number(localStorage.getItem('claude-ui-chat-split')) || 50; }
    catch { return 50; }
  });
  const [tabsCollapsed, setTabsCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem('claude-ui-tabs-collapsed') === '1'; }
    catch { return false; }
  });
  const toggleTabsCollapsed = useCallback(() => {
    setTabsCollapsed(v => {
      const next = !v;
      try { localStorage.setItem('claude-ui-tabs-collapsed', next ? '1' : '0'); } catch {}
      return next;
    });
  }, []);
  const chatDragging = useRef(false);
  // Mirrored as React state so we can render a transparent overlay over the
  // content area during a drag — without it, the cursor entering the
  // mockup iframe (separate browsing context) eats the mouseup and the
  // resize never ends.
  const [chatResizing, setChatResizing] = useState(false);
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const lspClientRef = useRef<LspClient | null>(null);
  const lspSessionIdRef = useRef<string | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const [lspStatus, setLspStatus] = useState<'off' | 'connecting' | 'running' | 'error'>('off');
  const [lspMenu, setLspMenu] = useState(false);
  const [showDebugPanel, setShowDebugPanel] = useState(false);
  const [debugBreakpoints, setDebugBreakpoints] = useState<{ file: string; line: number; enabled: boolean }[]>([]);
  const [debugLine, setDebugLine] = useState<{ file: string; line: number } | null>(null);
  const debugDecorationsRef = useRef<string[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const emptyLocalState = (): LocalSessionState => ({
    messages: [], partialText: '', partialThinking: '', isStreaming: false, wasInterrupted: false, initInfo: null, permRequest: null,
    supportedModels: [],
    openFile: null, openTerminalId: null, diffView: null, editorFullWidth: false,
    reviewComments: {}, reviewMode: false, reviewFiles: [], reviewIndex: 0, todos: [],
    input: '', inputHistory: [],
    editorDirty: false, contextTokens: 0,
    pendingMessages: [],
    openMockup: null, lastMockup: null,
    mockupComments: {}, mockupInspect: false,
    openPlan: null, lastPlan: null, planComments: [], planRequestId: null,
  });

  const getState = (id: string | null): LocalSessionState => {
    if (!id) return emptyLocalState();
    return sessionStates[id] || emptyLocalState();
  };

  // setInput: update local state immediately and sync to server
  const setInput = (val: string | ((prev: string) => string)) => {
    if (!activeId || !clientRef.current) return;
    const current = getState(activeId).input;
    const newVal = typeof val === 'function' ? val(current) : val;
    setSessionStates(prev => ({
      ...prev,
      [activeId]: { ...(prev[activeId] || emptyLocalState()), input: newVal },
    }));
    clientRef.current.updateUIState(activeId, { input: newVal });
  };

  // Panel state setters (local-only UI state that doesn't need server sync)
  const setOpenFile = (file: { path: string; content: string } | null) => {
    if (!activeId) return;
    setSessionStates(prev => {
      const s = prev[activeId] || emptyLocalState();
      return {
        ...prev,
        [activeId]: {
          ...s,
          openFile: file,
          openTerminalId: file ? null : s.openTerminalId,
          diffView: file ? null : s.diffView,
          editorFullWidth: file ? s.editorFullWidth : false,
          editorDirty: false,
        },
      };
    });
  };

  const updateLocalState = useCallback((id: string, fn: (prev: LocalSessionState) => LocalSessionState) => {
    setSessionStates(prev => {
      const current = prev[id] || emptyLocalState();
      return { ...prev, [id]: fn(current) };
    });
  }, []);

  // Initialize client
  // Request notification permission on mount
  useEffect(() => {
    isPermissionGranted().then(granted => {
      if (!granted) requestPermission().catch(() => {});
    }).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    resolveServerUrl().then(async serverUrl => {
      if (cancelled) return;
      serverUrlRef.current = serverUrl;

      // Preferences arrive on the multiplexed WebSocket *before* the session
      // list (server.ts guarantees the message order on connect), so the refs
      // below are populated by `onPreferences` before `onSessions` decides
      // which tabs to subscribe to.

      const c = new ClaudeClient(serverUrl, {
        onSessions: (list) => {
          setSessions(list);
          // Subscribe to open sessions that aren't already subscribed
          const toSubscribe: string[] = [];
          for (const s of list) {
            if (closedIdsRef.current.has(s.id)) continue;
            if (archivedIdsRef.current.has(s.id)) continue;
            if (subscribedRef.current.has(s.id)) continue;
            subscribedRef.current.add(s.id);
            toSubscribe.push(s.id);
            c.subscribe(s.id);
            // Auto-resume stopped sessions only when the bridge runs in
            // `service` spawn mode — in `app` mode the bridge spawns the
            // active tab on demand (see `notifyActiveTab` below) so we don't
            // light up every Claude process at once.
            if (s.status === 'stopped' && spawnModeRef.current === 'service') {
              c.resumeSession(s.id).catch(() => {});
            }
          }
          if (toSubscribe.length) {
            setStatuses(prev => {
              const next = { ...prev };
              for (const id of toSubscribe) next[id] = 'connecting';
              return next;
            });
          }

          // Restore session from URL hash on refresh. On a fresh app launch
          // the hash is empty and we land on the home screen; on browser
          // refresh the hash persists and we reopen that session.
          setActiveId(prev => {
            if (prev) return prev;
            const hashId = window.location.hash.slice(1);
            if (!hashId) return null;
            const openList = list.filter(s => !closedIdsRef.current.has(s.id));
            return openList.some(s => s.id === hashId) ? hashId : null;
          });
        },

        onSessionState: (sid, state) => {
          setSessionStates(prev => {
            const existing = prev[sid];
            // Merge messages: keep any local messages not in server state
            const serverMsgIds = new Set((state.messages || []).map((m: any) => m.id));
            const localOnly = existing?.messages?.filter(m => !serverMsgIds.has(m.id)) || [];
            const mergedMessages = [...(state.messages || []), ...localOnly];
            return {
              ...prev,
              [sid]: {
                ...emptyLocalState(),
                ...state,
                messages: mergedMessages,
                // Preserve local-only fields (server doesn't track these,
                // so the spread of `state` would otherwise wipe them every
                // time we re-subscribe — e.g. switching to another tab and
                // back).
                editorDirty: existing?.editorDirty ?? false,
                contextTokens: existing?.contextTokens ?? 0,
                reviewComments: existing?.reviewComments ?? {},
                openMockup: existing?.openMockup ?? null,
                lastMockup: existing?.lastMockup ?? null,
                mockupComments: existing?.mockupComments ?? {},
                mockupInspect: false,
                openPlan: existing?.openPlan ?? null,
                lastPlan: existing?.lastPlan ?? null,
                planComments: existing?.planComments ?? [],
                planRequestId: existing?.planRequestId ?? null,
              },
            };
          });
          // Restore terminal messages from running processes
          c.listProcesses(sid).then(procs => {
            if (procs.length === 0) return;
            setSessionStates(prev => {
              const s = prev[sid];
              if (!s) return prev;
              const existingTermIds = new Set(s.messages.filter(m => m.isTerminal).map(m => m.id));
              const newTermMsgs = procs
                .filter(p => !existingTermIds.has(p.id))
                .map(p => ({
                  id: p.id,
                  role: 'system' as const,
                  content: p.output || '',
                  isTerminal: true,
                  terminalCommand: p.command,
                  exitCode: p.exitCode ?? undefined,
                  timestamp: p.startedAt,
                }));
              if (newTermMsgs.length === 0) return prev;
              return { ...prev, [sid]: { ...s, messages: [...s.messages, ...newTermMsgs] } };
            });
          }).catch(() => {});
        },

        onMessage: (sid, msg) => {
          setSessionStates(prev => {
            const s = prev[sid] || emptyLocalState();
            // Deduplicate by ID — message may already exist from session_state restore
            if (s.messages.some(m => m.id === msg.id)) return prev;
            const contextTokens = msg.usage
              ? msg.usage.input_tokens + msg.usage.output_tokens
              : s.contextTokens;
            // If this is the server echo of an optimistic user message, upgrade
            // the local entry in place so it picks up the authoritative `seq`
            // and sorts into the correct timeline slot.
            if (msg.role === 'user' && msg.seq != null) {
              const idx = s.messages.findIndex(m =>
                m.role === 'user' && m.seq == null && !m.isPending && m.content === msg.content
              );
              if (idx !== -1) {
                const next = [...s.messages];
                next[idx] = msg;
                return { ...prev, [sid]: { ...s, messages: next, partialText: '', partialThinking: msg.isThinking ? '' : s.partialThinking, contextTokens } };
              }
            }
            return {
              ...prev,
              [sid]: {
                ...s,
                messages: [...s.messages, msg],
                partialText: '',
                // Clear the live thinking preview only when the matching
                // permanent isThinking message arrives — otherwise an
                // unrelated tool_use or text message would wipe a thought
                // that's still streaming above it.
                partialThinking: msg.isThinking ? '' : s.partialThinking,
                contextTokens,
              },
            };
          });
        },

        onPartialText: (sid, text) => {
          setSessionStates(prev => {
            const s = prev[sid] || emptyLocalState();
            return { ...prev, [sid]: { ...s, partialText: text } };
          });
        },

        onPartialThinking: (sid, text) => {
          setSessionStates(prev => {
            const s = prev[sid] || emptyLocalState();
            return { ...prev, [sid]: { ...s, partialThinking: text } };
          });
        },

        onPermissionRequest: (sid, req) => {
          setSessionStates(prev => {
            const s = prev[sid] || emptyLocalState();
            return { ...prev, [sid]: { ...s, permRequest: req } };
          });
          playChime();
          // Notify when window is not focused
          if (!document.hasFocus()) {
            const body = req.toolName + (req.input?.file_path ? `: ${String(req.input.file_path).split('/').pop()}` : req.input?.command ? `: ${String(req.input.command).slice(0, 60)}` : '');
            isPermissionGranted().then(granted => {
              if (granted) sendNotification({ title: 'Claude needs approval', body });
            }).catch(() => {});
          }
        },

        onPermissionCancelled: (sid, requestId) => {
          setSessionStates(prev => {
            const s = prev[sid];
            if (!s || s.permRequest?.requestId !== requestId) return prev;
            return { ...prev, [sid]: { ...s, permRequest: null } };
          });
        },

        onStatus: (sid, status) => {
          if (status === 'connected' || status === 'disconnected' || status === 'connecting' || status === 'error') {
            setStatuses(prev => ({ ...prev, [sid]: status as ConnectionStatus }));
          }
          if (status === 'turn_complete') {
            // Only chime when the session was actually streaming before (i.e. an
            // in-flight turn just finished). Avoids chimes on reconnect replays.
            let wasStreaming = false;
            setSessionStates(prev => {
              const s = prev[sid] || emptyLocalState();
              wasStreaming = !!s.isStreaming;
              return { ...prev, [sid]: { ...s, isStreaming: false, wasInterrupted: false, partialText: '', partialThinking: '' } };
            });
            if (wasStreaming) playChime();
            setTurnCompleteIds(prev => new Set(prev).add(sid));
            setTimeout(() => setTurnCompleteIds(prev => { const next = new Set(prev); next.delete(sid); return next; }), 3000);
          } else if (status === 'streaming') {
            setSessionStates(prev => {
              const s = prev[sid] || emptyLocalState();
              return { ...prev, [sid]: { ...s, isStreaming: true, wasInterrupted: false } };
            });
          } else if (status === 'interrupted') {
            // Server signals the previous turn died without onTurnComplete
            // (provider crash, hard exit, socket teardown mid-tool). Drop the
            // "thinking" state and surface a red dot in the tab so the user
            // knows to retry instead of staring at a stale orange forever.
            setSessionStates(prev => {
              const s = prev[sid] || emptyLocalState();
              return { ...prev, [sid]: { ...s, isStreaming: false, partialText: '', partialThinking: '', wasInterrupted: true } };
            });
          }
        },

        onTerminalData: (sid, procId, text) => {
          setSessionStates(prev => {
            const s = prev[sid] || emptyLocalState();
            const hasScreenClear = text.includes('\x1b[2J') || text.includes('\x1b[3J');
            return {
              ...prev,
              [sid]: {
                ...s,
                messages: s.messages.map(m =>
                  m.id === procId
                    ? { ...m, content: hasScreenClear ? text : m.content + text }
                    : m
                ),
              },
            };
          });
        },

        onTerminalExit: (sid, procId, code) => {
          setSessionStates(prev => {
            const s = prev[sid] || emptyLocalState();
            return {
              ...prev,
              [sid]: {
                ...s,
                messages: s.messages.map(m =>
                  m.id === procId ? { ...m, exitCode: code } : m
                ),
              },
            };
          });
          refreshGitModified();
        },

        onTodos: (sid, todos) => {
          setSessionStates(prev => {
            const s = prev[sid] || emptyLocalState();
            return { ...prev, [sid]: { ...s, todos } };
          });
        },

        // The auto-approved indicator is now baked into the tool_use ChatMessage
        // itself (`autoApproved: true`) and rendered as a badge in the ToolBubble
        // header — no separate system message is created. The callback remains
        // for protocol compatibility but is a no-op.
        onAutoApproved: () => {},

        onSessionName: (sid, name) => {
          setSessions(prev => prev.map(s => s.id === sid && s.name.startsWith('Session ') ? { ...s, name } : s));
        },

        onInitInfo: (sid, info) => {
          setSessionStates(prev => {
            const s = prev[sid] || emptyLocalState();
            return { ...prev, [sid]: { ...s, initInfo: info } };
          });
          setSessions(prev => prev.map(s => s.id === sid ? {
            ...s,
            model: info.model || s.model,
          } : s));
        },

        onSupportedModels: (sid, models) => {
          setSessionStates(prev => {
            const s = prev[sid] || emptyLocalState();
            return { ...prev, [sid]: { ...s, supportedModels: models } };
          });
        },

        // Server-initiated "open file in editor" — triggered by the
        // in-process SDK tool `open_file_in_editor`. We read the file via
        // the bridge client and drop it into that session's side editor;
        // the user sees it when they switch to the tab.
        onOpenFile: async (sid, path, line) => {
          const client = clientRef.current;
          if (!client) return;
          const file = await client.readFile(path);
          if (!file) return;
          updateLocalState(sid, s => ({
            ...s,
            openFile: line != null ? { ...file, line } : file,
            openMockup: null,
            openTerminalId: null,
            diffView: null,
            editorDirty: false,
          }));
        },

        // Server-initiated "open mockup preview" — triggered by the
        // in-process SDK tools `mockup_write` / `mockup_edit`. Drops the
        // HTML into the side panel where it renders inside a sandboxed
        // iframe.
        onOpenMockup: (sid, name, html) => {
          updateLocalState(sid, s => ({
            ...s,
            openMockup: { name, html },
            lastMockup: { name, html },
            openFile: null,
            openTerminalId: null,
            diffView: null,
            editorDirty: false,
          }));
        },

        // Initial-load + server-pushed preferences. Sent as the first WS
        // message on connect (so closed/archived/tabOrder are populated
        // before the sessions list arrives) and again whenever a server-side
        // mutation broadcasts an update (e.g. MCP tools creating a group or
        // moving sessions between groups).
        onPreferences: (prefs) => {
          if (Array.isArray(prefs.closedSessionIds)) {
            const s = new Set<string>(prefs.closedSessionIds as string[]);
            closedIdsRef.current = s;
            setClosedSessionIds(s);
          }
          if (Array.isArray(prefs.archivedSessionIds)) {
            const s = new Set<string>(prefs.archivedSessionIds as string[]);
            archivedIdsRef.current = s;
            setArchivedSessionIds(s);
          }
          if (Array.isArray(prefs.tabOrder)) {
            setTabOrder(prefs.tabOrder as string[]);
          }
          if (prefs.tabGroups && typeof prefs.tabGroups === 'object') {
            setTabGroups(prefs.tabGroups as any);
          }
          if (prefs.tabGroupMap && typeof prefs.tabGroupMap === 'object') {
            setTabGroupMap(prefs.tabGroupMap as any);
          }
          if (Array.isArray(prefs.pinnedSessionIds)) {
            setPinnedSessionIds(new Set(prefs.pinnedSessionIds as string[]));
          }
          if (typeof prefs.autoGroupSessions === 'boolean') {
            setAutoGroupSessions(prefs.autoGroupSessions);
          }
        },

        // External trigger (e.g. the `codiby` CLI) wants the UI to switch
        // to a specific session. Reopen it if it was closed/archived so the
        // tab is actually visible before we activate it.
        onFocusSession: (sid) => {
          if (closedIdsRef.current.has(sid)) {
            const next = new Set(closedIdsRef.current);
            next.delete(sid);
            closedIdsRef.current = next;
            setClosedSessionIds(next);
            persistPrefs({ closedSessionIds: [...next] });
          }
          if (archivedIdsRef.current.has(sid)) {
            const next = new Set(archivedIdsRef.current);
            next.delete(sid);
            archivedIdsRef.current = next;
            setArchivedSessionIds(next);
            persistPrefs({ archivedSessionIds: [...next] });
          }
          setActiveId(sid);
        },

        onWelcome: ({ spawnMode }) => {
          spawnModeRef.current = spawnMode;
        },

        onConnectionChange: (status) => {
          if (status === 'connected') {
            subscribedRef.current.clear();
            // Server pushes session list on connect — no need to request
          }
        },
      });

      clientRef.current = c;
      setClient(c);
    });

    return () => { cancelled = true; clientRef.current?.destroy(); };
  }, []);

  // Load PR links.
  useEffect(() => {
    async function loadPrLinks() {
      try {
        const base = await resolveServerUrl();
        const res = await fetch(`${base}/pr-links`);
        if (res.ok) setPrLinks(await res.json());
      } catch {}
    }
    loadPrLinks();
  }, []);

  // Track whether a plugin's <PluginDetailView /> wants right-panel space.
  useEffect(() => {
    const handler = (e: Event) => {
      const ev = e as CustomEvent<{ item: { itemId: string } | null }>;
      setPluginDetailOpen(!!ev.detail?.item);
    };
    window.addEventListener('codiby-code:linked-item-changed', handler as EventListener);
    return () => window.removeEventListener('codiby-code:linked-item-changed', handler as EventListener);
  }, []);

  // Close PR dropdown on outside click + fetch PRs when opened
  useEffect(() => {
    if (!showPrDropdown) return;
    const handler = () => setShowPrDropdown(false);
    document.addEventListener('click', handler);
    // Fetch PRs for current session cwd
    const cwd = active.initInfo?.cwd;
    if (cwd && clientRef.current) {
      clientRef.current.listPullRequests(cwd).then(prs => setSessionPrs(prs)).catch(() => {});
    }
    return () => document.removeEventListener('click', handler);
  }, [showPrDropdown]);

  // Pinned-to-bottom autoscroll: only nudge to the latest message when the
  // user is already there. If they scrolled up to read history, leave them
  // alone — the floating "scroll to latest" button below re-engages the pin.
  const stickToBottomRef = useRef(true);
  const [showScrollDown, setShowScrollDown] = useState(false);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickToBottomRef.current = true;
    setShowScrollDown(false);
  }, []);

  const handleMessagesScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 80;
    setShowScrollDown(distanceFromBottom > 200);
  }, []);

  const handleOpenTerminal = useCallback((id: string) => {
    const sid = activeId;
    if (sid) updateLocalState(sid, s => ({ ...s, openFile: null, openTerminalId: id, diffView: null, editorDirty: false }));
  }, [activeId, updateLocalState]);

  // App spawn mode: tell the bridge which tab is active so it can boot that
  // session's Claude process on demand. No-op when the bridge runs in
  // `service` mode (server already brought every active session online at
  // startup) — the server gates this by spawnMode anyway, so it's safe to
  // call unconditionally.
  useEffect(() => {
    if (!activeId) return;
    clientRef.current?.notifyActiveTab(activeId);
  }, [activeId, client]);

  // Sync active session to URL hash. The hash is what lets a webview reload
  // restore the previously-selected session, so we must NOT strip it on
  // mount when activeId is still null — `onSessions` reads the hash later
  // to do the restore. Only strip after a real null transition (e.g. the
  // user closed the last tab).
  const prevActiveIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (activeId) {
      window.history.replaceState(null, '', `#${activeId}`);
    } else if (prevActiveIdRef.current && window.location.hash) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    prevActiveIdRef.current = activeId;
  }, [activeId]);

  const active = getState(activeId);
  const { openFile, openMockup, openPlan, diffView, editorFullWidth, editorDirty, reviewComments, reviewMode, reviewFiles, reviewIndex, todos, input } = active;
  const openTerminal = active.openTerminalId ? active.messages.find(m => m.id === active.openTerminalId && m.isTerminal) || null : null;
  const hasRightPanel = !!openFile || !!openMockup || !!openPlan || !!openTerminal || !!diffView || pluginDetailOpen || !!openPR;

  // Snap back to the bottom whenever the active session changes — each tab
  // should open on its latest message, regardless of where the previous tab
  // had been scrolled. Done via a ref so the streaming-content effect below
  // can read the new pin state synchronously on the same render.
  useEffect(() => {
    stickToBottomRef.current = true;
    setShowScrollDown(false);
  }, [activeId]);

  useLayoutEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [activeId, active.messages.length, active.partialText, active.partialThinking]);

  // The composer textarea autosizes via inline `style.height` set in its
  // onInput handler. Clearing the value programmatically (after send, /clear,
  // history nav reset, etc.) doesn't fire `input`, so a long sent message
  // would leave the box visibly tall. Reset the inline height back to the
  // single-row baseline whenever the controlled value goes empty.
  useLayoutEffect(() => {
    if (input !== '') return;
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
  }, [input]);

  // Probe opencode once the bridge client is ready. The endpoint is
  // cached on the server side, so future calls (or a refresh of the
  // app) hit the cache instantly. We persist the result in state so
  // the model picker and provider gating in the New Session modal can
  // consume it without re-fetching per render. Depend on `client`
  // (state) rather than `clientRef.current` (ref): refs don't trigger
  // a re-run when they change, so a ref-only dep would silently miss
  // the moment the client becomes available.
  useEffect(() => {
    if (!client) return;
    if (opencodeInfo !== null) return;
    let cancelled = false;
    client.getOpencodeInfo()
      .then(info => { if (!cancelled) setOpencodeInfo({ available: info.available, models: info.models || [] }); })
      .catch(() => { if (!cancelled) setOpencodeInfo({ available: false, models: [] }); });
    return () => { cancelled = true; };
  }, [client, opencodeInfo]);

  // Jump to line when openFile.line changes (e.g. clicking different search results in same file)
  useEffect(() => {
    if (openFile?.line && editorRef.current) {
      const line = openFile.line;
      editorRef.current.revealLineInCenter(line);
      editorRef.current.setPosition({ lineNumber: line, column: 1 });
      editorRef.current.focus();
    }
  }, [openFile?.line, openFile?.path]);

  // Scroll when permission request appears (with delay for Monaco to mount)
  useEffect(() => {
    if (active.permRequest) {
      const scrollPermIntoView = () => {
        if (permRequestRef.current) {
          permRequestRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        } else {
          scrollToBottom();
        }
      };
      scrollPermIntoView();
      const t = setTimeout(scrollPermIntoView, 300);
      return () => clearTimeout(t);
    }
  }, [active.permRequest, scrollToBottom]);

  // Auto-open the plan side panel the first time we see an `ExitPlanMode`
  // permission request. We track `planRequestId` so re-renders (or the user
  // closing the panel mid-decision) don't pop it back open. New plan
  // proposals replace any prior comments — they're per-plan-instance.
  useEffect(() => {
    if (!activeId) return;
    const req = active.permRequest;
    if (!req || req.toolName !== 'ExitPlanMode') return;
    const content = typeof req.input.plan === 'string' ? req.input.plan as string : '';
    if (!content) return;
    if (active.planRequestId === req.requestId) return;
    const allowedPrompts = Array.isArray(req.input.allowedPrompts)
      ? req.input.allowedPrompts as { tool: string; prompt: string }[]
      : undefined;
    updateLocalState(activeId, s => ({
      ...s,
      openPlan: { content, allowedPrompts },
      lastPlan: { content, allowedPrompts },
      planComments: [],
      planRequestId: req.requestId,
      openFile: null,
      openMockup: null,
      openTerminalId: null,
      diffView: null,
      editorDirty: false,
    }));
  }, [activeId, active.permRequest, active.planRequestId]);

  // Re-fetch open file and git status when new messages arrive
  const msgLenRef = useRef(0);
  useEffect(() => {
    const len = active.messages.length;
    if (len === msgLenRef.current) return;
    msgLenRef.current = len;
    if (!client) return;
    // Debounce: wait a bit for rapid message bursts
    const t = setTimeout(() => {
      if (active.openFile && activeId) {
        const sid = activeId;
        const curFile = active.openFile;
        client.readFile(curFile.path).then(file => {
          if (file && file.content !== curFile.content) {
            updateLocalState(sid, s => ({ ...s, openFile: file }));
          }
        }).catch(() => {});
      }
      refreshGitModified();
    }, 1000);
    return () => clearTimeout(t);
  }, [active.messages.length]);

  const handleNewSession = () => {
    setShowNewSession(true);
  };

  const handleToggleAutoGroup = (next: boolean) => {
    setAutoGroupSessions(next);
    persistPrefs({ autoGroupSessions: next });
  };

  const handleCreateSession = async (cwd: string, provider?: string) => {
    const c = clientRef.current;
    if (!c) return;
    try {
      const session = await c.createSession(cwd, { provider });
      setActiveId(session.id);
      c.subscribe(session.id);
      subscribedRef.current.add(session.id);
      // Autogrouping runs server-side in POST /sessions; the updated tab
      // groups arrive via the next `preferences` broadcast.
    } catch {}
  };

  const handleSelectSession = async (id: string) => {
    const prevId = activeId;
    setActiveId(id);
    setVisibleMessageCount(200);
    historyIdxRef.current = -1;
    historyDraftRef.current = '';

    const session = sessions.find(s => s.id === id);
    const c = clientRef.current;
    if (!session || !c) return;

    // Unsubscribe from old session if switching
    if (prevId && prevId !== id) {
      // Keep subscribed so we still receive updates; just switch focus
    }

    const status = statuses[id];
    if (session.status === 'stopped' && (!status || status === 'disconnected')) {
      try {
        const updated = await c.resumeSession(id);
        setSessions(prev => prev.map(s => s.id === id ? updated : s));
        c.subscribe(updated.id);
        subscribedRef.current.add(updated.id);
        c.getSessionState(id);
      } catch (e) {
        console.error(`[select] Resume failed:`, e);
      }
    } else if (!status || status === 'disconnected') {
      c.subscribe(session.id);
      subscribedRef.current.add(session.id);
      c.getSessionState(id);
    } else {
      // Already subscribed — just request current state
      c.getSessionState(id);
    }
  };

  const updateClosedIds = (fn: (prev: Set<string>) => Set<string>) => {
    setClosedSessionIds(prev => {
      const next = fn(prev);
      closedIdsRef.current = next;
      persistPrefs({ closedSessionIds: [...next] });
      return next;
    });
  };

  const updateArchivedIds = (fn: (prev: Set<string>) => Set<string>) => {
    setArchivedSessionIds(prev => {
      const next = fn(prev);
      archivedIdsRef.current = next;
      persistPrefs({ archivedSessionIds: [...next] });
      return next;
    });
  };

  /** Move a closed session into the archived bucket. Triggered by the
   *  archive icon next to each row in the "+" dropdown. The session
   *  disappears from the dropdown but its history is kept and it can
   *  still be permanently deleted from the future archived-sessions
   *  management page. */
  const handleArchiveSession = (id: string) => {
    updateClosedIds(prev => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    updateArchivedIds(prev => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  };

  const [closingSessionId, setClosingSessionId] = useState<string | null>(null);
  const [unsavedClosePrompt, setUnsavedClosePrompt] = useState(false);

  const closeTab = (id: string) => {
    clientRef.current?.unsubscribe(id);
    subscribedRef.current.delete(id);
    clientRef.current?.stopSession(id).catch(() => {});
    setSessionStates(prev => { const next = { ...prev }; delete next[id]; return next; });
    updateClosedIds(prev => new Set(prev).add(id));
    if (activeId === id) {
      const openSessions = sessions.filter(s => s.id !== id && !closedSessionIds.has(s.id) && !archivedSessionIds.has(s.id));
      setActiveId(openSessions.length > 0 ? openSessions[0]!.id : null);
    }
  };

  const handleCloseTab = (id: string) => {
    const state = getState(id);
    const hasRunningProcesses = state.isStreaming ||
      state.messages.some(m => m.isTerminal && m.exitCode === undefined && m.terminalCommand);
    if (hasRunningProcesses) {
      setClosingSessionId(id);
    } else {
      closeTab(id);
    }
  };

  const confirmCloseTab = async () => {
    const id = closingSessionId;
    if (!id) return;
    setClosingSessionId(null);
    closeTab(id);
  };

  const [restoreSessionId, setRestoreSessionId] = useState<string | null>(null);
  const [restoreCommands, setRestoreCommands] = useState<string[]>([]);

  const handleReopenSession = (id: string) => {
    updateClosedIds(prev => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setActiveId(id);
    // Reconnect
    const session = sessions.find(s => s.id === id);
    if (session && clientRef.current) {
      clientRef.current.subscribe(session.id);
      subscribedRef.current.add(session.id);
      clientRef.current.getSessionState(id);
      // Check for saved commands
      if (session.saved_commands && session.saved_commands.length > 0) {
        setRestoreSessionId(id);
        setRestoreCommands(session.saved_commands);
      }
    }
  };

  /** Permanently delete a session — drops it from the registry, deletes
   *  history, and (when `opts.worktree`) removes the underlying git
   *  worktree. Also tidies up local prefs (groups, ordering, archived/closed
   *  buckets) so the on-disk prefs file doesn't keep dangling ids. */
  const handlePurgeSession = async (id: string, opts: { worktree?: boolean } = {}) => {
    const c = clientRef.current;
    if (!c) return;
    try {
      await c.purgeSession(id, opts);
    } catch (err) {
      console.error('[ChatApp] Purge failed:', err);
      return;
    }
    // Local cleanup so the active tab moves elsewhere if the deleted session
    // was the focused one. Mirrors closeTab() but for the destructive path.
    if (activeId === id) {
      const remaining = sessions.filter(s => s.id !== id && !closedSessionIds.has(s.id) && !archivedSessionIds.has(s.id));
      setActiveId(remaining.length > 0 ? remaining[0]!.id : null);
    }
    setSessionStates(prev => { const next = { ...prev }; delete next[id]; return next; });
    subscribedRef.current.delete(id);
    // Drop from local prefs maps
    updateClosedIds(prev => { const n = new Set(prev); n.delete(id); return n; });
    updateArchivedIds(prev => { const n = new Set(prev); n.delete(id); return n; });
    setTabOrder(prev => prev.filter(x => x !== id));
    setTabGroupMap(prev => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      persistPrefs({ tabGroupMap: next });
      return next;
    });
    // Note: server already broadcasts the updated session list via
    // broadcastSessionList(), so the UI will drop the row automatically.
  };

  /** `/clear` — archive the current chat under "Cleared: <name>" and replace
   *  the active tab with a freshly-spawned session at the same position
   *  (same tabOrder slot, same group). The fresh session inherits cwd, name,
   *  model, permissionMode, provider so the user sees no visible disruption
   *  beyond an empty conversation. The new session has its own claudeSessionId
   *  because handleCreateSession spawns a provider session with no resume id. */
  const clearSession = async (targetId: string) => {
    const c = clientRef.current;
    if (!c) return;
    const old = sessions.find(s => s.id === targetId);
    if (!old) return;

    const cwd = getState(targetId).initInfo?.cwd || old.cwd || '/';
    const originalName = old.name;
    const inheritedModel = old.model ?? null;
    const inheritedPermissionMode = old.permission_mode || 'default';
    const inheritedProvider = old.provider || 'claudeAgent';
    const groupId = tabGroupMap[targetId];

    let fresh;
    try {
      fresh = await c.createSession(cwd, {
        name: originalName,
        model: inheritedModel,
        permissionMode: inheritedPermissionMode,
        provider: inheritedProvider,
      });
    } catch (err) {
      console.error('[ChatApp] /clear createSession failed:', err);
      return;
    }

    // Rename the old chat so the archived list shows it as "Cleared: …",
    // then stop its provider (history file stays on disk).
    c.updateSession(targetId, { name: `Cleared: ${originalName}` }).catch(() => {});
    c.stopSession(targetId).catch(() => {});

    c.unsubscribe(targetId);
    subscribedRef.current.delete(targetId);
    setSessionStates(prev => { const next = { ...prev }; delete next[targetId]; return next; });

    updateArchivedIds(prev => {
      if (prev.has(targetId)) return prev;
      const next = new Set(prev); next.add(targetId); return next;
    });
    updateClosedIds(prev => {
      if (!prev.has(targetId)) return prev;
      const next = new Set(prev); next.delete(targetId); return next;
    });

    setTabOrder(prev => {
      const next = [...prev];
      const idx = next.indexOf(targetId);
      if (idx === -1) next.push(fresh.id);
      else next[idx] = fresh.id;
      persistPrefs({ tabOrder: next });
      return next;
    });

    if (groupId) {
      setTabGroupMap(prev => {
        const next = { ...prev };
        delete next[targetId];
        next[fresh.id] = groupId;
        persistPrefs({ tabGroupMap: next });
        return next;
      });
    }

    setActiveId(fresh.id);
    c.subscribe(fresh.id);
    subscribedRef.current.add(fresh.id);
  };

  /** State for the right-click → "Delete…" confirmation modal. Holds the
   *  cwd / worktree flag synchronously and back-fills uncommitted-change
   *  count once `getGitModified` returns. */
  const [deleteSessionPrompt, setDeleteSessionPrompt] = useState<{
    id: string;
    name: string;
    cwd: string;
    isWorktree: boolean;
    /** undefined while the git scan is in flight, then a number. */
    modifiedCount: number | undefined;
    /** Checkbox state — defaults to true when isWorktree (matches user
     *  expectation that "delete the session" includes the working tree). */
    deleteWorktree: boolean;
    /** True while the purge request is in flight, used to disable buttons. */
    submitting: boolean;
  } | null>(null);

  const handleRequestDeleteSession = async (id: string) => {
    const session = sessions.find(s => s.id === id);
    if (!session) return;
    // Match server-side `looksLikeWorktree` so the checkbox only appears
    // for paths the server can actually clean up.
    const isWorktree = /[\\/]\.wt[\\/]/.test(session.cwd);
    setDeleteSessionPrompt({
      id,
      name: session.name,
      cwd: session.cwd,
      isWorktree,
      modifiedCount: undefined,
      deleteWorktree: isWorktree,
      submitting: false,
    });
    // Async git status — only relevant when there's actually a worktree to
    // potentially destroy. Skip the network round-trip otherwise.
    if (isWorktree) {
      try {
        const modified = await clientRef.current?.getGitModified(session.cwd);
        setDeleteSessionPrompt(prev => prev && prev.id === id
          ? { ...prev, modifiedCount: modified?.length ?? 0 }
          : prev);
      } catch {
        setDeleteSessionPrompt(prev => prev && prev.id === id
          ? { ...prev, modifiedCount: 0 }
          : prev);
      }
    } else {
      setDeleteSessionPrompt(prev => prev && prev.id === id
        ? { ...prev, modifiedCount: 0 }
        : prev);
    }
  };

  const confirmDeleteSession = async () => {
    const prompt = deleteSessionPrompt;
    if (!prompt || prompt.submitting) return;
    setDeleteSessionPrompt({ ...prompt, submitting: true });
    await handlePurgeSession(prompt.id, { worktree: prompt.isWorktree && prompt.deleteWorktree });
    setDeleteSessionPrompt(null);
  };

  /** State for the group context-menu → "Delete group…" confirmation modal.
   *  Bulk-deletes every session in the group; worktrees are aggregated so the
   *  user gets a single uncommitted-changes summary and one checkbox. */
  const [deleteGroupPrompt, setDeleteGroupPrompt] = useState<{
    groupId: string;
    name: string;
    members: { id: string; name: string; cwd: string; isWorktree: boolean }[];
    /** Sum of uncommitted changes across all worktree members; undefined
     *  while the per-cwd git scans are still in flight. */
    modifiedCount: number | undefined;
    deleteWorktrees: boolean;
    submitting: boolean;
  } | null>(null);

  const handleRequestDeleteGroup = async (groupId: string) => {
    const grp = tabGroups[groupId];
    if (!grp) return;
    const members = sessions
      .filter(s => tabGroupMap[s.id] === groupId)
      .map(s => ({
        id: s.id,
        name: s.name,
        cwd: s.cwd,
        isWorktree: /[\\/]\.wt[\\/]/.test(s.cwd),
      }));
    const anyWorktree = members.some(m => m.isWorktree);
    setDeleteGroupPrompt({
      groupId,
      name: grp.name,
      members,
      modifiedCount: anyWorktree ? undefined : 0,
      deleteWorktrees: anyWorktree,
      submitting: false,
    });
    if (anyWorktree && clientRef.current) {
      try {
        const counts = await Promise.all(
          members
            .filter(m => m.isWorktree)
            .map(async m => {
              try { return (await clientRef.current!.getGitModified(m.cwd))?.length ?? 0; }
              catch { return 0; }
            }),
        );
        const total = counts.reduce((a, b) => a + b, 0);
        setDeleteGroupPrompt(prev => prev && prev.groupId === groupId
          ? { ...prev, modifiedCount: total }
          : prev);
      } catch {
        setDeleteGroupPrompt(prev => prev && prev.groupId === groupId
          ? { ...prev, modifiedCount: 0 }
          : prev);
      }
    }
  };

  const confirmDeleteGroup = async () => {
    const prompt = deleteGroupPrompt;
    if (!prompt || prompt.submitting) return;
    setDeleteGroupPrompt({ ...prompt, submitting: true });
    // Purge each member sequentially so server-side worktree removals don't
    // race against shared parent-repo locks.
    for (const m of prompt.members) {
      await handlePurgeSession(m.id, { worktree: m.isWorktree && prompt.deleteWorktrees });
    }
    // The orphan-pruning effect will remove the now-empty group entry, but
    // drop it eagerly so the menu/sidebar updates without waiting for the
    // tabGroupMap re-render.
    setTabGroups(prev => {
      if (!prev[prompt.groupId]) return prev;
      const next = { ...prev };
      delete next[prompt.groupId];
      persistPrefs({ tabGroups: next });
      return next;
    });
    setExpandedGroupIds(prev => {
      if (!prev.has(prompt.groupId)) return prev;
      const next = new Set(prev);
      next.delete(prompt.groupId);
      return next;
    });
    setDeleteGroupPrompt(null);
  };

  const confirmRestore = () => {
    const id = restoreSessionId;
    const cmds = restoreCommands;
    setRestoreSessionId(null);
    setRestoreCommands([]);
    if (!id || !clientRef.current) return;
    const session = sessions.find(s => s.id === id);
    const cwd = getState(id).initInfo?.cwd || session?.cwd || '/';
    // Re-run each command — server sends back terminal_data/terminal_exit
    for (const command of cmds) {
      const msgId = crypto.randomUUID();
      updateLocalState(id, s => ({
        ...s,
        messages: [...s.messages, {
          id: msgId,
          role: 'system' as const,
          content: '',
          isTerminal: true,
          terminalCommand: command,
          timestamp: Date.now(),
        }],
      }));
      clientRef.current!.execCommand(id, command, cwd);
    }
    // Clear saved commands on server
    clientRef.current.saveCommands(id, []);
  };

  const dismissRestore = () => {
    const id = restoreSessionId;
    setRestoreSessionId(null);
    setRestoreCommands([]);
    if (id && clientRef.current) {
      clientRef.current.saveCommands(id, []);
    }
  };

  const handleResumeSession = async (id: string) => {
    const c = clientRef.current;
    if (!c) return;
    try {
      const updated = await c.resumeSession(id);
      setSessions(prev => prev.map(s => s.id === id ? updated : s));
      c.subscribe(updated.id);
      subscribedRef.current.add(updated.id);
      setActiveId(id);
    } catch {}
  };

  const handleRenameSession = async (id: string, name: string) => {
    const c = clientRef.current;
    if (!c) return;
    try {
      const updated = await c.renameSession(id, name);
      setSessions(prev => prev.map(s => s.id === id ? updated : s));
    } catch {}
  };

  const handleSend = () => {
    const text = input.trim();
    if (!text && pastedImages.length === 0) return;
    if (!activeId || !clientRef.current) return;

    // Push to per-session input history
    if (text) {
      setSessionStates(prev => {
        const s = prev[activeId] || emptyLocalState();
        const hist = [...s.inputHistory, text];
        if (hist.length > 100) hist.shift();
        return { ...prev, [activeId]: { ...s, inputHistory: hist } };
      });
      historyIdxRef.current = -1;
      historyDraftRef.current = '';
    }

    // Client-side `/clear`: archive the current chat under "Cleared: …" and
    // replace the active tab with a fresh session in the same slot. Never
    // sent to Claude. Lives above /terminal so a future SDK-side `/clear`
    // can't override it.
    if (text === '/clear') {
      setInput('');
      clearSession(activeId);
      return;
    }

    // Interactive PTY terminal: /terminal [initial cmd]   or   /t [initial cmd]
    // Client-side only — never sent to Claude. Mirrors the `>` intercept below
    // but spawns a long-lived shell rendered inline via InteractiveTerminalBubble.
    const slashTermMatch = text.match(/^\/(terminal|t)(?:\s+([\s\S]*))?$/);
    if (slashTermMatch) {
      const initialCmd = slashTermMatch[2]?.trim() || '';
      const procId = crypto.randomUUID();
      const cwd = active.initInfo?.cwd || activeSession?.cwd || '/';
      updateLocalState(activeId, s => ({
        ...s,
        messages: [...s.messages, {
          id: procId,
          role: 'system' as const,
          content: '',
          isInteractiveTerminal: true,
          procId,
          terminalCommand: initialCmd || undefined,
          terminalCwd: cwd,
          timestamp: Date.now(),
        }],
      }));
      // Auto-activate + ensure expanded in the sticky panel.
      setActiveShellBySession(prev => ({ ...prev, [activeId]: procId }));
      setMinimizedShells(prev => { const n = new Set(prev); n.delete(procId); return n; });
      setInput('');
      // The InteractiveTerminalBubble (mounted next render) calls execShell itself
      // once its xterm instance has sized — we don't call it from here to avoid
      // a cols/rows mismatch with the rendered terminal.
      return;
    }

    // Terminal command: > command
    // Opens an interactive PTY bubble and runs the command as its first input,
    // so the user can Ctrl+C out of long-running commands or keep typing more
    // commands in the same shell after the first one exits.
    if (text.startsWith('>')) {
      const command = text.slice(1).trim();
      if (!command) return;
      const procId = crypto.randomUUID();
      const cwd = active.initInfo?.cwd || activeSession?.cwd || '/';

      updateLocalState(activeId, s => ({
        ...s,
        messages: [...s.messages, {
          id: procId,
          role: 'system' as const,
          content: '',
          isInteractiveTerminal: true,
          procId,
          terminalCommand: command,
          terminalCwd: cwd,
          timestamp: Date.now(),
        }],
      }));
      // Auto-activate this new shell + force it expanded in the sticky panel.
      setActiveShellBySession(prev => ({ ...prev, [activeId]: procId }));
      setMinimizedShells(prev => { const n = new Set(prev); n.delete(procId); return n; });
      setInput('');
      // InteractiveTerminalBubble will call execShell on mount and auto-send
      // `command + \r` once the PTY produces its first output.
      return;
    }

    const images = pastedImages.length > 0 ? pastedImages.map(({ media_type, data }) => ({ media_type, data })) : undefined;

    // If a permission/AskUserQuestion is pending, sending a new message means
    // the user wants to redirect — auto-deny the pending tool so the agent
    // unblocks and consumes the new message instead of staying parked.
    if (active.permRequest) {
      clientRef.current.respondToPermission(activeId, active.permRequest.requestId, false);
      updateLocalState(activeId, s => ({ ...s, permRequest: null }));
    }

    // Use the same effective text for the optimistic bubble and the server
    // payload — otherwise the content-based optimistic-upgrade match in
    // onMessage fails (local "" vs server " ") and both bubbles stick, with
    // the seqless optimistic one pinned to the tail by the seq-sort.
    const effectiveText = text || ' ';

    // Queue mode: if a turn is still in flight, push the bubble into the
    // message list as `isPending` and buffer the (id, text, images) tuple
    // for the drain effect. Lets the user line up follow-ups without
    // waiting for Claude — the bubble flips to a normal user message and
    // ships when the in-flight turn completes.
    const streamingNow = active.isStreaming;
    if (streamingNow) {
      const pendingId = crypto.randomUUID();
      const pendingMsg = {
        id: pendingId,
        role: 'user' as const,
        content: effectiveText,
        timestamp: Date.now(),
        images: images?.map(img => ({ media_type: img.media_type, data: img.data })),
        isPending: true,
      };
      updateLocalState(activeId, s => ({
        ...s,
        messages: [...s.messages, pendingMsg],
        pendingMessages: [
          ...s.pendingMessages,
          { id: pendingId, text: effectiveText, images },
        ],
      }));
      setInput('');
      setPastedImages([]);
      return;
    }

    const userMsg = {
      id: crypto.randomUUID(),
      role: 'user' as const,
      content: effectiveText,
      timestamp: Date.now(),
      images: images?.map(img => ({ media_type: img.media_type, data: img.data })),
    };
    updateLocalState(activeId, s => ({
      ...s,
      messages: [...s.messages, userMsg],
      isStreaming: true,
      wasInterrupted: false,
      partialText: '',
      partialThinking: '',
    }));
    setInput('');
    setPastedImages([]);
    clientRef.current.sendMessage(activeId, effectiveText, images);
  };

  const handlePermission = (requestId: string, allow: boolean, updatedInput?: Record<string, unknown>) => {
    if (!activeId || !clientRef.current) return;
    clientRef.current.respondToPermission(activeId, requestId, allow, updatedInput);
    updateLocalState(activeId, s => ({ ...s, permRequest: null }));
  };

  const handleInterrupt = () => {
    if (!activeId || !clientRef.current) return;
    clientRef.current.interrupt(activeId);
    updateLocalState(activeId, s => ({
      ...s,
      isStreaming: false,
      pendingMessages: [],
      // Also strip the queued bubbles from the message list — Stop is a
      // definite cancellation; we don't want them to keep sitting there.
      messages: s.messages.filter(m => !m.isPending),
    }));
  };

  const removePendingMessage = useCallback((sessionId: string, pendingId: string) => {
    updateLocalState(sessionId, s => ({
      ...s,
      pendingMessages: s.pendingMessages.filter(p => p.id !== pendingId),
      messages: s.messages.filter(m => m.id !== pendingId),
    }));
  }, [updateLocalState]);

  // Drain queued messages on streaming → idle transition. Each session keeps
  // its own queue; when its turn completes we pop the head, flip the
  // matching message bubble out of `isPending`, and ship it. Loop continues
  // naturally on the next streaming→idle transition.
  const lastStreamingRef = useRef<Record<string, boolean>>({});
  useEffect(() => {
    const client = clientRef.current;
    if (!client) return;
    for (const [sid, state] of Object.entries(sessionStates)) {
      const wasStreaming = lastStreamingRef.current[sid] ?? false;
      const isStreaming = !!state.isStreaming;
      if (wasStreaming && !isStreaming && state.pendingMessages.length > 0) {
        const [next, ...rest] = state.pendingMessages;
        if (!next) continue;
        updateLocalState(sid, s => ({
          ...s,
          messages: s.messages.map(m =>
            m.id === next.id ? { ...m, isPending: false, timestamp: Date.now() } : m
          ),
          isStreaming: true,
          wasInterrupted: false,
          partialText: '',
          partialThinking: '',
          pendingMessages: rest,
        }));
        client.sendMessage(sid, next.text, next.images);
        // Reflect the new streaming state immediately so the next render's
        // diff doesn't see a false→true→false flicker that re-fires drain.
        lastStreamingRef.current[sid] = true;
        continue;
      }
      lastStreamingRef.current[sid] = isStreaming;
    }
  }, [sessionStates, updateLocalState]);

  const contentRef = useRef<HTMLDivElement>(null);
  const termPanelRef = useRef<HTMLPreElement>(null);

  // Auto-scroll terminal panel to bottom
  useEffect(() => {
    if (!termPanelRef.current || !openTerminal) return;
    const el = termPanelRef.current;
    const raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [openTerminal?.content]);

  const handleFileOpen = async (path: string, line?: number) => {
    if (!client || !activeId) return;
    const file = await client.readFile(path);
    if (!file) return;
    // If the content area is too narrow for a split view, open editor fullscreen
    const contentWidth = contentRef.current?.offsetWidth ?? 1200;
    const needsFullWidth = contentWidth < 800;
    setSessionStates(prev => {
      const s = prev[activeId] || emptyLocalState();
      return {
        ...prev,
        [activeId]: {
          ...s,
          openFile: line ? { ...file, line } : file,
          openTerminalId: null,
          diffView: null,
          editorFullWidth: needsFullWidth ? true : s.editorFullWidth,
          editorDirty: false,
        },
      };
    });
  };

  const handleFileDiff = async (path: string) => {
    if (!client || !activeId) return;
    const sid = activeId;
    const [file, original] = await Promise.all([
      client.readFile(path),
      client.readFileOriginal(path),
    ]);
    if (file) {
      updateLocalState(sid, s => ({ ...s, openFile: null, openTerminalId: null, diffView: { path, original, modified: file.content } }));
    }
  };

  const handleFileDiffFullView = async (path: string) => {
    if (!client || !activeId) return;
    const sid = activeId;
    const [file, original] = await Promise.all([
      client.readFile(path),
      client.readFileOriginal(path),
    ]);
    if (file) {
      updateLocalState(sid, s => ({ ...s, openFile: null, openTerminalId: null, diffView: { path, original, modified: file.content }, editorFullWidth: !s.editorFullWidth }));
    }
  };

  const handleStartReview = () => {
    if (!activeId) return;
    const files = [...new Set([...gitModified.staged, ...gitModified.unstaged])].sort();
    if (files.length === 0) return;
    updateLocalState(activeId, s => ({ ...s, reviewMode: true, reviewFiles: files, reviewIndex: 0, editorFullWidth: true, openFile: null, openTerminalId: null }));
    loadReviewFile(files[0]!);
  };

  const loadReviewFile = async (path: string) => {
    if (!client || !activeId) return;
    const sid = activeId;
    const [file, original] = await Promise.all([
      client.readFile(path),
      client.readFileOriginal(path),
    ]);
    if (file) {
      updateLocalState(sid, s => ({ ...s, diffView: { path, original, modified: file.content } }));
    }
  };

  const handleReviewNav = (delta: number) => {
    if (!activeId) return;
    const st = getState(activeId);
    const newIdx = st.reviewIndex + delta;
    if (newIdx < 0 || newIdx >= st.reviewFiles.length) return;
    updateLocalState(activeId, s => ({ ...s, reviewIndex: newIdx }));
    loadReviewFile(st.reviewFiles[newIdx]!);
  };

  const handleSubmitReview = () => {
    if (!activeId || !clientRef.current) return;
    const st = getState(activeId);
    const allComments = Object.entries(st.reviewComments).flatMap(([path, cmts]) => {
      const rel = explorerRoot && path.startsWith(explorerRoot) ? path.slice(explorerRoot.length + 1) : path;
      return (cmts as ReviewComment[]).map(c => {
        const lineRef = c.startLine === c.endLine ? `L${c.startLine}` : `L${c.startLine}-${c.endLine}`;
        return `@${rel}:${lineRef} — ${c.text}`;
      });
    });
    if (allComments.length === 0) return;
    const reviewText = `Apply these changes to the code:\n${allComments.join('\n')}`;
    updateLocalState(activeId, s => ({
      ...s,
      messages: [...s.messages, { id: crypto.randomUUID(), role: 'user' as const, content: reviewText, timestamp: Date.now() }],
      isStreaming: true, wasInterrupted: false, partialText: '', partialThinking: '',
      reviewMode: false, reviewFiles: [], diffView: null, editorFullWidth: false, reviewComments: {},
    }));
    clientRef.current.sendMessage(activeId, reviewText);
  };

  const handleExitReview = () => {
    if (!activeId) return;
    updateLocalState(activeId, s => ({ ...s, reviewMode: false, reviewFiles: [], diffView: null, editorFullWidth: false }));
  };

  const explorerRootRef = useRef<string | null>(null);

  const refreshGitModified = useCallback(async () => {
    const root = explorerRootRef.current;
    if (!client || !root) return;
    const entries = await client.getGitModified(root);
    const staged = new Set<string>();
    const unstaged = new Set<string>();
    const untracked = new Set<string>();
    for (const e of entries) {
      if (e.staged) staged.add(e.path);
      else unstaged.add(e.path);
      if (e.untracked) untracked.add(e.path);
    }
    const result = { staged, unstaged, untracked };
    gitModifiedCacheRef.current[root] = result;
    // Only apply if still on the same root
    if (explorerRootRef.current === root) setGitModified(result);
  }, [client]);

  const untitledCountRef = useRef(0);
  const [saveAsPrompt, setSaveAsPrompt] = useState<{ content: string } | null>(null);
  const [saveAsPath, setSaveAsPath] = useState('');
  const saveAsInputRef = useRef<HTMLInputElement>(null);

  const handleNewFile = () => {
    if (!activeId) return;
    untitledCountRef.current++;
    const name = `untitled-${untitledCountRef.current}`;
    updateLocalState(activeId, s => ({
      ...s,
      openFile: { path: name, content: '' },
      openTerminalId: null,
      diffView: null,
      editorDirty: true,
    }));
  };

  const handleSaveAs = (content: string) => {
    const root = explorerRootRef.current || '';
    setSaveAsPath(root ? `${root}/` : '');
    setSaveAsPrompt({ content });
    setTimeout(() => saveAsInputRef.current?.focus(), 50);
  };

  const confirmSaveAs = async () => {
    if (!saveAsPrompt || !saveAsPath.trim() || !clientRef.current || !activeId) return;
    const path = saveAsPath.trim();
    const ok = await clientRef.current.writeFile(path, saveAsPrompt.content);
    if (ok) {
      updateLocalState(activeId, s => ({ ...s, openFile: { path, content: saveAsPrompt.content }, editorDirty: false }));
      refreshGitModified();
    }
    setSaveAsPrompt(null);
    setSaveAsPath('');
  };

  const handleSaveFileWrapped = async () => {
    if (!active.openFile || !activeId) return;
    // Untitled files need Save As
    if (active.openFile.path.startsWith('untitled-')) {
      const editor = editorRef.current;
      const content = editor?.getValue() || active.openFile.content;
      handleSaveAs(content);
      return;
    }
    // Normal save
    if (!clientRef.current) return;
    const editor = editorRef.current;
    if (!editor) return;
    const content = editor.getValue();
    const filePath = active.openFile.path;
    try {
      const ok = await clientRef.current.writeFile(filePath, content);
      if (ok) {
        updateLocalState(activeId, s => ({ ...s, openFile: { path: filePath, content }, editorDirty: false }));
        refreshGitModified();
      }
    } catch {}
  };

  const onChatResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    chatDragging.current = true;
    setChatResizing(true);
    const container = contentRef.current;
    if (!container) return;
    let lastPct = chatSplitPct;
    const onMove = (ev: MouseEvent) => {
      if (!chatDragging.current || !container) return;
      const rect = container.getBoundingClientRect();
      lastPct = Math.max(25, Math.min(75, ((ev.clientX - rect.left) / rect.width) * 100));
      setChatSplitPct(lastPct);
    };
    const onUp = () => {
      chatDragging.current = false;
      setChatResizing(false);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try { localStorage.setItem('claude-ui-chat-split', String(lastPct)); } catch {}
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [chatSplitPct]);

  const handleCloseCurrentPanel = () => {
    if (!activeId) return;
    const s = getState(activeId);
    const hasPanel = s.openFile || s.openTerminalId || s.diffView;
    if (hasPanel) {
      if (s.openFile && s.editorDirty) {
        setUnsavedClosePrompt(true);
        return;
      }
      updateLocalState(activeId, st => ({ ...st, openFile: null, openTerminalId: null, diffView: null, editorFullWidth: false, editorDirty: false }));
    } else {
      handleCloseTab(activeId);
    }
  };

  const saveRef = useRef(handleSaveFileWrapped);
  saveRef.current = handleSaveFileWrapped;
  const newFileRef = useRef(handleNewFile);
  newFileRef.current = handleNewFile;
  const closePanelRef = useRef(handleCloseCurrentPanel);
  closePanelRef.current = handleCloseCurrentPanel;

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      switch (e.key) {
        case 'k':
          e.preventDefault();
          setShowPalette(p => !p);
          break;
        case 'b':
          e.preventDefault();
          setExplorerCollapsed(c => !c);
          break;
        case 'l':
          e.preventDefault();
          inputRef.current?.focus();
          break;
        case 's':
          e.preventDefault();
          saveRef.current();
          break;
        case 'w':
          e.preventDefault();
          closePanelRef.current();
          break;
        case 'n':
          if (!e.shiftKey) {
            e.preventDefault();
            newFileRef.current();
          }
          break;
        case 'f':
          if (e.shiftKey) {
            e.preventDefault();
            setSidebarView('search');
            setExplorerCollapsed(false);
          }
          break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const activeStatus = activeId ? (statuses[activeId] || 'disconnected') : 'disconnected';
  const activeSession = sessions.find(s => s.id === activeId);

  // Bypass-mode warning gate. Switching a session to `bypassPermissions`
  // pops a confirmation modal the first time; the user can tick "don't show
  // again" to suppress it on future flips.
  const [pendingBypassSessionId, setPendingBypassSessionId] = useState<string | null>(null);

  const applyPermissionMode = useCallback((sessionId: string, mode: string) => {
    const c = clientRef.current;
    if (!c) return;
    setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, permission_mode: mode } : s));
    c.setPermissionMode(sessionId, mode);
    c.updateSession(sessionId, { permissionMode: mode }).catch(() => {});
  }, []);

  const requestPermissionMode = useCallback((sessionId: string, mode: string) => {
    if (mode === 'bypassPermissions' && shouldWarnBypass()) {
      setPendingBypassSessionId(sessionId);
      return;
    }
    applyPermissionMode(sessionId, mode);
  }, [applyPermissionMode]);

  // Shift+Tab cycles the active session's permission mode while the chat
  // input is focused. Outside the chat input we leave Shift+Tab alone so the
  // browser's reverse focus traversal still works.
  useEffect(() => {
    const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'] as const;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !e.shiftKey) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.activeElement !== inputRef.current) return;
      if (!activeId) return;
      if (!clientRef.current) return;
      e.preventDefault();
      const current = (activeSession?.permission_mode || 'default') as typeof PERMISSION_MODES[number];
      const idx = PERMISSION_MODES.indexOf(current);
      const next = PERMISSION_MODES[(idx === -1 ? 0 : idx + 1) % PERMISSION_MODES.length]!;
      requestPermissionMode(activeId, next);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeId, activeSession?.permission_mode, requestPermissionMode]);

  // Ordered sessions for tab bar — open = neither closed nor archived
  const orderedOpenSessions = useMemo(() => sessions
    .filter(s => !closedSessionIds.has(s.id) && !archivedSessionIds.has(s.id))
    .sort((a, b) => {
      const ai = tabOrder.indexOf(a.id);
      const bi = tabOrder.indexOf(b.id);
      return (ai === -1 ? Infinity : ai) - (bi === -1 ? Infinity : bi);
    }), [sessions, closedSessionIds, archivedSessionIds, tabOrder]);

  // Sessions surfaced in the "+" dropdown's CLOSED section. Archived
  // sessions are intentionally excluded — they live on the (future)
  // archived-sessions management page and never appear here.
  const closedSessions = useMemo(
    () => sessions.filter(s => closedSessionIds.has(s.id) && !archivedSessionIds.has(s.id)),
    [sessions, closedSessionIds, archivedSessionIds],
  );
  const sessionStreaming = useMemo(() => Object.fromEntries(Object.entries(sessionStates).map(([id, s]) => {
    // "Busy" covers the agent generating a response AND any Bash tool call
    // that hasn't returned yet — pair tool_use messages with their matching
    // tool_result via toolUseId and check for stragglers.
    let bashPending = false;
    const pending = new Set<string>();
    for (const m of s.messages) {
      if (m.toolName === 'Bash') pending.add(m.id);
      else if (m.isToolResult && m.toolUseId) pending.delete(m.toolUseId);
    }
    bashPending = pending.size > 0;
    return [id, !!s.isStreaming || bashPending];
  })), [sessionStates]);
  const sessionInterrupted = useMemo(() => Object.fromEntries(Object.entries(sessionStates).map(([id, s]) => [id, !!s.wasInterrupted])), [sessionStates]);
  const sessionHasPermission = useMemo(() => Object.fromEntries(Object.entries(sessionStates).map(([id, s]) => [id, !!s.permRequest])), [sessionStates]);
  // Per-session "last message at" timestamp — used by the vertical TabBar
  // to render a "5m ago" / "2h ago" / "3d ago" hint per tab. Falls back to
  // the session's createdAt if no messages exist yet.
  const sessionLastMessageAt = useMemo(() => {
    const out: Record<string, number> = {};
    for (const s of sessions) {
      const local = sessionStates[s.id];
      const msgs = local?.messages || [];
      // Walk from the end and pick the most recent timestamped message.
      // Ignore tool bookkeeping (tool use notifications, tool results) and
      // system notes — those are appended with Date.now() every time Claude
      // runs Read/Bash/Edit/etc. and would otherwise make the sort jump
      // around as tools stream in without a real user/assistant exchange.
      let last = 0;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.role === 'system') continue;
        if (m.toolName) continue;
        if (m.isToolResult) continue;
        const t = m.timestamp;
        if (typeof t === 'number' && t > last) { last = t; break; }
      }
      out[s.id] = last || (s.created_at ?? 0);
    }
    return out;
  }, [sessions, sessionStates]);

  const handleReorder = (fromId: string, toId: string) => {
    setTabOrder(prev => {
      // Ensure all open session IDs are in the order
      const openIds = sessions.filter(s => !closedSessionIds.has(s.id) && !archivedSessionIds.has(s.id)).map(s => s.id);
      const order = prev.filter(id => openIds.includes(id));
      for (const id of openIds) { if (!order.includes(id)) order.push(id); }
      // Move fromId to toId's position
      const fromIdx = order.indexOf(fromId);
      const toIdx = order.indexOf(toId);
      if (fromIdx === -1 || toIdx === -1) return prev;
      order.splice(fromIdx, 1);
      order.splice(toIdx, 0, fromId);
      persistPrefs({ tabOrder: order });
      return order;
    });
  };

  const explorerRoot = active.initInfo?.cwd || activeSession?.cwd || null;
  explorerRootRef.current = explorerRoot;

  // Load git modified when root changes — instant from cache, then refresh
  useEffect(() => {
    if (explorerRoot) {
      const cached = gitModifiedCacheRef.current[explorerRoot];
      if (cached) setGitModified(cached);
      else setGitModified({ staged: new Set(), unstaged: new Set(), untracked: new Set() });
    } else {
      setGitModified({ staged: new Set(), unstaged: new Set(), untracked: new Set() });
    }
    refreshGitModified();
  }, [explorerRoot, refreshGitModified]);

  // Fetch git branch for status bar
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const [branchMenu, setBranchMenu] = useState<{ local: string[]; remote: string[]; current: string; rect: DOMRect } | null>(null);
  const [branchFilter, setBranchFilter] = useState('');
  const branchBtnRef = useRef<HTMLButtonElement>(null);
  const branchInputRef = useRef<HTMLInputElement>(null);

  const openBranchMenu = () => {
    const c = clientRef.current;
    const root = explorerRootRef.current;
    const rect = branchBtnRef.current?.getBoundingClientRect() || new DOMRect(10, window.innerHeight - 30, 100, 20);
    setBranchMenu({ local: [], remote: [], current: gitBranch || '', rect });
    setBranchFilter('');
    if (c && root) {
      c.listBranches(root).then(data => {
        setBranchMenu(prev => prev ? { ...prev, local: data.local || [], remote: data.remote || [], current: data.current || '' } : null);
        setTimeout(() => branchInputRef.current?.focus(), 50);
      }).catch(() => {});
    }
  };

  const doCheckout = async (branch: string) => {
    const c = clientRef.current;
    const root = explorerRootRef.current;
    if (!c || !root) return;
    setBranchMenu(null);
    const result = await c.checkoutBranch(root, branch);
    if (result.ok && result.branch) {
      setGitBranch(result.branch);
      refreshGitModified();
    }
  };

  useEffect(() => {
    if (!client || !explorerRoot) { setGitBranch(null); return; }
    client.getGitInfo(explorerRoot).then(info => {
      setGitBranch(info.is_git ? info.branch || null : null);
    }).catch(() => setGitBranch(null));
  }, [client, explorerRoot]);

  // Client-side builtin slash commands (intercepted in handleSend, never sent to Claude).
  const BUILTIN_SLASH_COMMANDS = ['terminal', 't'];
  const sdkSlashCommands = active.initInfo?.slashCommands || [];
  const slashCommands = [...BUILTIN_SLASH_COMMANDS, ...sdkSlashCommands.filter((c: string) => !BUILTIN_SLASH_COMMANDS.includes(c))];
  const slash = useSlashCommands(input, slashCommands);
  const fileIndex = useFileIndex(client, explorerRoot);
  const fileMention = useFileMention(input, fileIndex);

  const paletteActions: PaletteAction[] = [
    { id: 'new-session', label: 'New Session', keys: ['command'], key: 'N', section: 'Sessions', onRun: () => setShowNewSession(true) },
    { id: 'focus-input', label: 'Focus Chat Input', keys: ['command'], key: 'L', section: 'Navigation', onRun: () => inputRef.current?.focus() },
    { id: 'toggle-explorer', label: explorerCollapsed ? 'Show File Explorer' : 'Hide File Explorer', keys: ['command'], key: 'B', section: 'Navigation', onRun: () => setExplorerCollapsed(c => !c) },
    { id: 'close-editor', label: 'Close Editor / Tab', keys: ['command'], key: 'W', section: 'Navigation', onRun: () => closePanelRef.current() },
    { id: 'new-file', label: 'New File', keys: ['command'], key: 'N', section: 'Editor', onRun: handleNewFile },
    { id: 'save-file', label: 'Save File', keys: ['command'], key: 'S', section: 'Editor', onRun: handleSaveFileWrapped },
    { id: 'clear-chat', label: 'Clear Chat', section: 'Session', onRun: () => { if (activeId) clearSession(activeId); } },
    { id: 'organize-tabs', label: 'Organize Tabs by Folder', section: 'Sessions', onRun: async () => {
      const c = clientRef.current;
      if (!c) return;
      const openSessions = sessions.filter(s => !closedSessionIds.has(s.id) && !archivedSessionIds.has(s.id));
      // Resolve the main repo path for each session's cwd via git info
      const cwds = openSessions.map(s => getState(s.id).initInfo?.cwd || s.cwd || '/');
      const uniqueCwds = [...new Set(cwds)];
      const gitInfos = await Promise.all(uniqueCwds.map(cwd => c.getGitInfo(cwd).catch(() => ({ is_git: false as const }))));
      const cwdToFolder: Record<string, string> = {};
      for (let i = 0; i < uniqueCwds.length; i++) {
        const info = gitInfos[i]!;
        let repoPath: string;
        if (info.is_git && info.worktrees?.length) {
          // First worktree is always the main repo
          repoPath = info.worktrees[0]!.path;
        } else if (info.is_git && info.top_level) {
          repoPath = info.top_level;
        } else {
          repoPath = uniqueCwds[i]!;
        }
        cwdToFolder[uniqueCwds[i]!] = repoPath.split('/').filter(Boolean).pop() || '/';
      }
      // Group sessions by resolved folder name
      const folderMap: Record<string, string[]> = {};
      for (const s of openSessions) {
        const cwd = getState(s.id).initInfo?.cwd || s.cwd || '/';
        const folder = cwdToFolder[cwd] || cwd.split('/').filter(Boolean).pop() || '/';
        (folderMap[folder] ||= []).push(s.id);
      }
      const newGroups = { ...tabGroups };
      const newMap = { ...tabGroupMap };
      // Remove existing group assignments for open sessions
      for (const s of openSessions) delete newMap[s.id];
      // Clean up now-empty groups
      const usedGroupIds = new Set(Object.values(newMap));
      for (const gid of Object.keys(newGroups)) {
        if (!usedGroupIds.has(gid)) delete newGroups[gid];
      }
      for (const [folder, ids] of Object.entries(folderMap)) {
        if (ids.length < 1) continue;
        let groupId = Object.keys(newGroups).find(gid => newGroups[gid]!.name === folder);
        if (!groupId) {
          groupId = crypto.randomUUID();
          const color = GROUP_COLORS[groupColorIdx++ % GROUP_COLORS.length]!;
          newGroups[groupId] = { id: groupId, name: folder, color };
        }
        for (const id of ids) newMap[id] = groupId;
      }
      setTabGroups(newGroups);
      setTabGroupMap(newMap);
      persistPrefs({ tabGroups: newGroups, tabGroupMap: newMap });
    } },
    { id: 'command-palette', label: 'Command Palette', keys: ['command'], key: 'K', section: 'Navigation', onRun: () => {} },
    ...(activeId && active.isStreaming ? [{ id: 'stop', label: 'Stop Generation', keys: ['escape'] as string[], section: 'Session', onRun: handleInterrupt }] : []),
    ...sessions.map(s => ({
      id: `switch-${s.id}`,
      label: `Switch to ${s.name}`,
      section: 'Sessions',
      onRun: () => handleSelectSession(s.id),
    })),
    ...slashCommands.map(cmd => ({
      id: `slash-${cmd}`,
      label: `/${cmd}`,
      section: 'Slash Commands',
      onRun: () => { setInput(`/${cmd} `); inputRef.current?.focus(); },
    })),
  ];

  const handleSlashSelect = (cmd: string) => {
    setInput(`/${cmd} `);
  };

  const handleFileMentionSelect = (file: { name: string; path: string; rel: string; type?: 'file' | 'dir' }) => {
    // Replace @query with @filepath (trailing slash signals directory)
    const before = input.slice(0, fileMention.atIdx);
    const suffix = file.type === 'dir' ? '/' : '';
    setInput(`${before}@${file.rel}${suffix} `);
  };

  // LSP language IDs that we support
  const LSP_LANGUAGES = new Set(['typescript', 'typescriptreact', 'javascript', 'javascriptreact']);

  const handleEditorMount = useCallback((editor: MonacoEditor.IStandaloneCodeEditor, monaco: Monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    // Jump to line if specified (e.g. from search results)
    if (openFile?.line) {
      const line = openFile.line;
      setTimeout(() => {
        editor.revealLineInCenter(line);
        editor.setPosition({ lineNumber: line, column: 1 });
        editor.focus();
      }, 50);
    }
    // Cmd+Option+K: reference file/selection in chat
    editor.addAction({
      id: 'reference-in-chat',
      label: 'Reference in Chat',
      keybindings: [
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyK,
      ],
      run: (ed) => {
        const model = ed.getModel();
        if (!model) return;
        const selection = ed.getSelection();
        const hasSelection = selection && !selection.isEmpty();
        const filePath = openFile?.path || '';
        const relativePath = explorerRoot && filePath.startsWith(explorerRoot)
          ? filePath.slice(explorerRoot.length + 1)
          : filePath;

        let reference: string;
        if (hasSelection) {
          const startLine = selection!.startLineNumber;
          const endLine = selection!.endLineNumber;
          const lineRef = startLine === endLine ? `L${startLine}` : `L${startLine}-${endLine}`;
          reference = `@${relativePath}:${lineRef}`;
        } else {
          reference = `@${relativePath}`;
        }

        setInput(prev => {
          const sep = prev && !prev.endsWith(' ') ? ' ' : '';
          return `${prev}${sep}${reference} `;
        });
        // Focus the chat input
        setTimeout(() => inputRef.current?.focus(), 50);
      },
    });

    // --- Fix with AI (quick fix + context menu) ---
    const fixWithAiCommandId = 'fix-with-ai-' + Math.random().toString(36).slice(2);
    monaco.editor.registerCommand(fixWithAiCommandId, (_accessor: any, message: string) => {
      setInput(message);
      setTimeout(() => inputRef.current?.focus(), 50);
    });

    monaco.languages.registerCodeActionProvider('*', {
      provideCodeActions(model, _range, context) {
        const diagnostics = context.markers.filter(m => m.severity >= monaco.MarkerSeverity.Warning);
        if (diagnostics.length === 0) return { actions: [], dispose() {} };

        const filePath = openFile?.path || '';
        const relativePath = explorerRoot && filePath.startsWith(explorerRoot)
          ? filePath.slice(explorerRoot.length + 1)
          : filePath;

        // Deduplicate by message to avoid showing identical quick fixes
        const seen = new Set<string>();
        const actions: any[] = [];
        for (const marker of diagnostics) {
          if (seen.has(marker.message)) continue;
          seen.add(marker.message);
          const line = marker.startLineNumber;
          const message = `Fix this error in @${relativePath}:L${line}\n\`\`\`\n${marker.message}\n\`\`\``;
          actions.push({
            title: `Fix with AI: ${marker.message.slice(0, 60)}${marker.message.length > 60 ? '…' : ''}`,
            kind: 'quickfix',
            diagnostics: [marker],
            command: { id: fixWithAiCommandId, title: 'Fix with AI', arguments: [message] },
          });
        }

        return { actions, dispose() {} };
      },
    });

    // Keybinding: Cmd+Shift+. to fix the error at cursor with AI
    editor.addAction({
      id: 'fix-error-with-ai',
      label: 'Fix with AI',
      keybindings: [
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Period,
      ],
      precondition: undefined,
      run: (ed) => {
        const position = ed.getPosition();
        const model = ed.getModel();
        if (!position || !model) return;
        const markers = monaco.editor.getModelMarkers({ resource: model.uri })
          .filter(m => m.severity >= monaco.MarkerSeverity.Warning &&
            position.lineNumber >= m.startLineNumber && position.lineNumber <= m.endLineNumber);
        if (markers.length === 0) return;
        const filePath = openFile?.path || '';
        const relativePath = explorerRoot && filePath.startsWith(explorerRoot)
          ? filePath.slice(explorerRoot.length + 1) : filePath;
        const seen = new Set<string>();
        const errors: string[] = [];
        for (const m of markers) {
          if (seen.has(m.message)) continue;
          seen.add(m.message);
          errors.push(m.message);
        }
        const line = position.lineNumber;
        setInput(`Fix this error in @${relativePath}:L${line}\n\`\`\`\n${errors.join('\n')}\n\`\`\``);
        setTimeout(() => inputRef.current?.focus(), 50);
      },
    });

    // --- Breakpoint gutter ---
    editor.onMouseDown((e) => {
      if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && e.target.position) {
        const line = e.target.position.lineNumber;
        const filePath = openFile?.path;
        if (filePath) {
          setDebugBreakpoints(prev => {
            const existing = prev.find(bp => bp.file === filePath && bp.line === line);
            if (existing) return prev.filter(bp => bp !== existing);
            return [...prev, { file: filePath, line, enabled: true }];
          });
        }
      }
    });

    // --- LSP integration ---
    // Disable Monaco's built-in TS/JS diagnostics — LSP provides its own
    monaco.languages.typescript?.typescriptDefaults?.setDiagnosticsOptions({
      noSemanticValidation: true, noSyntaxValidation: true,
    });
    monaco.languages.typescript?.javascriptDefaults?.setDiagnosticsOptions({
      noSemanticValidation: true, noSyntaxValidation: true,
    });

    // Determine language from file extension
    const model = editor.getModel();
    const langId = model?.getLanguageId();
    if (langId && LSP_LANGUAGES.has(langId) && activeId) {
      // Start LSP client for this session if not already running
      const needsNewClient = !lspClientRef.current || lspSessionIdRef.current !== activeId;
      if (needsNewClient) {
        lspClientRef.current?.dispose();
        const sessionCwd = active.initInfo?.cwd || sessions.find(s => s.id === activeId)?.cwd || '/';
        setLspStatus('connecting');
        resolveServerUrl().then(serverUrl => {
          const lsp = new LspClient({ serverUrl, sessionId: activeId!, languageId: 'typescript', rootUri: `file://${sessionCwd}`, monaco });
          lspClientRef.current = lsp;
          lspSessionIdRef.current = activeId;
          lsp.start().then(() => {
            setLspStatus('running');
            // Open the current document
            if (openFile) {
              lsp.openDocument(openFile.path, openFile.content, langId);
            }
          }).catch((e) => {
            console.warn('LSP start failed:', e);
            setLspStatus('error');
          });
        });
      } else if (lspClientRef.current && openFile) {
        // LSP already running — just open this document
        lspClientRef.current.openDocument(openFile.path, openFile.content, langId);
      }

      // Listen for content changes to sync with LSP
      const changeDisposable = editor.onDidChangeModelContent(() => {
        const content = editor.getModel()?.getValue();
        if (content !== undefined && openFile?.path && lspClientRef.current) {
          lspClientRef.current.changeDocument(openFile.path, content);
        }
      });
      // Clean up on next mount
      return () => changeDisposable.dispose();
    }
  }, [openFile, explorerRoot, activeId]);

  // Track previous openFile path to close documents in LSP when switching files
  const prevOpenFilePathRef = useRef<string | null>(null);
  useEffect(() => {
    const prevPath = prevOpenFilePathRef.current;
    const newPath = openFile?.path || null;
    if (prevPath && prevPath !== newPath && lspClientRef.current) {
      lspClientRef.current.closeDocument(prevPath);
    }
    prevOpenFilePathRef.current = newPath;
  }, [openFile?.path]);

  // Update breakpoint + debug line decorations in the editor
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    const filePath = openFile?.path;
    if (!filePath) return;

    const decorations: any[] = [];

    // Breakpoint dots
    for (const bp of debugBreakpoints) {
      if (bp.file !== filePath || !bp.enabled) continue;
      decorations.push({
        range: new monaco.Range(bp.line, 1, bp.line, 1),
        options: {
          isWholeLine: false,
          glyphMarginClassName: 'debug-breakpoint',
          glyphMarginHoverMessage: { value: 'Breakpoint' },
        },
      });
    }

    // Current debug line
    if (debugLine && debugLine.file === filePath) {
      decorations.push({
        range: new monaco.Range(debugLine.line, 1, debugLine.line, 1),
        options: {
          isWholeLine: true,
          className: 'debug-current-line',
          glyphMarginClassName: 'debug-current-arrow',
        },
      });
    }

    debugDecorationsRef.current = editor.deltaDecorations(debugDecorationsRef.current, decorations);
  }, [debugBreakpoints, debugLine, openFile?.path]);

  const restartLsp = useCallback(async () => {
    if (!activeId || !monacoRef.current) return;
    lspClientRef.current?.dispose();
    lspClientRef.current = null;
    lspSessionIdRef.current = null;
    setLspStatus('connecting');
    const sessionCwd = active.initInfo?.cwd || sessions.find(s => s.id === activeId)?.cwd || '/';
    const serverUrl = await resolveServerUrl();
    const monaco = monacoRef.current;
    const lsp = new LspClient({ serverUrl, sessionId: activeId, languageId: 'typescript', rootUri: `file://${sessionCwd}`, monaco });
    lspClientRef.current = lsp;
    lspSessionIdRef.current = activeId;
    try {
      await lsp.start();
      setLspStatus('running');
      if (openFile) {
        const langId = monaco.editor.getModel(monaco.Uri.file(openFile.path))?.getLanguageId();
        lsp.openDocument(openFile.path, openFile.content, langId);
      }
    } catch (e) {
      console.warn('LSP restart failed:', e);
      setLspStatus('error');
    }
  }, [activeId, active.initInfo?.cwd, openFile]);

  // Dispose LSP client when session changes or component unmounts
  useEffect(() => {
    return () => {
      lspClientRef.current?.dispose();
      lspClientRef.current = null;
      lspSessionIdRef.current = null;
      setLspStatus('off');
    };
  }, []);

  return (
    <Providers>
      <div className="h-screen bg-base flex flex-col overflow-hidden">
        {/* Titlebar drag region */}
        <div
          data-tauri-drag-region
          className="fixed top-0 left-0 right-0 h-[28px] z-[9999]"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        />
        <div className="flex-1 flex min-h-0 min-w-0 pt-[28px]">
          <TabBar
            sessions={orderedOpenSessions}
            closedSessions={closedSessions}
            activeSessionId={activeId}
            sessionStatuses={statuses}
            sessionStreaming={sessionStreaming}
            sessionInterrupted={sessionInterrupted}
            sessionTurnComplete={turnCompleteIds}
            sessionHasPermission={sessionHasPermission}
            sessionLastMessageAt={sessionLastMessageAt}
            pinnedSessionIds={pinnedSessionIds}
            onTogglePin={handleTogglePin}
            onSelect={handleSelectSession}
            onNew={handleNewSession}
            onClose={handleCloseTab}
            onReopen={handleReopenSession}
            onRename={handleRenameSession}
            onReorder={handleReorder}
            tabGroups={tabGroups}
            tabGroupMap={tabGroupMap}
            expandedGroupIds={expandedGroupIds}
            onCreateGroup={handleCreateGroup}
            onGroupTabs={handleGroupTabs}
            onAddToGroup={handleAddToGroup}
            onUngroupTab={handleUngroupTab}
            onToggleGroup={handleToggleGroup}
            onRenameGroup={handleRenameGroup}
            onChangeGroupColor={handleChangeGroupColor}
            onChangeGroupIcon={handleChangeGroupIcon}
            onArchiveSession={handleArchiveSession}
            onRequestDelete={handleRequestDeleteSession}
            onRequestDeleteGroup={handleRequestDeleteGroup}
            onNewSessionInGroup={handleNewSessionInGroup}
            onNewSessionInWorktreeForGroup={handleNewSessionInWorktreeForGroup}
            collapsed={tabsCollapsed}
            onToggleCollapsed={toggleTabsCollapsed}
          />
          {/* Activity Bar */}
          <div className="w-10 bg-[#161616] border-r border-border flex flex-col items-center py-2 gap-1 shrink-0">
            <button
              className={`w-8 h-8 flex items-center justify-center rounded-md transition-colors ${sidebarView === 'explorer' && !explorerCollapsed ? 'text-zinc-200 bg-surface-light' : 'text-zinc-600 hover:text-zinc-300'}`}
              onClick={() => { if (sidebarView === 'explorer' && !explorerCollapsed) setExplorerCollapsed(true); else { setSidebarView('explorer'); setExplorerCollapsed(false); } }}
              title="Explorer (Cmd+B)"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 7V17C3 18.1046 3.89543 19 5 19H19C20.1046 19 21 18.1046 21 17V9C21 7.89543 20.1046 7 19 7H13L11 5H5C3.89543 5 3 5.89543 3 7Z" /></svg>
            </button>
            <button
              className={`w-8 h-8 flex items-center justify-center rounded-md transition-colors ${sidebarView === 'search' && !explorerCollapsed ? 'text-zinc-200 bg-surface-light' : 'text-zinc-600 hover:text-zinc-300'}`}
              onClick={() => { if (sidebarView === 'search' && !explorerCollapsed) setExplorerCollapsed(true); else { setSidebarView('search'); setExplorerCollapsed(false); } }}
              title="Search (Cmd+Shift+F)"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="11" cy="11" r="7" /><path d="M16 16L21 21" strokeLinecap="round" /></svg>
            </button>
            <button
              className={`w-8 h-8 flex items-center justify-center rounded-md transition-colors ${sidebarView === 'plugins' && !explorerCollapsed ? 'text-zinc-200 bg-surface-light' : 'text-zinc-600 hover:text-zinc-300'}`}
              onClick={() => { if (sidebarView === 'plugins' && !explorerCollapsed) setExplorerCollapsed(true); else { setSidebarView('plugins'); setExplorerCollapsed(false); } }}
              title="Plugins"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="3" width="7" height="9" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" /><rect x="14" y="12" width="7" height="9" rx="1" /><rect x="3" y="16" width="7" height="5" rx="1" /></svg>
            </button>
            {hasRightPanel && editorFullWidth && (
              <button
                className="w-8 h-8 flex items-center justify-center rounded-md transition-colors text-violet-400 hover:text-violet-300 bg-violet-500/10 hover:bg-violet-500/20"
                onClick={() => { if (activeId) updateLocalState(activeId, s => ({ ...s, editorFullWidth: false })); }}
                title="Show Chat"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
            )}
            <div className="flex-1" />
            <button
              className={`w-8 h-8 flex items-center justify-center rounded-md transition-colors ${sidebarView === 'settings' && !explorerCollapsed ? 'text-zinc-200 bg-surface-light' : 'text-zinc-600 hover:text-zinc-300'}`}
              onClick={() => { if (sidebarView === 'settings' && !explorerCollapsed) setExplorerCollapsed(true); else { setSidebarView('settings'); setExplorerCollapsed(false); } }}
              title="Settings"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></svg>
            </button>
          </div>

          {/* Side Panel: Explorer or Search */}
          {activeId && sidebarView === 'explorer' && (
          <FileExplorer
            client={client}
            rootPath={explorerRoot}
            collapsed={explorerCollapsed}
            onToggle={() => setExplorerCollapsed(c => !c)}
            onFileOpen={handleFileOpen}
            onFileDiff={handleFileDiff}
            onFileDiffFullView={handleFileDiffFullView}
            gitModified={gitModified}
            activeSessionId={activeId}
            onOpenTerminal={(command) => {
              const msg = active.messages.findLast(m => m.isTerminal && m.terminalCommand === command);
              if (msg) { if (activeId) updateLocalState(activeId, s => ({ ...s, openFile: null, openTerminalId: msg.id, diffView: null, editorDirty: false })); }
            }}
            onStartReview={handleStartReview}
            onRefreshGit={refreshGitModified}
            tools={active.initInfo?.tools}
            sessionName={activeSession?.name}
          />
          )}

          {/* Search Panel */}
          {activeId && sidebarView === 'search' && !explorerCollapsed && (
            <SearchPanel client={client} rootPath={explorerRoot} onFileOpen={handleFileOpen} onClose={() => setExplorerCollapsed(true)} />
          )}

          {/* Plugin sidebar panels — populated by sideloaded plugins */}
          {sidebarView === 'plugins' && !explorerCollapsed && (
            <div className="h-full flex flex-col bg-surface border-r border-border" style={{ width: 280 }}>
              <div className="flex items-center justify-between px-3 h-9 border-b border-border shrink-0">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Plugins</span>
                <button onClick={() => setExplorerCollapsed(true)} className="text-zinc-600 hover:text-zinc-300 text-sm">×</button>
              </div>
              <div className="flex-1 overflow-y-auto">
                <PluginSidebarPanels />
              </div>
            </div>
          )}

          {/* Settings Panel */}
          {sidebarView === 'settings' && !explorerCollapsed && (
            <SettingsPanel
              onClose={() => setExplorerCollapsed(true)}
              tabGroups={tabGroups}
              tabGroupMap={tabGroupMap}
              onDeleteGroup={handleDeleteGroup}
              autoGroupSessions={autoGroupSessions}
              onToggleAutoGroup={handleToggleAutoGroup}
            />
          )}

          <div className="flex-1 flex flex-col min-w-0">
            {!activeId ? (
              <WelcomeScreen
                sessions={sessions}
                closedSessionIds={closedSessionIds}
                archivedSessionIds={archivedSessionIds}
                sessionLastMessageAt={sessionLastMessageAt}
                onNewSession={handleNewSession}
                onReopenSession={handleReopenSession}
                onOpenCommandPalette={() => setShowPalette(true)}
                onOpenSettings={() => { setSidebarView('settings'); setExplorerCollapsed(false); }}
                onOpenSearch={() => { setSidebarView('search'); setExplorerCollapsed(false); }}
                onToggleExplorer={() => setExplorerCollapsed(c => !c)}
              />
            ) : (
              <>
                {/* Info bar */}
                <div className="border-b border-border px-3 py-1 flex items-center gap-3 shrink-0">
                  {explorerCollapsed && (
                    <button
                      className="text-zinc-600 hover:text-zinc-300 text-sm"
                      onClick={() => setExplorerCollapsed(false)}
                      title="Show file explorer"
                    >
                      &#x2630;
                    </button>
                  )}
                  {activeSession?.provider && (
                    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-surface-light text-zinc-300 font-semibold">
                      {activeSession.provider === 'claudeAgent' ? 'Claude'
                        : activeSession.provider === 'codex' ? 'Codex'
                        : activeSession.provider === 'opencode' ? 'OpenCode'
                        : activeSession.provider}
                    </span>
                  )}
                  {active.initInfo && (
                    <span className="text-xs text-zinc-600">
                      v{active.initInfo.version} · {active.initInfo.tools.length} tools
                    </span>
                  )}

                  {/* Plugin-contributed linked-item pickers (e.g. ticket linker) */}
                  <PluginLinkedItemPickers sessionId={activeId} />

                  {/* PR badge */}
                  {activeId && (
                    <div className="relative">
                      {prLinks[activeId] ? (
                        <button
                          className="flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] bg-green-500/15 text-green-400 border border-green-500/25 hover:bg-green-500/25 transition-colors"
                          onClick={(e) => {
                            e.stopPropagation();
                            const linked = prLinks[activeId!];
                            setOpenPR({ number: linked.prNumber, title: linked.title, url: linked.url, headRefName: linked.headRefName, state: linked.state });
                            if (activeId) updateLocalState(activeId, s => ({ ...s, openFile: null, diffView: null }));
                            // Clear any active plugin detail view so the PR can take the right pane.
                            window.dispatchEvent(new CustomEvent('codiby-code:linked-item-changed', { detail: { providerId: '', item: null } }));
                          }}
                          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setShowPrDropdown(!showPrDropdown); }}
                          title={`PR #${prLinks[activeId].prNumber}: ${prLinks[activeId].title} (right-click to change)`}
                        >
                          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M6 9v12M18 9a9 9 0 01-9 9" /></svg>
                          #{prLinks[activeId].prNumber}
                        </button>
                      ) : (
                        <button
                          className="flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] text-zinc-600 hover:text-zinc-400 hover:bg-surface-light border border-transparent transition-colors"
                          onClick={(e) => { e.stopPropagation(); setShowPrDropdown(!showPrDropdown); }}
                          title="Link a PR"
                        >
                          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M6 9v12M18 9a9 9 0 01-9 9" /></svg>
                          Link PR
                        </button>
                      )}

                      {showPrDropdown && (
                        <div
                          className="absolute left-0 top-7 z-50 w-80 max-h-64 bg-[#2a2a2a] border border-border-light rounded-lg shadow-xl overflow-hidden"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {prLinks[activeId!] && (
                            <button
                              className="w-full flex items-center gap-2 px-3 py-2 text-[11px] text-red-400 hover:bg-surface-light transition-colors border-b border-border text-left"
                              onClick={() => {
                                const sid = activeId!;
                                setPrLinks(prev => { const next = { ...prev }; delete next[sid]; return next; });
                                setShowPrDropdown(false);
                                resolveServerUrl().then(base =>
                                  fetch(`${base}/pr-link/${sid}`, { method: 'DELETE' }).catch(() => {})
                                );
                              }}
                            >
                              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" /></svg>
                              Unlink #{prLinks[activeId!].prNumber}
                            </button>
                          )}
                          <div className="overflow-y-auto max-h-52">
                            {sessionPrs.length === 0 ? (
                              <div className="px-3 py-3 text-[11px] text-zinc-600">No pull requests found for this repo.</div>
                            ) : sessionPrs.map(pr => {
                              const isLinked = prLinks[activeId!]?.prNumber === pr.number;
                              const stateColor = pr.isDraft ? 'bg-amber-400' : pr.state === 'OPEN' ? 'bg-green-400' : pr.state === 'MERGED' ? 'bg-violet-400' : 'bg-zinc-500';
                              return (
                                <button
                                  key={pr.number}
                                  className={`w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-surface-light transition-colors ${isLinked ? 'bg-green-500/10' : ''}`}
                                  onClick={() => {
                                    const sid = activeId!;
                                    const link = { prNumber: pr.number, title: pr.title, url: pr.url, headRefName: pr.headRefName, state: pr.state };
                                    setPrLinks(prev => ({ ...prev, [sid]: link }));
                                    setShowPrDropdown(false);
                                    resolveServerUrl().then(base =>
                                      fetch(`${base}/pr-link/${sid}`, {
                                        method: 'PUT',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify(link),
                                      }).catch(() => {})
                                    );
                                  }}
                                >
                                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 mt-1.5 ${stateColor}`} />
                                  <div className="min-w-0">
                                    <div className="flex items-center gap-1">
                                      <span className="text-[10px] text-green-400 shrink-0">#{pr.number}</span>
                                      <span className="text-[11px] text-zinc-300 truncate">{pr.title}</span>
                                    </div>
                                    <span className="text-[10px] text-zinc-600 font-mono">{pr.headRefName}</span>
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {active.lastMockup && (
                    <button
                      className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] border transition-colors ${
                        active.openMockup
                          ? 'bg-violet-500/15 text-violet-300 border-violet-500/30 hover:bg-violet-500/25'
                          : 'bg-surface-light text-zinc-400 border-border hover:text-violet-300 hover:border-violet-500/30'
                      }`}
                      onClick={() => {
                        if (!activeId) return;
                        updateLocalState(activeId, s => {
                          if (s.openMockup) return { ...s, openMockup: null, editorFullWidth: false };
                          if (!s.lastMockup) return s;
                          return {
                            ...s,
                            openMockup: s.lastMockup,
                            openFile: null,
                            openTerminalId: null,
                            diffView: null,
                            editorDirty: false,
                          };
                        });
                      }}
                      title={active.openMockup ? `Hide mockup "${active.lastMockup.name}"` : `Reopen mockup "${active.lastMockup.name}"`}
                    >
                      <span className="text-[10px]">▣</span>
                      <span className="truncate max-w-[12rem]">{active.lastMockup.name}</span>
                    </button>
                  )}

                  <span className="flex-1" />
                  {active.initInfo?.cwd && (
                    <span className="text-xs text-zinc-600 font-mono truncate max-w-sm">
                      {active.initInfo.cwd}
                    </span>
                  )}
                </div>

              <div ref={contentRef} className="flex-1 flex min-h-0">
                {/* Chat panel */}
                <div
                  className={`flex flex-col min-w-0 overflow-hidden relative ${hasRightPanel && editorFullWidth ? 'hidden' : hasRightPanel ? 'shrink-0' : 'flex-1'}`}
                  style={hasRightPanel && !editorFullWidth ? { width: `${chatSplitPct}%` } : undefined}
                >
                  <div className="flex flex-1 min-h-0">
                  {/* Messages */}
                  <div ref={scrollRef} onScroll={handleMessagesScroll} className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 space-y-1">
                    {active.messages.length === 0 && !active.partialText && (
                      <div className="flex items-center justify-center h-full">
                        <p className="text-zinc-600 text-sm">
                          {activeStatus === 'connecting' ? 'Connecting to Claude...' :
                           activeStatus === 'connected' ? 'Send a message to start' :
                           'Waiting for connection...'}
                        </p>
                      </div>
                    )}
                    {active.messages.length > visibleMessageCount && (
                      <button
                        className="w-full py-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                        onClick={() => setVisibleMessageCount(prev => prev + 200)}
                      >
                        Show {Math.min(200, active.messages.length - visibleMessageCount)} older messages ({active.messages.length - visibleMessageCount} hidden)
                      </button>
                    )}
                    {(() => {
                      // Interactive PTY shells (isInteractiveTerminal) live in the sticky
                      // bottom terminal panel. Legacy one-shot `isTerminal` bubbles
                      // (listProcesses reattach / pre-PTY `>` path) stay hidden until
                      // the user opens them from the Processes panel — but model-spawned
                      // managed terminals (spawn_terminal SDK tool, isManagedTerminal)
                      // render inline so the user sees them appear without clicking.
                      const grouped = collapseToolRuns(groupMessages(
                        [...active.messages]
                          .filter(m => !m.isInteractiveTerminal && !(m.isTerminal && !m.isManagedTerminal))
                          .sort((a, b) => (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER))
                          .slice(-visibleMessageCount)
                      ));
                      const activeAskId = active.permRequest?.toolName === 'AskUserQuestion' ? active.permRequest.requestId : null;
                      return grouped.map((item, i) => {
                        const isLast = i === grouped.length - 1;
                        if ('agent' in item) {
                          return <AgentBubble key={item.agent.id} agent={item.agent} children={item.children} onOpenTerminal={handleOpenTerminal} />;
                        }
                        if ('toolRun' in item) {
                          // Auto-collapse once anything follows this group:
                          // a later grouped item, OR Claude's currently
                          // streaming partial text (rendered below the map).
                          const hasContentAfter = i < grouped.length - 1 || !!active.partialText;
                          return (
                            <ToolRunBubble
                              key={item.items[0]!.id}
                              group={item}
                              onOpenTerminal={handleOpenTerminal}
                              sessionId={activeId}
                              client={clientRef.current || undefined}
                              hasContentAfter={hasContentAfter}
                            />
                          );
                        }
                        // Provide the answer callback for every unanswered AskUserQuestion that's last in view —
                        // if the pending permission is still alive, resolve it; otherwise post the answers as a
                        // follow-up user message so the agent can continue.
                        const isAskTool = item.toolName === 'AskUserQuestion' && Array.isArray((item.toolInput as any)?.questions);
                        const hasResult = !!(item as any).toolResult;
                        const answerCb = isLast && isAskTool && !hasResult
                          ? (answers: Record<string, string>) => {
                              if (activeAskId && item.id === activeAskId && active.permRequest) {
                                handlePermission(active.permRequest.requestId, true, { ...active.permRequest.input, answers });
                                return;
                              }
                              if (!clientRef.current || !activeId) return;
                              // Stale: no live pending permission. Ask the server to persist a
                              // synthetic tool_result for this tool_use (so the card flips to
                              // answered), then send the answers as a follow-up user message so
                              // the agent can continue the conversation.
                              clientRef.current.respondToPermission(activeId, item.id, true, { ...(item.toolInput as object), answers });
                              const lines = Object.entries(answers).map(([q, v]) => `- ${q} → ${v}`);
                              clientRef.current.sendMessage(activeId, lines.join('\n'));
                            }
                          : undefined;
                        return (
                          <div key={item.id} id={`msg-${item.id}`}>
                            <MessageBubble
                              message={item}
                              onOpenTerminal={handleOpenTerminal}
                              isLast={isLast}
                              onAnswerAskUser={answerCb}
                              sessionId={activeId}
                              client={clientRef.current || undefined}
                              interactiveMinimized={item.isInteractiveTerminal ? minimizedShells.has(item.id) : undefined}
                              onToggleInteractiveMinimize={item.isInteractiveTerminal ? toggleShellMinimized : undefined}
                              onCancelPending={activeId ? (id) => removePendingMessage(activeId, id) : undefined}
                            />
                          </div>
                        );
                      });
                    })()}
                    {active.partialThinking && (
                      <div className="py-1">
                        <div className="flex items-start gap-1.5 text-[12px] text-zinc-500">
                          <Sparkles className="w-3 h-3 mt-1 shrink-0 opacity-70 text-violet-300/70 animate-pulse" />
                          <span className="font-medium uppercase tracking-wide text-[10px] mt-[3px] shrink-0">
                            Thinking
                          </span>
                        </div>
                        <div className="mt-1 ml-5 pl-2.5 border-l border-zinc-800/80">
                          <p className="text-[12px] italic text-zinc-400 leading-relaxed whitespace-pre-wrap break-words">
                            {active.partialThinking}
                            <span className="inline-block ml-0.5 w-1.5 h-3 bg-zinc-500/70 align-middle animate-pulse" />
                          </p>
                        </div>
                      </div>
                    )}
                    {active.partialText && (
                      <div className="py-1">
                        <p className="text-[13px] text-zinc-300 whitespace-pre-wrap break-words leading-relaxed">
                          {active.partialText}
                        </p>
                      </div>
                    )}
                    {/* Inline permission request — skip for AskUserQuestion, the tool card renders it inline */}
                    {active.permRequest && active.permRequest.toolName !== 'AskUserQuestion' && (() => {
                      const req = active.permRequest;
                      const input = req.input;
                      const isEdit = req.toolName === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string';
                      const isBash = req.toolName === 'Bash' && typeof input.command === 'string';
                      const isWrite = req.toolName === 'Write' && typeof input.content === 'string';
                      const isPlan = req.toolName === 'ExitPlanMode';
                      const planContent = isPlan && typeof input.plan === 'string' ? input.plan as string : null;
                      const allowedPrompts = isPlan && Array.isArray(input.allowedPrompts) ? input.allowedPrompts as { tool: string; prompt: string }[] : [];
                      const isAskUser = req.toolName === 'AskUserQuestion';
                      const askQuestions = isAskUser && Array.isArray(input.questions) ? input.questions as { question: string; header?: string; options?: { label: string; description?: string }[]; multiSelect?: boolean }[] : [];
                      const filePath = typeof input.file_path === 'string' ? input.file_path : null;
                      const ext = filePath?.split('.').pop() || '';
                      const langMap: Record<string, string> = { ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact', py: 'python', rs: 'rust', go: 'go', json: 'json', css: 'css', html: 'html', md: 'markdown', sh: 'shell', bash: 'shell', yml: 'yaml', yaml: 'yaml', toml: 'toml', sql: 'sql' };
                      const lang = langMap[ext] || 'plaintext';
                      const oldLines = isEdit ? (input.old_string as string).split('\n').length : 0;
                      const newLines = isEdit ? (input.new_string as string).split('\n').length : 0;
                      const diffHeight = isEdit ? Math.min(Math.max(oldLines, newLines) * 19 + 20, 300) : 0;

                      return (
                        <div ref={permRequestRef} className={`py-1 pl-3 ml-1 border-l-2 ${isAskUser ? 'border-violet-500/50' : 'border-amber-500/50'}`}>
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-[11px] font-mono text-violet-400">{isAskUser ? 'Question' : req.toolName}</span>
                            {!isAskUser && <span className="text-[10px] text-amber-400 bg-amber-400/10 px-1.5 py-0.5 rounded">permission required</span>}
                          </div>
                          {filePath && (
                            <p className="text-[11px] text-zinc-500 font-mono mb-1 truncate">{filePath}</p>
                          )}
                          {req.description && !filePath && (
                            <p className="text-[12px] text-zinc-400 mb-1">{req.description}</p>
                          )}

                          {/* Edit tool: inline diff */}
                          {isEdit && (
                            <div className="rounded overflow-hidden border border-border mb-2" style={{ height: diffHeight }}>
                              <DiffEditor
                                original={input.old_string as string}
                                modified={input.new_string as string}
                                language={lang}
                                theme="vs-dark"
                                options={{
                                  readOnly: true,
                                  renderSideBySide: true,
                                  minimap: { enabled: false },
                                  scrollBeyondLastLine: false,
                                  fontSize: 12,
                                  lineNumbers: 'off',
                                  glyphMargin: false,
                                  folding: false,
                                  lineDecorationsWidth: 0,
                                  overviewRulerLanes: 0,
                                  scrollbar: { vertical: 'hidden', horizontal: 'auto' },
                                  renderOverviewRuler: false,
                                  contextmenu: false,
                                  domReadOnly: true,
                                }}
                              />
                            </div>
                          )}

                          {/* Bash tool: command block */}
                          {isBash && (
                            <div className="rounded bg-[#0d0d0d] border border-border mb-2 px-3 py-2">
                              <pre className="text-[12px] font-mono text-green-400 whitespace-pre-wrap break-all m-0 leading-snug">
                                <span className="text-zinc-600 select-none">$ </span>{input.command as string}
                              </pre>
                            </div>
                          )}

                          {/* Write tool: file content preview */}
                          {isWrite && (
                            <div className="rounded overflow-hidden border border-border mb-2" style={{ height: Math.min(((input.content as string).split('\n').length) * 19 + 20, 250) }}>
                              <Editor
                                value={input.content as string}
                                language={lang}
                                theme="vs-dark"
                                options={{
                                  readOnly: true,
                                  minimap: { enabled: false },
                                  scrollBeyondLastLine: false,
                                  fontSize: 12,
                                  lineNumbers: 'on',
                                  glyphMargin: false,
                                  folding: false,
                                  overviewRulerLanes: 0,
                                  scrollbar: { vertical: 'hidden', horizontal: 'auto' },
                                  renderOverviewRuler: false,
                                  contextmenu: false,
                                  domReadOnly: true,
                                }}
                              />
                            </div>
                          )}

                          {/* ExitPlanMode: plan body lives in the side panel
                              (auto-opened by an effect above). Inline we just
                              render a compact pointer + a Reopen button so the
                              chat doesn't go blank if the user closed it. */}
                          {isPlan && (
                            <div className="rounded border border-violet-500/30 bg-violet-500/5 mb-2 px-3 py-2 flex items-center justify-between gap-3">
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="text-[10px] text-violet-400">◆</span>
                                <span className="text-[11px] text-violet-300 font-semibold uppercase tracking-wide shrink-0">Plan</span>
                                <span className="text-[11px] text-zinc-500 truncate">
                                  {planContent ? (planContent.split('\n').find(l => l.trim()) || '').slice(0, 80) : 'No plan content'}
                                </span>
                              </div>
                              {planContent && activeId && !openPlan && (
                                <button
                                  className="text-[11px] text-violet-300 hover:text-violet-200 hover:bg-violet-500/15 rounded px-2 py-0.5 shrink-0"
                                  onClick={() => updateLocalState(activeId, s => ({
                                    ...s,
                                    openPlan: { content: planContent, allowedPrompts },
                                    lastPlan: { content: planContent, allowedPrompts },
                                    openFile: null, openMockup: null, openTerminalId: null, diffView: null,
                                  }))}
                                  title="Reopen plan in the side panel"
                                >
                                  Open in side panel
                                </button>
                              )}
                            </div>
                          )}

                          {/* AskUserQuestion: interactive form */}
                          {isAskUser && askQuestions.length > 0 && (
                            <AskUserQuestionForm
                              questions={askQuestions}
                              onSubmit={(answers) => {
                                handlePermission(req.requestId, true, { ...input, answers });
                              }}
                            />
                          )}

                          {/* Fallback for other tools */}
                          {!isEdit && !isBash && !isWrite && !isPlan && !isAskUser && (
                            <pre className="text-[11px] text-zinc-500 whitespace-pre-wrap break-all m-0 mb-2 bg-transparent p-0 max-h-40 overflow-auto leading-tight">
                              {JSON.stringify(input, null, 2)}
                            </pre>
                          )}

                          {!isAskUser && <div className="flex items-center gap-2">
                            <button
                              className="flex items-center gap-1.5 px-3 py-1 rounded text-[12px] bg-green-600/15 text-green-400 hover:bg-green-600/25 transition-colors"
                              onClick={() => {
                                handlePermission(req.requestId, true);
                                if (isPlan && activeId && clientRef.current) {
                                  setSessions(prev => prev.map(s => s.id === activeId ? { ...s, permission_mode: 'acceptEdits' } : s));
                                }
                              }}
                            >
                              Allow
                            </button>
                            {isPlan && (
                              <button
                                className="flex items-center gap-1.5 px-3 py-1 rounded text-[12px] bg-violet-600/15 text-violet-400 hover:bg-violet-600/25 transition-colors"
                                onClick={() => {
                                  handlePermission(req.requestId, true);
                                  if (activeId && clientRef.current) {
                                    setSessions(prev => prev.map(s => s.id === activeId ? { ...s, permission_mode: 'acceptEdits' } : s));
                                    clientRef.current.setPermissionMode(activeId, 'acceptEdits');
                                    clientRef.current.updateSession(activeId, { permissionMode: 'acceptEdits' }).catch(() => {});
                                  }
                                }}
                              >
                                Approve &amp; Accept Edits
                              </button>
                            )}
                            <button
                              className="flex items-center gap-1.5 px-3 py-1 rounded text-[12px] bg-red-600/15 text-red-400 hover:bg-red-600/25 transition-colors"
                              onClick={() => handlePermission(req.requestId, false)}
                            >
                              Deny
                            </button>
                          </div>}
                        </div>
                      );
                    })()}
                  </div>

                  {/* Task panel */}
                  {todos.length > 0 && (
                    <div className="w-48 border-l border-border shrink-0 flex flex-col overflow-hidden">
                      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border shrink-0">
                        <span className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">Tasks</span>
                        <span className="text-[10px] text-zinc-600">{todos.filter(t => t.status === 'completed').length}/{todos.length}</span>
                      </div>
                      <div className="flex-1 overflow-y-auto px-2 py-1.5">
                        {todos.map((todo, i) => (
                          <div key={i} className={`flex items-start gap-1.5 text-[11px] py-0.5 ${todo.status === 'completed' ? 'text-zinc-600' : todo.status === 'in_progress' ? 'text-zinc-200' : 'text-zinc-500'}`}>
                            <span className="w-4 text-center shrink-0 mt-px">
                              {todo.status === 'completed' ? <span className="text-green-400">&#x2713;</span> :
                               todo.status === 'in_progress' ? <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse inline-block" /> :
                               <span className="w-1.5 h-1.5 rounded-full border border-zinc-600 inline-block" />}
                            </span>
                            <span className={todo.status === 'completed' ? 'line-through' : ''}>
                              {todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  </div>

                  {/* Interactive terminals: sticky bottom panel (badges + active xterm).
                      All shells are mounted (hidden via `display:none`) so their xterm
                      state survives switching. */}
                  {(() => {
                    const shells = active.messages.filter(m => m.isInteractiveTerminal);
                    if (shells.length === 0 || !activeId) return null;
                    const activeShellId = activeShellBySession[activeId] || shells[shells.length - 1]!.id;
                    const activeMinimized = minimizedShells.has(activeShellId);
                    return (
                      <div className="shrink-0 border-t border-border bg-surface/40">
                        {/* Badge bar */}
                        <div className="flex items-center gap-1.5 px-3 py-1.5 overflow-x-auto">
                          <span className="text-[10px] text-zinc-600 shrink-0 font-mono pr-1">shells</span>
                          {shells.map(sh => {
                            const running = sh.exitCode === undefined && !sh.terminalExited;
                            const code = sh.terminalExitCode ?? sh.exitCode;
                            const label = sh.terminalCommand || (sh.terminalCwd ? sh.terminalCwd.split('/').filter(Boolean).pop() || '/' : 'shell');
                            const isActive = sh.id === activeShellId;
                            const shellMinimized = minimizedShells.has(sh.id);
                            const visuallyMinimized = isActive && shellMinimized;
                            return (
                              <button
                                key={sh.id}
                                className={`group shrink-0 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[11px] font-mono transition-colors ${
                                  isActive ? 'ring-1 ring-green-400/40 ' : ''
                                }${
                                  visuallyMinimized ? 'opacity-60 ' : ''
                                }${
                                  running
                                    ? 'border-green-900/60 bg-green-500/10 text-green-300 hover:bg-green-500/20'
                                    : code === 0
                                      ? 'border-border-light bg-surface-light text-zinc-400 hover:text-zinc-200'
                                      : 'border-red-900/50 bg-red-500/10 text-red-300 hover:bg-red-500/20'
                                }`}
                                onClick={() => {
                                  if (isActive) {
                                    // Click the currently-active shell's badge → toggle minimize.
                                    toggleShellMinimized(sh.id);
                                  } else {
                                    // Clicking a different shell → activate it and ensure expanded.
                                    setActiveShellBySession(prev => ({ ...prev, [activeId]: sh.id }));
                                    setMinimizedShells(prev => { const n = new Set(prev); n.delete(sh.id); return n; });
                                  }
                                }}
                                title={
                                  isActive
                                    ? (shellMinimized ? 'Click to expand shell' : 'Click to minimize shell')
                                    : 'Click to switch to this shell'
                                }
                              >
                                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                  running ? 'bg-green-400 animate-pulse' : code === 0 ? 'bg-zinc-600' : 'bg-red-400'
                                }`} />
                                <span className="truncate max-w-[160px]">{label}</span>
                                {!running && code !== undefined && (
                                  <span className="text-[9px] opacity-70 shrink-0">exit {code}</span>
                                )}
                                {running && clientRef.current && (
                                  <span
                                    role="button"
                                    tabIndex={0}
                                    className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-red-400 shrink-0 transition-opacity"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      clientRef.current!.killTerminal(activeId, sh.procId || sh.id);
                                    }}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        clientRef.current!.killTerminal(activeId, sh.procId || sh.id);
                                      }
                                    }}
                                    title="Kill shell"
                                  >
                                    ×
                                  </span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                        {/* Active xterm panel — always mounted so every shell's xterm state
                            (scrollback, cursor, running processes) survives switching and
                            minimize/expand. Wrapper uses display:none when minimized. */}
                        <div
                          className="border-t border-border px-3 pt-1 pb-2"
                          style={activeMinimized ? { display: 'none' } : undefined}
                        >
                          {shells.map(sh => (
                            <div
                              key={sh.id}
                              style={sh.id === activeShellId ? undefined : { display: 'none' }}
                            >
                              <MessageBubble
                                message={sh}
                                onOpenTerminal={handleOpenTerminal}
                                sessionId={activeId}
                                client={clientRef.current || undefined}
                                interactiveMinimized={false}
                                onToggleInteractiveMinimize={toggleShellMinimized}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })()}

                  {/* Floating "scroll to latest" — appears when the user has
                      scrolled away from the bottom while the assistant streams.
                      Clicking re-pins the chat to the latest message. */}
                  {showScrollDown && (
                    <button
                      type="button"
                      onClick={scrollToBottom}
                      aria-label="Scroll to latest"
                      className="absolute bottom-24 left-1/2 -translate-x-1/2 z-30 w-9 h-9 rounded-full bg-zinc-900/85 border border-white/10 text-zinc-200 hover:bg-zinc-800 shadow-2xl flex items-center justify-center"
                      style={{
                        backdropFilter: 'blur(20px) saturate(180%)',
                        WebkitBackdropFilter: 'blur(20px) saturate(180%)',
                      }}
                    >
                      <ArrowDown size={16} />
                    </button>
                  )}

                  {/* Input */}
                  <div className="border-t border-border p-3 shrink-0 relative">
                    {/* Ambient color spot — fades in while the active session is streaming. */}
                    <div
                      aria-hidden
                      className="absolute inset-0 overflow-hidden pointer-events-none transition-opacity duration-300 ease-out"
                      style={{ opacity: active.isStreaming && !active.permRequest ? 1 : 0 }}
                    >
                      <div
                        className="blob-single absolute rounded-full"
                        style={{
                          left: '50%',
                          top: '50%',
                          width: '14rem',
                          height: '14rem',
                          background:
                            'radial-gradient(circle, rgba(99,102,241,0.85) 0%, rgba(99,102,241,0) 70%)',
                        }}
                      />
                    </div>
                    <div className="max-w-4xl mx-auto relative">
                      {slash.isActive && (
                        <SlashCommandList
                          filtered={slash.filtered}
                          selectedIndex={slash.selectedIndex}
                          onSelect={handleSlashSelect}
                          onHover={() => {}}
                        />
                      )}
                      {fileMention.isActive && (
                        <FileMentionList
                          results={fileMention.results}
                          selectedIndex={fileMention.selectedIndex}
                          onSelect={handleFileMentionSelect}
                        />
                      )}
                      {(() => {
                        const isTerminalMode = input.startsWith('>');
                        const cmdText = isTerminalMode ? input.slice(1).replace(/^ /, '') : input;
                        const streaming = active.isStreaming;
                        const refs = input.match(/@[\w.\/\-:]+/g);
                        const isOpenCode = activeSession?.provider === 'opencode';
                        const ocModels = isOpenCode ? (opencodeInfo?.models ?? null) : undefined;
                        const ocLoading = isOpenCode && opencodeInfo === null;
                        // Live list pushed by the bridge once the Claude SDK
                        // returns from `runtime.supportedModels()`. Empty
                        // until the probe lands; the picker falls back to
                        // its hardcoded entries below to avoid a flash of
                        // "Default-only" while the session warms up.
                        const claudeModels = !isOpenCode ? (active.supportedModels ?? []) : [];
                        const sendDisabled = isTerminalMode
                          ? !cmdText.trim() || activeStatus !== 'connected'
                          : !input.trim() || activeStatus !== 'connected';
                        const triggerCls =
                          'min-h-0 h-7 py-0 px-2.5 rounded-full bg-transparent hover:bg-surface-light data-[hovered]:bg-surface-light text-[12px] text-zinc-400 hover:text-zinc-200 border-0 shadow-none transition-colors';
                        return (
                          <div
                            className={`relative rounded-2xl border transition-colors shadow-lg shadow-black/30 ${
                              isTerminalMode
                                ? 'bg-[#141414] border-green-900/50 focus-within:border-green-700/60'
                                : 'bg-surface border-border focus-within:border-zinc-500/60'
                            }`}
                          >
                            {refs && refs.length > 0 && (
                              <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
                                {refs.map((ref, i) => (
                                  <span
                                    key={i}
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-surface-light text-[11px] font-mono text-amber-400/80 border border-border-light"
                                  >
                                    {ref}
                                    <button
                                      className="text-zinc-500 hover:text-zinc-300 ml-0.5"
                                      onClick={() => setInput(prev => prev.replace(ref, '').replace(/  +/g, ' ').trim())}
                                    >
                                      &times;
                                    </button>
                                  </span>
                                ))}
                              </div>
                            )}

                            {pastedImages.length > 0 && (
                              <div className="flex gap-2 px-3 pt-2.5 flex-wrap">
                                {pastedImages.map((img, i) => (
                                  <div key={i} className="relative group">
                                    <img src={img.preview} alt="" className="h-16 rounded border border-border object-cover" />
                                    <button
                                      className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-zinc-700 text-zinc-300 text-[10px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-600"
                                      onClick={() => setPastedImages(prev => prev.filter((_, j) => j !== i))}
                                    >
                                      &times;
                                    </button>
                                  </div>
                                ))}
                              </div>
                            )}

                            <div className="flex items-start px-3.5 pt-3 pb-1">
                              {isTerminalMode && (
                                <span className="text-green-500 text-sm font-mono pr-1 py-0.5 select-none shrink-0">&gt;</span>
                              )}
                              <textarea
                                ref={inputRef}
                                value={isTerminalMode ? cmdText : input}
                                onChange={(e) => {
                                  if (isTerminalMode) {
                                    const v = e.target.value;
                                    setInput(v ? `> ${v}` : '> ');
                                  } else {
                                    setInput(e.target.value);
                                  }
                                }}
                                disabled={activeStatus !== 'connected'}
                                placeholder={isTerminalMode ? 'command...' : (streaming ? 'Queue a follow-up message…' : 'Send a message...')}
                                onKeyDown={(e) => {
                                  if (isTerminalMode && e.key === 'Backspace' && !cmdText) {
                                    e.preventDefault();
                                    setInput('');
                                    return;
                                  }
                                  if (e.key === 'ArrowUp' && !e.shiftKey && !slash.isActive && !fileMention.isActive) {
                                    const el = e.currentTarget;
                                    if (el.selectionStart === 0 && el.selectionEnd === 0) {
                                      e.preventDefault();
                                      const hist = active.inputHistory;
                                      if (hist.length === 0) return;
                                      if (historyIdxRef.current === -1) historyDraftRef.current = input;
                                      const newIdx = historyIdxRef.current === -1 ? hist.length - 1 : Math.max(0, historyIdxRef.current - 1);
                                      historyIdxRef.current = newIdx;
                                      setInput(hist[newIdx]!);
                                      return;
                                    }
                                  }
                                  if (e.key === 'ArrowDown' && !e.shiftKey && !slash.isActive && !fileMention.isActive) {
                                    const el = e.currentTarget;
                                    if (el.selectionStart === el.value.length) {
                                      e.preventDefault();
                                      const hist = active.inputHistory;
                                      if (historyIdxRef.current === -1) return;
                                      const newIdx = historyIdxRef.current + 1;
                                      if (newIdx >= hist.length) {
                                        historyIdxRef.current = -1;
                                        setInput(historyDraftRef.current);
                                      } else {
                                        historyIdxRef.current = newIdx;
                                        setInput(hist[newIdx]!);
                                      }
                                      return;
                                    }
                                  }
                                  if (fileMention.isActive) {
                                    fileMention.onKeyDown(e, handleFileMentionSelect);
                                  } else {
                                    slash.onKeyDown(e, handleSlashSelect);
                                  }
                                  if (e.key === 'Enter' && !e.shiftKey && !slash.isActive && !fileMention.isActive) {
                                    e.preventDefault();
                                    handleSend();
                                  }
                                }}
                                autoFocus
                                rows={1}
                                className={`flex-1 bg-transparent border-0 outline-none resize-none text-[14px] leading-6 placeholder:text-zinc-500 disabled:opacity-50 ${
                                  isTerminalMode ? 'font-mono text-green-300' : 'text-zinc-200'
                                }`}
                                style={{ minHeight: 24, maxHeight: 200 }}
                                onPaste={(e) => {
                                  const items = e.clipboardData?.items;
                                  if (!items) return;
                                  for (const item of items) {
                                    if (item.type.startsWith('image/')) {
                                      e.preventDefault();
                                      const file = item.getAsFile();
                                      if (!file) continue;
                                      const reader = new FileReader();
                                      reader.onload = () => {
                                        const dataUrl = reader.result as string;
                                        const [header, data] = dataUrl.split(',');
                                        const media_type = header!.match(/:(.*?);/)?.[1] || 'image/png';
                                        setPastedImages(prev => [...prev, { media_type, data: data!, preview: dataUrl }]);
                                      };
                                      reader.readAsDataURL(file);
                                    }
                                  }
                                }}
                                onInput={(e) => {
                                  const el = e.currentTarget;
                                  el.style.height = 'auto';
                                  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
                                }}
                              />
                            </div>

                            <div className="flex items-center gap-1 px-2 pb-2 pt-1">
                              <Select
                                aria-label="Model"
                                selectedKey={activeSession?.model || 'default'}
                                onSelectionChange={(key) => {
                                  if (!activeId || !clientRef.current) return;
                                  const modelId = key === 'default' ? '' : String(key);
                                  if (modelId) {
                                    clientRef.current.setModel(activeId, modelId);
                                  }
                                  setSessions(prev => prev.map(s => s.id === activeId ? { ...s, model: modelId || null } : s));
                                }}
                                className={isOpenCode ? 'w-56' : 'w-32'}
                                isDisabled={ocLoading}
                              >
                                <SelectTrigger className={triggerCls}>
                                  <SelectValue />
                                  <SelectIndicator className="size-3.5" />
                                </SelectTrigger>
                                <SelectPopover>
                                  <ListBox>
                                    <ListBoxItem key="default" id="default" textValue="Default"><span className="text-xs">Default</span></ListBoxItem>
                                    {isOpenCode ? (
                                      (ocModels ?? []).map(m => (
                                        <ListBoxItem key={m.id} id={m.id} textValue={`${m.providerName} ${m.label}`}>
                                          <span className="text-xs">
                                            <span className="text-zinc-500">{m.providerName}</span>{' '}
                                            {m.label}
                                          </span>
                                        </ListBoxItem>
                                      ))
                                    ) : claudeModels.length > 0 ? (
                                      claudeModels.map(m => (
                                        <ListBoxItem key={m.id} id={m.id} textValue={m.label}>
                                          <span className="text-xs">{m.label}</span>
                                        </ListBoxItem>
                                      ))
                                    ) : (
                                      <>
                                        <ListBoxItem key="claude-sonnet-4-6" id="claude-sonnet-4-6" textValue="Sonnet 4.6"><span className="text-xs">Sonnet 4.6</span></ListBoxItem>
                                        <ListBoxItem key="claude-opus-4-6" id="claude-opus-4-6" textValue="Opus 4.6"><span className="text-xs">Opus 4.6</span></ListBoxItem>
                                        <ListBoxItem key="claude-haiku-4-5-20251001" id="claude-haiku-4-5-20251001" textValue="Haiku 4.5"><span className="text-xs">Haiku 4.5</span></ListBoxItem>
                                      </>
                                    )}
                                  </ListBox>
                                </SelectPopover>
                              </Select>

                              <Select
                                aria-label="Permission mode"
                                selectedKey={activeSession?.permission_mode || 'default'}
                                onSelectionChange={(key) => {
                                  if (!activeId || !clientRef.current) return;
                                  requestPermissionMode(activeId, String(key));
                                }}
                                className="w-36"
                              >
                                <SelectTrigger className={triggerCls}>
                                  <SelectValue />
                                  <SelectIndicator className="size-3.5" />
                                </SelectTrigger>
                                <SelectPopover>
                                  <ListBox>
                                    <ListBoxItem key="default" id="default" textValue="Default"><span className="text-xs">Default</span></ListBoxItem>
                                    <ListBoxItem key="acceptEdits" id="acceptEdits" textValue="Accept Edits"><span className="text-xs">Accept Edits</span></ListBoxItem>
                                    <ListBoxItem key="plan" id="plan" textValue="Plan"><span className="text-xs">Plan</span></ListBoxItem>
                                    <ListBoxItem key="bypassPermissions" id="bypassPermissions" textValue="Bypass"><span className="text-xs">Bypass All</span></ListBoxItem>
                                  </ListBox>
                                </SelectPopover>
                              </Select>

                              <div className="flex-1" />

                              {streaming && (
                                <button
                                  type="button"
                                  onClick={handleInterrupt}
                                  className="text-amber-400 hover:text-amber-300 text-[12px] h-7 px-3 rounded-full hover:bg-surface-light transition-colors"
                                >
                                  Stop
                                </button>
                              )}

                              <Button
                                isIconOnly
                                onPress={handleSend}
                                isDisabled={sendDisabled}
                                aria-label={isTerminalMode ? 'Run' : (streaming ? 'Queue message' : 'Send message')}
                                className={`rounded-full w-8 h-8 min-w-8 min-h-0 p-0 flex items-center justify-center transition-colors disabled:bg-surface-light disabled:text-zinc-600 ${
                                  isTerminalMode
                                    ? 'bg-green-600 hover:bg-green-500 text-white'
                                    : 'bg-zinc-100 text-zinc-900 hover:bg-white'
                                }`}
                              >
                                <SendIcon className="w-4 h-4" />
                              </Button>
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                </div>

                {/* Resize handle between chat and right panel */}
                {hasRightPanel && !editorFullWidth && (
                  <div
                    className="w-1 shrink-0 cursor-col-resize hover:bg-blue-500/40 active:bg-blue-500/60 transition-colors"
                    onMouseDown={onChatResizeStart}
                  />
                )}

                {/* While dragging the chat/preview split, this overlay sits
                    above any iframe in the right panel. Without it the
                    cursor entering the iframe (a separate browsing context)
                    eats the mousemove/mouseup and the drag never ends. */}
                {chatResizing && (
                  <div className="fixed inset-0 z-[9999] cursor-col-resize" />
                )}

                {/* Right panel: editor or terminal */}
                {openFile && (
                  <div className="flex-1 flex flex-col min-w-0">
                    <div className="flex items-center justify-between px-3 py-1 border-b border-border shrink-0 bg-surface" onDoubleClick={() => activeId && updateLocalState(activeId, s => ({ ...s, editorFullWidth: !s.editorFullWidth }))}>
                      <div className="flex items-center gap-1.5 truncate cursor-default">
                        <span className={`text-[12px] font-mono truncate ${gitModified.staged.has(openFile.path) ? 'text-green-400' : gitModified.unstaged.has(openFile.path) ? 'text-amber-400' : 'text-zinc-400'}`}>
                          {openFile.path.split('/').pop()}
                        </span>
                        {editorDirty && <span className="w-2 h-2 rounded-full bg-zinc-400 shrink-0" title="Unsaved changes" />}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {editorDirty && (
                          <button
                            className="text-[11px] text-zinc-500 hover:text-zinc-200 px-1.5"
                            onClick={handleSaveFileWrapped}
                            title="Save (Cmd+S)"
                          >
                            Save
                          </button>
                        )}
                        <button
                          className={`text-[11px] px-1.5 transition-colors ${showDebugPanel ? 'text-amber-400' : 'text-zinc-500 hover:text-zinc-200'}`}
                          onClick={() => setShowDebugPanel(v => !v)}
                          title="Toggle Debugger"
                        >
                          Bug
                        </button>
                        <button
                          className="text-zinc-500 hover:text-zinc-200 text-sm px-1"
                          onClick={() => { setOpenFile(null); }}
                        >
                          &times;
                        </button>
                      </div>
                    </div>
                    <div className={showDebugPanel ? 'flex-1 min-h-0' : 'flex-1'} style={showDebugPanel ? { flex: '1 1 60%' } : undefined}>
                      <Editor
                        key={openFile.path}
                        path={openFile.path}
                        defaultValue={openFile.content}
                        theme="vs-dark"
                        onMount={handleEditorMount}
                        onChange={(value) => {
                          if (activeId) updateLocalState(activeId, s => ({ ...s, editorDirty: value !== s.openFile?.content }));
                        }}
                        options={{
                          minimap: { enabled: false },
                          fontSize: 13,
                          lineNumbers: 'on',
                          scrollBeyondLastLine: false,
                          wordWrap: 'on',
                          padding: { top: 8 },
                          glyphMargin: true,
                        }}
                      />
                    </div>
                    {showDebugPanel && (
                      <div style={{ flex: '0 0 250px' }} className="min-h-0 overflow-hidden">
                        <DebugPanel
                          serverUrl={serverUrlRef.current || ''}
                          onNavigate={(filePath, line) => handleFileOpen(filePath, line)}
                          onClose={() => setShowDebugPanel(false)}
                          breakpoints={debugBreakpoints}
                          onToggleBreakpoint={(file, line) => {
                            setDebugBreakpoints(prev => {
                              const existing = prev.find(bp => bp.file === file && bp.line === line);
                              if (existing) return prev.map(bp => bp === existing ? { ...bp, enabled: !bp.enabled } : bp);
                              return [...prev, { file, line, enabled: true }];
                            });
                          }}
                        />
                      </div>
                    )}
                  </div>
                )}
                {!openFile && openMockup && activeId && (
                  <MockupPanel
                    name={openMockup.name}
                    html={openMockup.html}
                    inspect={active.mockupInspect}
                    comments={active.mockupComments[openMockup.name] || []}
                    onSetInspect={(next) => updateLocalState(activeId, s => ({ ...s, mockupInspect: next }))}
                    onSetComments={(next) => updateLocalState(activeId, s => ({
                      ...s,
                      mockupComments: { ...s.mockupComments, [openMockup.name]: next },
                    }))}
                    onSendToChat={(md) => {
                      // Fire the message immediately and clear the comment
                      // dots — mirrors handleSend's queue-vs-direct branching
                      // so a feedback round-trip works mid-turn too.
                      if (!clientRef.current) return;
                      const mockupName = openMockup.name;
                      const streamingNow = active.isStreaming;
                      if (streamingNow) {
                        const pendingId = crypto.randomUUID();
                        const pendingMsg = {
                          id: pendingId,
                          role: 'user' as const,
                          content: md,
                          timestamp: Date.now(),
                          isPending: true,
                        };
                        updateLocalState(activeId, s => ({
                          ...s,
                          messages: [...s.messages, pendingMsg],
                          pendingMessages: [...s.pendingMessages, { id: pendingId, text: md }],
                          mockupInspect: false,
                          mockupComments: { ...s.mockupComments, [mockupName]: [] },
                        }));
                      } else {
                        const userMsg = {
                          id: crypto.randomUUID(),
                          role: 'user' as const,
                          content: md,
                          timestamp: Date.now(),
                        };
                        updateLocalState(activeId, s => ({
                          ...s,
                          messages: [...s.messages, userMsg],
                          isStreaming: true,
                          wasInterrupted: false,
                          partialText: '',
                          partialThinking: '',
                          mockupInspect: false,
                          mockupComments: { ...s.mockupComments, [mockupName]: [] },
                        }));
                        clientRef.current.sendMessage(activeId, md);
                      }
                    }}
                    onWriteToChat={(md) => {
                      // Dropdown option: stuff the markdown into the input
                      // field without firing it, leave the dots in place so
                      // the user can keep iterating before they hit Send.
                      setInput(prev => prev ? prev + (prev.endsWith('\n') ? '' : '\n\n') + md : md);
                      updateLocalState(activeId, s => ({ ...s, mockupInspect: false }));
                      inputRef.current?.focus();
                    }}
                    onClose={() => updateLocalState(activeId, s => ({ ...s, openMockup: null, editorFullWidth: false, mockupInspect: false }))}
                    onToggleFullWidth={() => updateLocalState(activeId, s => ({ ...s, editorFullWidth: !s.editorFullWidth }))}
                  />
                )}
                {!openFile && !openMockup && openPlan && activeId && (
                  <PlanPanel
                    content={openPlan.content}
                    allowedPrompts={openPlan.allowedPrompts}
                    comments={active.planComments}
                    onSetComments={(next) => updateLocalState(activeId, s => ({ ...s, planComments: next }))}
                    onSendToChat={(md) => {
                      // Mirrors MockupPanel.onSendToChat — fire as a queued
                      // message if a turn is in flight, otherwise start a
                      // new turn directly. Always clear comments after.
                      // Additionally: if the pending perm is the ExitPlanMode
                      // we're commenting on, auto-deny it so the agent
                      // unblocks and can refine the plan from our feedback
                      // (mirrors the handleSend auto-deny on stale perms).
                      if (!clientRef.current) return;
                      const pendingPlanReq = active.permRequest && active.permRequest.toolName === 'ExitPlanMode'
                        ? active.permRequest
                        : null;
                      if (pendingPlanReq) {
                        clientRef.current.respondToPermission(activeId, pendingPlanReq.requestId, false);
                      }
                      const streamingNow = active.isStreaming;
                      if (streamingNow) {
                        const pendingId = crypto.randomUUID();
                        const pendingMsg = {
                          id: pendingId,
                          role: 'user' as const,
                          content: md,
                          timestamp: Date.now(),
                          isPending: true,
                        };
                        updateLocalState(activeId, s => ({
                          ...s,
                          messages: [...s.messages, pendingMsg],
                          pendingMessages: [...s.pendingMessages, { id: pendingId, text: md }],
                          planComments: [],
                          permRequest: pendingPlanReq ? null : s.permRequest,
                        }));
                      } else {
                        const userMsg = {
                          id: crypto.randomUUID(),
                          role: 'user' as const,
                          content: md,
                          timestamp: Date.now(),
                        };
                        updateLocalState(activeId, s => ({
                          ...s,
                          messages: [...s.messages, userMsg],
                          isStreaming: true,
                          wasInterrupted: false,
                          partialText: '',
                          partialThinking: '',
                          planComments: [],
                          permRequest: pendingPlanReq ? null : s.permRequest,
                        }));
                        clientRef.current.sendMessage(activeId, md);
                      }
                    }}
                    onWriteToChat={(md) => {
                      setInput(prev => prev ? prev + (prev.endsWith('\n') ? '' : '\n\n') + md : md);
                      inputRef.current?.focus();
                    }}
                    onClose={() => updateLocalState(activeId, s => ({ ...s, openPlan: null, editorFullWidth: false }))}
                    onToggleFullWidth={() => updateLocalState(activeId, s => ({ ...s, editorFullWidth: !s.editorFullWidth }))}
                  />
                )}
                {!openFile && !openMockup && !openPlan && pluginDetailOpen && (
                  <PluginDetailView />
                )}
                {!openFile && !openMockup && !openPlan && !pluginDetailOpen && openPR && (
                  <PRDetail pr={openPR} cwd={active.initInfo?.cwd || sessions.find(s => s.id === activeId)?.cwd} onClose={() => setOpenPR(null)} />
                )}
                {!openFile && !openMockup && !openPlan && !pluginDetailOpen && !openPR && openTerminal && (
                  <div className={`flex-1 flex flex-col min-w-0`}>
                    <div className="flex items-center justify-between px-3 py-1 border-b border-border shrink-0 bg-surface" onDoubleClick={() => activeId && updateLocalState(activeId, s => ({ ...s, editorFullWidth: !s.editorFullWidth }))}>
                      <div className="flex items-center gap-1.5 truncate cursor-default">
                        <span className="text-[10px] text-zinc-500">$</span>
                        <span className="text-[12px] font-mono text-zinc-300 truncate">{openTerminal.terminalCommand}</span>
                        {openTerminal.exitCode === undefined && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" />}
                        {openTerminal.exitCode !== undefined && openTerminal.exitCode === 0 && <span className="text-[10px] text-green-400 shrink-0">exit 0</span>}
                        {openTerminal.exitCode !== undefined && openTerminal.exitCode !== 0 && <span className="text-[10px] text-red-400 shrink-0">exit {openTerminal.exitCode}</span>}
                      </div>
                      <button
                        className="text-zinc-500 hover:text-zinc-200 text-sm px-1 shrink-0"
                        onClick={() => activeId && updateLocalState(activeId, s => ({ ...s, openTerminalId: null }))}
                      >
                        &times;
                      </button>
                    </div>
                    <pre ref={termPanelRef} className="flex-1 overflow-auto px-3 py-2 text-[12px] font-mono text-zinc-400 whitespace-pre-wrap break-all leading-snug m-0 bg-transparent">
                      <AnsiText text={openTerminal.content} />
                      {openTerminal.exitCode === undefined && <span className="inline-block w-1.5 h-3 bg-zinc-500/60 animate-pulse ml-0.5 align-text-bottom" />}
                    </pre>
                  </div>
                )}
                {!openFile && !openMockup && !openPlan && !openTerminal && diffView && (
                  <div className={`flex-1 flex flex-col min-w-0`}>
                    {/* Review status bar */}
                    {reviewMode && (
                      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border shrink-0 bg-surface-light">
                        <span className="text-[11px] text-zinc-500">
                          {Object.values(reviewComments).flat().length} comment{Object.values(reviewComments).flat().length !== 1 ? 's' : ''}
                        </span>
                        <span className="flex-1" />
                        <button
                          className="text-[11px] text-zinc-500 hover:text-zinc-300 px-2 py-0.5 rounded hover:bg-surface-lighter transition-colors"
                          onClick={handleExitReview}
                        >
                          Cancel
                        </button>
                        <button
                          className="flex items-center gap-1 text-[11px] bg-green-600 text-white rounded px-2.5 py-0.5 hover:bg-green-500 disabled:opacity-40 transition-colors"
                          disabled={Object.values(reviewComments).flat().length === 0}
                          onClick={handleSubmitReview}
                        >
                          Submit Review &#x25B6;
                        </button>
                      </div>
                    )}
                    {/* File header */}
                    <div className="flex items-center justify-between px-3 py-1 border-b border-border shrink-0 bg-surface" onDoubleClick={() => !reviewMode && activeId && updateLocalState(activeId, s => ({ ...s, editorFullWidth: !s.editorFullWidth }))}>
                      <div className="flex items-center gap-1.5 truncate cursor-default">
                        <span className="text-[10px] text-amber-400 shrink-0">M</span>
                        <span className="text-[12px] font-mono text-amber-400 truncate">{diffView.path.split('/').pop()}</span>
                        {explorerRoot && (
                          <span className="text-[10px] text-zinc-600 font-mono truncate ml-1">{diffView.path.slice(explorerRoot.length + 1)}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {!reviewMode && (
                          <>
                            <button
                              className="text-[11px] text-zinc-500 hover:text-zinc-200 px-1.5"
                              onClick={() => { handleFileOpen(diffView.path); }}
                            >
                              Edit
                            </button>
                            <button
                              className="text-zinc-500 hover:text-zinc-200 text-sm px-1"
                              onClick={() => { activeId && updateLocalState(activeId, s => ({ ...s, diffView: null, editorFullWidth: false })); }}
                            >
                              &times;
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="flex-1 flex flex-col relative min-h-0">
                      <DiffReview
                        original={diffView.original}
                        modified={diffView.modified}
                        filePath={diffView.path}
                        comments={reviewComments[diffView.path] as ReviewComment[] || []}
                        onAddComment={(comment) => {
                          if (!activeId || !diffView) return;
                          const p = diffView.path;
                          updateLocalState(activeId, s => ({ ...s, reviewComments: { ...s.reviewComments, [p]: [...((s.reviewComments[p] as ReviewComment[]) || []), comment] } }));
                        }}
                        onDeleteComment={(id) => {
                          if (!activeId || !diffView) return;
                          const p = diffView.path;
                          updateLocalState(activeId, s => ({ ...s, reviewComments: { ...s.reviewComments, [p]: ((s.reviewComments[p] as ReviewComment[]) || []).filter(c => c.id !== id) } }));
                        }}
                      />
                      {reviewMode && reviewFiles.length > 1 && (
                        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-1 bg-zinc-800/90 backdrop-blur border border-border rounded-lg shadow-lg px-1.5 py-1 z-10">
                          <button
                            className="text-zinc-400 hover:text-white text-[13px] px-2 py-1 rounded hover:bg-zinc-700 disabled:opacity-30 disabled:hover:bg-transparent"
                            disabled={reviewIndex === 0}
                            onClick={() => handleReviewNav(-1)}
                          >
                            &#x25C0;
                          </button>
                          <span className="text-[12px] text-zinc-300 px-1.5 tabular-nums select-none">
                            {reviewIndex + 1} / {reviewFiles.length}
                          </span>
                          <button
                            className="text-zinc-400 hover:text-white text-[13px] px-2 py-1 rounded hover:bg-zinc-700 disabled:opacity-30 disabled:hover:bg-transparent"
                            disabled={reviewIndex === reviewFiles.length - 1}
                            onClick={() => handleReviewNav(1)}
                          >
                            &#x25B6;
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Permission modal removed — shown inline in chat */}
            </>
            )}
          </div>
        </div>

        {/* Status bar */}
        <div className="flex items-center justify-between px-3 h-[22px] bg-[#181818] border-t border-border text-[11px] shrink-0 select-none">
          <div className="flex items-center gap-3">
            {gitBranch && (
              <button ref={branchBtnRef} className="flex items-center gap-1 text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer z-10" onClick={(e) => { e.stopPropagation(); openBranchMenu(); }}>
                <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor"><path d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V6c0 .73-.593 1.322-1.322 1.322H8.822A1.322 1.322 0 007.5 8.644v1.228a2.251 2.251 0 11-1.5 0V6.128a2.251 2.251 0 111.5 0v.994c0 .045.037.082.082.082h2.596c.045 0 .082-.037.082-.082v-.744A2.25 2.25 0 019.5 3.25zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zM3.5 3.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0z" /></svg>
                {gitBranch}
              </button>
            )}
            {explorerRoot && (
              <span className="text-zinc-600 font-mono truncate max-w-[300px]">
                {explorerRoot.split('/').slice(-3).join('/')}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            {activeId && (
              <span className="flex items-center gap-1 text-zinc-600">
                <span className={`w-1.5 h-1.5 rounded-full ${activeStatus === 'connected' ? 'bg-green-400' : activeStatus === 'connecting' ? 'bg-amber-400' : 'bg-zinc-600'}`} />
                {activeStatus}
              </span>
            )}
            {activeSession?.model && (
              <span className="text-zinc-500">{activeSession.model.replace('claude-', '').replace(/-\d+$/, '')}</span>
            )}
            {activeSession?.permission_mode && activeSession.permission_mode !== 'default' && (
              <span className={`px-1 rounded ${activeSession.permission_mode === 'plan' ? 'text-violet-400 bg-violet-400/10' : activeSession.permission_mode === 'acceptEdits' ? 'text-green-400 bg-green-400/10' : 'text-amber-400 bg-amber-400/10'}`}>
                {activeSession.permission_mode}
              </span>
            )}
            {lspStatus !== 'off' && (
              <span className="relative">
                <button
                  className={`flex items-center gap-1 px-1 rounded text-[11px] cursor-pointer hover:brightness-125 transition-all ${
                    lspStatus === 'running' ? 'text-blue-400 bg-blue-400/10' :
                    lspStatus === 'connecting' ? 'text-amber-400 bg-amber-400/10' :
                    'text-red-400 bg-red-400/10'
                  }`}
                  onClick={() => setLspMenu(m => !m)}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${
                    lspStatus === 'running' ? 'bg-blue-400' :
                    lspStatus === 'connecting' ? 'bg-amber-400 animate-pulse' :
                    'bg-red-400'
                  }`} />
                  LSP
                </button>
                {lspMenu && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setLspMenu(false)} />
                    <div className="absolute bottom-6 right-0 z-50 bg-[#2a2a2a] border border-border-light rounded-lg shadow-xl py-1 min-w-[140px]">
                      <button
                        className="w-full px-3 py-1.5 text-left text-[12px] text-zinc-300 hover:bg-surface-light transition-colors"
                        onClick={() => { setLspMenu(false); restartLsp(); }}
                      >
                        Restart LSP Server
                      </button>
                      <button
                        className="w-full px-3 py-1.5 text-left text-[12px] text-zinc-300 hover:bg-surface-light transition-colors"
                        onClick={() => {
                          setLspMenu(false);
                          lspClientRef.current?.dispose();
                          lspClientRef.current = null;
                          lspSessionIdRef.current = null;
                          setLspStatus('off');
                        }}
                      >
                        Stop LSP Server
                      </button>
                    </div>
                  </>
                )}
              </span>
            )}
            {active.contextTokens > 0 && (() => {
              const maxTokens = 200000;
              const pct = Math.min((active.contextTokens / maxTokens) * 100, 100);
              const color = pct > 80 ? 'bg-red-400' : pct > 50 ? 'bg-amber-400' : 'bg-green-400';
              const k = (active.contextTokens / 1000).toFixed(0);
              return (
                <span className="flex items-center gap-1.5 text-zinc-600" title={`${active.contextTokens.toLocaleString()} / ${maxTokens.toLocaleString()} tokens`}>
                  <span className="text-[10px]">{k}k</span>
                  <span className="w-16 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                    <span className={`block h-full rounded-full ${color} transition-all`} style={{ width: `${pct}%` }} />
                  </span>
                </span>
              );
            })()}
          </div>
        </div>

        {/* Branch picker */}
        {branchMenu && (() => {
          const q = branchFilter.toLowerCase();
          const filteredLocal = branchMenu.local.filter(b => !q || b.toLowerCase().includes(q));
          const filteredRemote = branchMenu.remote.filter(b => !q || b.toLowerCase().includes(q));
          const allFiltered = [...filteredLocal, ...filteredRemote];
          const renderBranch = (branch: string, isRemote: boolean) => (
            <button
              key={`${isRemote ? 'r-' : 'l-'}${branch}`}
              className={`w-full text-left px-3 py-1 text-[11px] transition-colors truncate ${branch === branchMenu.current ? 'text-green-400 bg-green-400/5' : 'text-zinc-400 hover:bg-surface-light hover:text-zinc-200'}`}
              onClick={() => doCheckout(branch)}
            >
              {branch === branchMenu.current && <span className="mr-1">&#x2713;</span>}
              {branch}
            </button>
          );
          return (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setBranchMenu(null)} />
              <div className="fixed z-50 bg-surface border border-border-light rounded-lg shadow-xl w-72 overflow-hidden"
                style={{ bottom: 26, left: branchMenu.rect.left || 10 }}>
                <div className="px-2 py-2 border-b border-border">
                  <input
                    ref={branchInputRef}
                    value={branchFilter}
                    onChange={e => setBranchFilter(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Escape') setBranchMenu(null); if (e.key === 'Enter' && allFiltered.length === 1) doCheckout(allFiltered[0]!); }}
                    placeholder="Search branches..."
                    className="w-full bg-surface-light border border-border rounded px-2 py-1 text-[11px] text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-zinc-500"
                  />
                </div>
                <div className="max-h-60 overflow-y-auto py-1">
                  {allFiltered.length === 0 && <p className="text-[11px] text-zinc-600 text-center py-3">No branches found</p>}
                  {filteredLocal.length > 0 && (
                    <>
                      <div className="px-3 py-0.5 text-[9px] text-zinc-600 uppercase tracking-wider">Local</div>
                      {filteredLocal.map(b => renderBranch(b, false))}
                    </>
                  )}
                  {filteredRemote.length > 0 && (
                    <>
                      <div className="px-3 py-0.5 mt-1 text-[9px] text-zinc-600 uppercase tracking-wider">Remote</div>
                      {filteredRemote.map(b => renderBranch(b, true))}
                    </>
                  )}
                </div>
              </div>
            </>
          );
        })()}

        <NewSessionModal
          isOpen={showNewSession}
          client={clientRef.current}
          opencodeAvailable={opencodeInfo?.available ?? false}
          onClose={() => setShowNewSession(false)}
          onCreate={handleCreateSession}
        />
        <BypassWarningModal
          open={pendingBypassSessionId !== null}
          onCancel={() => setPendingBypassSessionId(null)}
          onConfirm={() => {
            if (pendingBypassSessionId) applyPermissionMode(pendingBypassSessionId, 'bypassPermissions');
            setPendingBypassSessionId(null);
          }}
        />
        {worktreeForGroup && clientRef.current && (
          <WorktreeModal
            open
            onClose={() => setWorktreeForGroup(null)}
            client={clientRef.current}
            repoPath={worktreeForGroup.cwd}
            hasEnv={worktreeForGroup.hasEnv}
            detectedPackageManager={worktreeForGroup.packageManager}
            worktrees={worktreeForGroup.worktrees}
            onCreated={(path) => handleWorktreeCreatedForGroup(worktreeForGroup.groupId, worktreeForGroup.cwd, path)}
          />
        )}
        <CommandPalette
          isOpen={showPalette}
          onClose={() => setShowPalette(false)}
          actions={paletteActions}
          fileIndex={fileIndex}
          onFileOpen={handleFileOpen}
        />
        {/* Unsaved changes dialog */}
        {unsavedClosePrompt && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center" onClick={() => setUnsavedClosePrompt(false)}>
            <div className="absolute inset-0 bg-black/50" />
            <div className="relative bg-surface border border-border-light rounded-xl shadow-2xl p-5 max-w-sm w-full" onClick={e => e.stopPropagation()}>
              <h3 className="text-sm font-semibold text-zinc-200 mb-2">Unsaved Changes</h3>
              <p className="text-[13px] text-zinc-400 mb-4">
                Do you want to save changes to <span className="text-zinc-200 font-mono">{active.openFile?.path.split('/').pop()}</span> before closing?
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="flat" onPress={() => {
                  setUnsavedClosePrompt(false);
                  if (activeId) updateLocalState(activeId, s => ({ ...s, openFile: null, openTerminalId: null, diffView: null, editorFullWidth: false, editorDirty: false }));
                }}>Don't Save</Button>
                <Button variant="flat" onPress={() => setUnsavedClosePrompt(false)}>Cancel</Button>
                <Button onPress={async () => {
                  setUnsavedClosePrompt(false);
                  await handleSaveFileWrapped();
                  if (activeId) updateLocalState(activeId, s => ({ ...s, openFile: null, openTerminalId: null, diffView: null, editorFullWidth: false, editorDirty: false }));
                }}>Save</Button>
              </div>
            </div>
          </div>
        )}

        {/* Save As dialog */}
        {saveAsPrompt && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center" onClick={() => setSaveAsPrompt(null)}>
            <div className="absolute inset-0 bg-black/50" />
            <div className="relative bg-surface border border-border-light rounded-xl shadow-2xl p-5 max-w-md w-full" onClick={e => e.stopPropagation()}>
              <h3 className="text-sm font-semibold text-zinc-200 mb-3">Save As</h3>
              <input
                ref={saveAsInputRef}
                value={saveAsPath}
                onChange={e => setSaveAsPath(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') confirmSaveAs(); if (e.key === 'Escape') setSaveAsPrompt(null); }}
                placeholder="/path/to/file.ts"
                className="w-full bg-surface-light border border-border rounded-lg px-3 py-2 text-sm text-zinc-200 font-mono placeholder:text-zinc-600 outline-none focus:border-zinc-500 mb-3"
              />
              <div className="flex justify-end gap-2">
                <Button variant="flat" onPress={() => setSaveAsPrompt(null)}>Cancel</Button>
                <Button onPress={confirmSaveAs} isDisabled={!saveAsPath.trim()}>Save</Button>
              </div>
            </div>
          </div>
        )}

        {closingSessionId && (() => {
          const s = sessions.find(s => s.id === closingSessionId);
          return (
            <div className="fixed inset-0 z-[100] flex items-center justify-center" onClick={() => setClosingSessionId(null)}>
              <div className="absolute inset-0 bg-black/50" />
              <div className="relative bg-surface border border-border-light rounded-xl shadow-2xl p-5 max-w-sm w-full" onClick={e => e.stopPropagation()}>
                <h3 className="text-sm font-semibold text-zinc-200 mb-2">Close Session</h3>
                <p className="text-[13px] text-zinc-400 mb-4">
                  This will disconnect and close all running processes for <span className="text-zinc-200">{s?.name || 'this session'}</span>.
                </p>
                <div className="flex justify-end gap-2">
                  <Button variant="flat" onPress={() => setClosingSessionId(null)}>Cancel</Button>
                  <Button className="bg-red-600 text-white" onPress={confirmCloseTab}>Close</Button>
                </div>
              </div>
            </div>
          );
        })()}

        {deleteSessionPrompt && (() => {
          const p = deleteSessionPrompt;
          const dismiss = () => { if (!p.submitting) setDeleteSessionPrompt(null); };
          const hasUncommitted = (p.modifiedCount ?? 0) > 0;
          return (
            <div className="fixed inset-0 z-[100] flex items-center justify-center" onClick={dismiss}>
              <div className="absolute inset-0 bg-black/50" />
              <div className="relative bg-surface border border-border-light rounded-xl shadow-2xl p-5 max-w-md w-full" onClick={e => e.stopPropagation()}>
                {hasUncommitted && (
                  <div className="mb-3 flex items-start gap-2 px-3 py-2 rounded-md bg-amber-500/10 border border-amber-500/30 text-amber-200 text-[12px]">
                    <svg className="w-4 h-4 shrink-0 mt-px" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 9v4M12 17h.01" strokeLinecap="round" />
                      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" strokeLinejoin="round" />
                    </svg>
                    <span>
                      This worktree has <span className="font-semibold">{p.modifiedCount} uncommitted change{p.modifiedCount === 1 ? '' : 's'}</span>.
                      {p.deleteWorktree ? ' They will be lost permanently.' : ''}
                    </span>
                  </div>
                )}

                <h3 className="text-sm font-semibold text-zinc-200 mb-2">Delete Session</h3>
                <p className="text-[13px] text-zinc-400 mb-3">
                  Permanently delete <span className="text-zinc-200">{p.name}</span> and its chat history? This cannot be undone.
                </p>

                {p.isWorktree && (
                  <label className="flex items-start gap-2 mb-4 px-3 py-2 rounded-md bg-base/60 border border-border cursor-pointer">
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-red-500"
                      checked={p.deleteWorktree}
                      onChange={e => setDeleteSessionPrompt(prev => prev ? { ...prev, deleteWorktree: e.target.checked } : prev)}
                    />
                    <span className="flex-1 text-[12px]">
                      <span className="text-zinc-200">Also delete the worktree</span>
                      <span className="block text-zinc-500 font-mono truncate" title={p.cwd}>{p.cwd}</span>
                    </span>
                  </label>
                )}

                <div className="flex justify-end gap-2">
                  <Button variant="flat" onPress={dismiss} isDisabled={p.submitting}>Cancel</Button>
                  <Button className="bg-red-600 text-white" onPress={confirmDeleteSession} isDisabled={p.submitting}>
                    {p.submitting ? 'Deleting…' : 'Delete'}
                  </Button>
                </div>
              </div>
            </div>
          );
        })()}

        {deleteGroupPrompt && (() => {
          const p = deleteGroupPrompt;
          const dismiss = () => { if (!p.submitting) setDeleteGroupPrompt(null); };
          const worktreeMembers = p.members.filter(m => m.isWorktree);
          const anyWorktree = worktreeMembers.length > 0;
          const hasUncommitted = (p.modifiedCount ?? 0) > 0;
          return (
            <div className="fixed inset-0 z-[100] flex items-center justify-center" onClick={dismiss}>
              <div className="absolute inset-0 bg-black/50" />
              <div className="relative bg-surface border border-border-light rounded-xl shadow-2xl p-5 max-w-md w-full" onClick={e => e.stopPropagation()}>
                {hasUncommitted && (
                  <div className="mb-3 flex items-start gap-2 px-3 py-2 rounded-md bg-amber-500/10 border border-amber-500/30 text-amber-200 text-[12px]">
                    <svg className="w-4 h-4 shrink-0 mt-px" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 9v4M12 17h.01" strokeLinecap="round" />
                      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" strokeLinejoin="round" />
                    </svg>
                    <span>
                      Worktrees in this group have <span className="font-semibold">{p.modifiedCount} uncommitted change{p.modifiedCount === 1 ? '' : 's'}</span> in total.
                      {p.deleteWorktrees ? ' They will be lost permanently.' : ''}
                    </span>
                  </div>
                )}

                <h3 className="text-sm font-semibold text-zinc-200 mb-2">Delete Group</h3>
                <p className="text-[13px] text-zinc-400 mb-3">
                  Permanently delete <span className="text-zinc-200">{p.name}</span> and{' '}
                  <span className="text-zinc-200">
                    {p.members.length} session{p.members.length === 1 ? '' : 's'}
                  </span>{' '}
                  inside it? This cannot be undone.
                </p>

                {p.members.length > 0 && (
                  <div className="mb-3 max-h-32 overflow-y-auto rounded-md border border-border bg-base/40 divide-y divide-border">
                    {p.members.map(m => (
                      <div key={m.id} className="px-3 py-1.5 text-[12px] flex items-center gap-2">
                        <span className="text-zinc-300 truncate">{m.name}</span>
                        {m.isWorktree && (
                          <span className="ml-auto text-[10px] text-amber-400/80 font-mono shrink-0">worktree</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {anyWorktree && (
                  <label className="flex items-start gap-2 mb-4 px-3 py-2 rounded-md bg-base/60 border border-border cursor-pointer">
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-red-500"
                      checked={p.deleteWorktrees}
                      onChange={e => setDeleteGroupPrompt(prev => prev ? { ...prev, deleteWorktrees: e.target.checked } : prev)}
                    />
                    <span className="flex-1 text-[12px]">
                      <span className="text-zinc-200">
                        Also delete {worktreeMembers.length} worktree{worktreeMembers.length === 1 ? '' : 's'}
                      </span>
                      <span className="block text-zinc-500">
                        Removes the underlying git worktree directory for each session.
                      </span>
                    </span>
                  </label>
                )}

                <div className="flex justify-end gap-2">
                  <Button variant="flat" onPress={dismiss} isDisabled={p.submitting}>Cancel</Button>
                  <Button className="bg-red-600 text-white" onPress={confirmDeleteGroup} isDisabled={p.submitting}>
                    {p.submitting ? 'Deleting…' : 'Delete'}
                  </Button>
                </div>
              </div>
            </div>
          );
        })()}

        {restoreSessionId && restoreCommands.length > 0 && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center" onClick={dismissRestore}>
            <div className="absolute inset-0 bg-black/50" />
            <div className="relative bg-surface border border-border-light rounded-xl shadow-2xl p-5 max-w-sm w-full" onClick={e => e.stopPropagation()}>
              <h3 className="text-sm font-semibold text-zinc-200 mb-2">Restore Processes</h3>
              <p className="text-[13px] text-zinc-400 mb-3">
                This session had running processes. Restore them?
              </p>
              <div className="space-y-1 mb-4">
                {restoreCommands.map((cmd, i) => (
                  <div key={i} className="flex items-center gap-2 px-3 py-1.5 rounded bg-surface-light text-[12px] font-mono text-green-400">
                    <span className="text-zinc-500">$</span> {cmd}
                  </div>
                ))}
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="flat" onPress={dismissRestore}>Dismiss</Button>
                <Button className="bg-green-600 text-white" onPress={confirmRestore}>Restore</Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </Providers>
  );
}
