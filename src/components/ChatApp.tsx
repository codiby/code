import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, Send as SendIcon, Sparkles, PanelsTopLeft, PanelTop, PanelLeft, LayoutGrid, Search, Terminal, ChevronUp, ChevronDown, ChevronRight, X, Plus, Maximize2, Minimize2, Check } from 'lucide-react';
import { Button, Select, SelectTrigger, SelectValue, SelectPopover, SelectIndicator, ListBox, ListBoxItem } from '@heroui/react';
import Editor, { DiffEditor, type Monaco } from '@monaco-editor/react';
import { DiffReview, type ReviewComment } from './DiffReview';
import { ImagePreview } from './ImagePreview';
import { Providers } from './Providers';
import { FileExplorer, type GitModifiedState } from './FileExplorer';
import { SessionTabStrip } from './SessionTabStrip';
import { TabBar } from './TabBar';
import { SessionsBoardView } from './SessionsBoardView';
import { ActivityBarSessionActions } from './ActivityBarSessionActions';
import { RunningInstancesButton } from './RunningInstancesButton';
import { MessageBubble, AgentBubble, ToolRunBubble, groupMessages, collapseToolRuns, AnsiText } from './MessageBubble';
import { Markdown } from './Markdown';
import { NewSessionModal } from './NewSessionModal';
import { WorktreeModal } from './WorktreeModal';
import { BypassWarningModal, shouldWarnBypass } from './BypassWarningModal';
import { BrowserUrlModal } from './BrowserUrlModal';
import { useSlashCommands, SlashCommandList } from './SlashCommandPicker';
import { useFileMention, FileMentionList } from './FileMentionPicker';
import { CommandPalette, type PaletteAction } from './CommandPalette';
import { ChatFindWidget } from './ChatFindWidget';
import { ProjectSettingsModal } from './ProjectSettingsModal';
import { KeyboardShortcutsModal } from './KeyboardShortcutsModal';
import { matchCommand, resolveBindings, type KeybindingOverrides } from '../lib/keybindings';
import { PortlessActionToast } from './PortlessActionToast';
import { InteractiveTerminalBubble } from './InteractiveTerminalBubble';
import type { TabGroupInfo, ProjectEnvVar } from '../lib/tab-groups';
import { GROUP_HEX_COLOR } from '../lib/tab-groups';
import { PluginLinkedItemPickers, PluginDetailView, PluginSidebarPanels } from './PluginExtensionPoints';
import { PRDetail, type PRInfo } from './PRDetail';
import { useFileIndex } from '../lib/fuzzy-file-search';
import { buildBrowserRequestHandler as handleBrowserCdpRequest, browserLabelFor } from '../lib/browser-cdp-bridge';
import { tryInvokeNative } from '../lib/native';
import { PanelsWorkspace } from '../panels/PanelsWorkspace';
import type { Tab as PanelTab } from '../panels/types';
// Browser names are validated by the bridge before any open_browser broadcast,
// but the palette action constructs a label client-side, so keep the same
// kebab/snake-case pattern in sync here.
const BROWSER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/;
// Notifications use the standard Web Notification API. Electron's Chromium
// surface implements it natively.
async function isPermissionGranted(): Promise<boolean> {
  if (typeof Notification === 'undefined') return false;
  return Notification.permission === 'granted';
}
async function requestPermission(): Promise<'granted' | 'denied' | 'default'> {
  if (typeof Notification === 'undefined') return 'denied';
  if (Notification.permission === 'granted') return 'granted';
  return await Notification.requestPermission();
}
function sendNotification(opts: { title: string; body?: string }): void {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission !== 'granted') return;
  try { new Notification(opts.title, { body: opts.body }); } catch {}
}
import type { editor as MonacoEditor } from 'monaco-editor';
import {
  ClaudeClient,
  resolveServerUrl,
  setActiveRemoteId,
  type ChatMessage,
  type ConnectionStatus,
  type FileChange,
  type PermissionRequest,
  type SessionActivity,
  type SessionInfo,
  type SessionInitInfo,
  type SessionState,
  type SupportedModel,
  type TerminalInfo,
} from '../lib/claude-client';
import { LspClient } from '../lib/lsp-client';
import { DebugPanel } from './DebugPanel';
import { type MockupComment } from '../lib/mockup-inspector';
import { MockupPanel } from './MockupPanel';
import { BrowserPanel, useBrowserPreviewBounds } from './BrowserPanel';
import { PlanPanel, type PlanComment } from './PlanPanel';
import {
  ChatFocusLayout,
  loadInitialWorkspaces,
  persistWorkspaces,
  reconcileWorkspaceLayout,
  sameLayout,
  type Workspace,
} from './ChatFocusLayout';
import { BookmarkPlus, MessageSquarePlus } from 'lucide-react';
import { PortForwardsPopover } from './PortForwardsPopover';
import { ChatComposer } from './ChatComposer';
import { CtrlTabSwitcher } from './CtrlTabSwitcher';
import { GroupComposer } from './GroupComposer';

/** Module-scoped empty-array sentinel for the BrowserPanel `comments` prop.
 *  Using `… || []` at the JSX site allocates a fresh array on every render
 *  and trips child useEffects that depend on the prop reference — the
 *  BrowserPanel was getting `set_comments([])` invoked continuously, which
 *  was wiping its inspector's local state every render. */
const NO_BROWSER_COMMENTS: MockupComment[] = [];

type PendingMessage = {
  id: string;
  text: string;
  images?: { media_type: string; data: string }[];
};

// Local UI extensions on top of server SessionState
type LocalSessionState = SessionState & {
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
  // Live browser previews opened by `browser_open` — UI-only, same caveat
  // as `openMockup` so the `onSessionState` merge has to preserve them.
  // `browsers` is keyed by the model-supplied `name` (e.g. "qa-admin-
  // workflow"); multiple can coexist in a single session, each surfaced as
  // its own tab in the PanelsWorkspace. `openSeq` per
  // entry is bumped on every `open_browser` broadcast so the panel re-runs
  // its open effect when the same name is re-broadcast (retry after error,
  // reopen from chat-header chip).
  browsers: Record<string, { url: string; title: string; openSeq: number; cookieJar: string }>;
  /** Which browser name is currently revealed / focused. Tracks the visible
   *  browser panel tab and drives the focus-mode anchor + header-chip
   *  highlight. `null` when no browser is open. Matches a key in `browsers`. */
  activeBrowserName: string | null;
  /** Inspector comments, keyed by `name` then by URL — same name surviving
   *  navigations + matching the per-page-mounted dot lifecycle. */
  browserComments: Record<string, Record<string, MockupComment[]>>;
  /** Per-name inspect-mode toggle. Switching tabs preserves per-tab state. */
  browserInspect: Record<string, boolean>;
  /** Images pasted into the composer, awaiting the next send. Per-session so
   *  the focus-mode layout can show separate paste buffers in each pane. */
  pastedImages: { media_type: string; data: string; preview: string }[];
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

// Extensions that open in the image preview tab instead of the text editor.
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg']);

function SearchPanel({ client, rootPath, onFileOpen, onClose }: { client: ClaudeClient | null; rootPath: string | null; onFileOpen: (path: string, line?: number) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [ignore, setIgnore] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [results, setResults] = useState<{ file: string; line: number; text: string }[]>([]);
  const [searching, setSearching] = useState(false);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const doSearch = (q: string, cs: boolean, ig: string) => {
    if (!client || !rootPath || !q.trim()) {
      abortRef.current?.abort();
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      client.searchFiles(rootPath, q.trim(), { caseSensitive: cs, ignore: ig, signal: ctrl.signal })
        .then(r => { if (!ctrl.signal.aborted) { setResults(r); setSearching(false); } })
        .catch(() => { if (!ctrl.signal.aborted) { setResults([]); setSearching(false); } });
    }, 150);
  };

  // Re-run when the user toggles case sensitivity or edits the ignore globs
  // so the result set updates in place (VS Code-style).
  useEffect(() => {
    if (query.trim()) doSearch(query, caseSensitive, ignore);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseSensitive, ignore]);

  const grouped = useMemo(() => {
    const map = new Map<string, { file: string; line: number; text: string }[]>();
    for (const r of results) {
      const relFile = rootPath && r.file.startsWith('./') ? r.file.slice(2) : r.file;
      let arr = map.get(relFile);
      if (!arr) { arr = []; map.set(relFile, arr); }
      arr.push(r);
    }
    return Array.from(map, ([file, items]) => ({ file, items }));
  }, [results, rootPath]);

  const toggleFile = (file: string) => {
    setCollapsedFiles(prev => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file); else next.add(file);
      return next;
    });
  };

  return (
    <div className="rounded-[11px] border border-[#1e1f24] bg-[#141519] overflow-hidden flex-1 flex flex-col min-h-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.035),0_1px_2px_rgba(0,0,0,0.25)]">
      <div className="flex items-center gap-[9px] h-[34px] px-[11px] shrink-0">
        <span className="flex w-[15px] h-[15px] items-center justify-center shrink-0 text-[#7c5cff]">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>
        </span>
        <span className="text-[10.5px] font-semibold tracking-[0.07em] uppercase text-[#9aa0a8]">Search</span>
        <button className="ml-auto w-[22px] h-[22px] rounded-[6px] flex items-center justify-center text-[#4f525a] hover:text-[#9aa0a8] hover:bg-[#191a1f] transition-colors" onClick={onClose} aria-label="Close search">&#x2715;</button>
      </div>
      <div className="h-px mx-[11px] bg-[linear-gradient(90deg,transparent,#26272d_12%,#26272d_88%,transparent)]" />
      <div className="px-2 py-2 border-b border-border shrink-0 space-y-1.5">
        <div className="relative">
          <input
            ref={inputRef}
            value={query}
            onChange={e => { setQuery(e.target.value); doSearch(e.target.value, caseSensitive, ignore); }}
            onKeyDown={e => { if (e.key === 'Escape') onClose(); }}
            placeholder="Search in files..."
            className="w-full bg-surface border border-border rounded pl-2 pr-7 py-1 text-[12px] text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-zinc-500"
          />
          <button
            type="button"
            onClick={() => setCaseSensitive(v => !v)}
            title={caseSensitive ? 'Match Case (on)' : 'Match Case (off)'}
            aria-pressed={caseSensitive}
            className={`absolute right-1 top-1/2 -translate-y-1/2 w-5 h-5 rounded text-[10px] font-semibold flex items-center justify-center transition-colors ${caseSensitive ? 'bg-violet-600/30 text-violet-300 ring-1 ring-violet-500/40' : 'text-zinc-500 hover:text-zinc-300 hover:bg-surface-light/50'}`}
          >
            Aa
          </button>
        </div>
        <input
          value={ignore}
          onChange={e => setIgnore(e.target.value)}
          onKeyDown={e => { if (e.key === 'Escape') onClose(); }}
          placeholder="files to exclude (e.g. *.lock, dist/**)"
          className="w-full bg-surface border border-border rounded px-2 py-1 text-[11px] text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-zinc-500"
        />
      </div>
      <div className="flex-1 overflow-y-auto">
        {searching && <p className="text-[11px] text-zinc-600 text-center py-4">Searching...</p>}
        {!searching && query && grouped.length === 0 && <p className="text-[11px] text-zinc-600 text-center py-4">No results</p>}
        {grouped.map(({ file, items }) => {
          const collapsed = collapsedFiles.has(file);
          const Chev = collapsed ? ChevronRight : ChevronDown;
          const filename = file.split('/').pop() || file;
          const dir = file.slice(0, file.length - filename.length);
          return (
            <div key={file} className="border-b border-border/30">
              <button
                type="button"
                onClick={() => toggleFile(file)}
                className="w-full flex items-center gap-1 px-1.5 py-1 hover:bg-surface-light/40 text-left"
              >
                <Chev className="w-3 h-3 text-zinc-500 shrink-0" strokeWidth={2.5} />
                <span className="text-[11px] text-zinc-300 truncate">{filename}</span>
                {dir && <span className="text-[10px] text-zinc-600 truncate">{dir.replace(/\/$/, '')}</span>}
                <span className="ml-auto text-[10px] text-zinc-500 shrink-0 px-1 rounded bg-surface-light/40">{items.length}</span>
              </button>
              {!collapsed && items.map((r, i) => (
                <div
                  key={i}
                  className="flex items-baseline gap-2 pl-6 pr-2 py-0.5 hover:bg-surface-light/50 cursor-pointer transition-colors"
                  onClick={() => onFileOpen(rootPath ? `${rootPath}/${file}` : file, r.line)}
                >
                  <span className="text-[10px] text-zinc-600 shrink-0 tabular-nums">{r.line}</span>
                  <span className="text-[10px] text-zinc-400 font-mono truncate leading-snug flex-1">{r.text}</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Shared chime helper — used by both the desktop ChatApp and the mobile UI
// so the audio cue on permission requests / turn completion is identical.
import { playChime } from '../lib/chime';

// Accent hues for sessions without an explicit (remote) color. Picked to read
// well on the dark surface and stay distinct from one another.
const SESSION_ACCENT_PALETTE = [
  '#7c5cff', '#22d3ee', '#f59e0b', '#34d399',
  '#f87171', '#c084fc', '#38bdf8', '#fb7185',
];

// When a turn is interrupted (barge-in send or Stop), the text/thinking that has
// streamed so far lives only in the live `partialText`/`partialThinking` preview —
// the SDK never re-delivers a completed block for the aborted turn. Snapshot that
// content into permanent messages so it isn't wiped when the preview is cleared.
function carriedStreamMessages(s: { partialText: string; partialThinking: string }): ChatMessage[] {
  const carried: ChatMessage[] = [];
  if (s.partialThinking) {
    carried.push({
      id: crypto.randomUUID(),
      role: 'assistant',
      content: s.partialThinking,
      timestamp: Date.now(),
      isThinking: true,
    });
  }
  if (s.partialText) {
    carried.push({
      id: crypto.randomUUID(),
      role: 'assistant',
      content: s.partialText,
      timestamp: Date.now(),
    });
  }
  return carried;
}

export function ChatApp() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  // Session lifecycle is per-session and persisted server-side (status:
  // 'open' | 'archived'). The set below is derived from the sessions list
  // so callers that need O(1) membership lookups keep working without us
  // tracking duplicate state.
  const archivedSessionIds = useMemo(
    () => new Set(sessions.filter(s => s.status === 'archived').map(s => s.id)),
    [sessions],
  );
  const archivedIdsRef = useRef(archivedSessionIds);
  useEffect(() => { archivedIdsRef.current = archivedSessionIds; }, [archivedSessionIds]);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Ctrl+Tab switcher — open flag + currently-highlighted index. `ids` is
  // the frozen, tab-bar-ordered list the switcher renders for the lifetime
  // of one open cycle (see `buildSwitcherIds`).
  const [switcher, setSwitcher] = useState<{ open: boolean; idx: number; ids: string[] }>({
    open: false, idx: 0, ids: [],
  });
  const [tabOrder, setTabOrder] = useState<string[]>([]);
  const [tabGroups, setTabGroups] = useState<Record<string, TabGroupInfo>>({});
  const [tabGroupMap, setTabGroupMap] = useState<Record<string, string>>({});
  const [pinnedSessionIds, setPinnedSessionIds] = useState<Set<string>>(new Set());
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(new Set());
  /** Group focused in the sidebar. When set, the main pane renders the
   *  inline new-session composer (GroupComposer) instead of the active
   *  session's chat body. Cleared as soon as a session is selected. */
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  // Active top-level view in the main pane. 'sessions-board' shows the board;
  // selecting any session or group snaps it back to 'sessions'.
  const [activeNavView, setActiveNavView] = useState<'sessions' | 'sessions-board'>('sessions');
  const [autoGroupSessions, setAutoGroupSessions] = useState(false);
  // When true, action-style browser_* SDK tools (click/type/scroll/…) bring
  // the targeted preview to the front before they run, so the user actually
  // sees the action happen. Per-project override lives on TabGroupInfo and
  // wins over this global default. Defaults to true on first launch.
  const [autoFocusBrowserOnAction, setAutoFocusBrowserOnAction] = useState(true);
  // Hides the Telegram bot's "main-session" pseudo-tab from the sidebar /
  // tab bar. The tab itself is non-closable from the regular UI; this
  // settings-only toggle is the user's escape hatch.
  const [showTelegramSession, setShowTelegramSession] = useState(true);
  // When true, sending a message while the agent is mid-response cancels
  // the in-flight turn and ships the new message immediately. When false,
  // the message is appended to the per-session queue and drains after the
  // current turn finishes. Defaults to true — barging-in is the more
  // common intent than calmly queueing follow-ups.
  const [interruptOnSend, setInterruptOnSend] = useState(true);
  // When true, each session gets a stable accent color that tints its
  // focus-mode pane (header, border, chat background) and its message cards
  // so panes are distinguishable at a glance. Purely cosmetic — some people
  // prefer the plain look, so it's a toggle. Defaults on.
  const [colorChatBySession, setColorChatBySession] = useState(true);
  // When true, the accent also washes the whole chat background (in addition
  // to the message bubbles). Off by default — the wash reads as heavy for some.
  const [tintChatBackground, setTintChatBackground] = useState(false);
  // Per-session accent color overrides (sessionId → hex). Absence means the
  // color is auto-derived (remote color, else a deterministic palette hue).
  const [sessionAccents, setSessionAccents] = useState<Record<string, string>>({});
  // Global env vars (apply to every Bash tool call + user terminal, on
  // top of process.env, with per-project envVars layered last). Persisted
  // alongside other prefs in ~/.codiby/ui-preferences.json.
  const [globalEnvVars, setGlobalEnvVars] = useState<ProjectEnvVar[]>([]);

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

  /** Close a terminal — close === kill. DELETEs the terminal resource; the
   *  dock drops the tab when the `terminal_removed` broadcast lands (which
   *  also prunes activeShell state via onTerminalRemoved). Shared by the
   *  context menu, the chip's × button, and the tab strip's × button. */
  const dismissShellPersistent = (procId: string, shellId: string) => {
    if (!activeId) return;
    try { void clientRef.current?.deleteTerminal(activeId, procId); } catch {}
    setMinimizedShells(prev => {
      if (!prev.has(shellId)) return prev;
      const n = new Set(prev); n.delete(shellId); return n;
    });
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
    // If every member of this group lives on the same remote, the new
    // session goes there too — otherwise it stays local.
    const groupRemoteId = firstMember?.remoteId
      && sessions.filter(s => tabGroupMap[s.id] === groupId).every(s => s.remoteId === firstMember.remoteId)
        ? firstMember.remoteId
        : null;
    try {
      const session = await c.createSession(cwd, { remoteId: groupRemoteId });
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

  /** Spawn a session from the inline GroupComposer. The composer supplies
   *  the final cwd (which may be a freshly-created worktree path), the
   *  provider, and an optional first prompt to send right after the
   *  session boots. Mirrors handleNewSessionInGroup's group-binding +
   *  legacy cwd backfill, plus a primer message. */
  const handleSpawnInGroup = async (
    groupId: string,
    cwd: string,
    provider: string,
    prompt: string,
    model?: string,
    permissionMode?: string,
    worktreeOrigin?: string,
    remoteId?: string | null,
    images?: { media_type: string; data: string }[],
  ) => {
    const c = clientRef.current;
    if (!c) return;
    const group = tabGroups[groupId];
    if (!group || !cwd) return;
    try {
      const session = await c.createSession(cwd, { provider, model, permissionMode, groupCwd: worktreeOrigin, remoteId: remoteId ?? null });
      const newMap = { ...tabGroupMap, [session.id]: groupId };
      setTabGroupMap(newMap);
      let nextGroups = tabGroups;
      if (!group.cwd) {
        // Prefer the parent repo over the worktree path so future opens
        // resolve to the main repo, matching handleWorktreeCreatedForGroup.
        nextGroups = { ...tabGroups, [groupId]: { ...group, cwd: worktreeOrigin || cwd } };
        setTabGroups(nextGroups);
      }
      setExpandedGroupIds(prev => { const next = new Set(prev); next.add(groupId); return next; });
      c.subscribe(session.id);
      subscribedRef.current.add(session.id);
      setSelectedGroupId(null);
      setActiveId(session.id);
      persistPrefs({ tabGroupMap: newMap, ...(group.cwd ? {} : { tabGroups: nextGroups }) });
      if (prompt || images?.length) c.sendMessage(session.id, prompt || ' ', images);
    } catch (err) {
      console.error('[ChatApp] Failed to spawn session in group:', err);
    }
  };

  /** Spawn a session from the home GroupComposer (no group binding). The
   *  composer supplies the final cwd, provider, and an optional first prompt
   *  to send right after the session boots. Mirrors handleSpawnInGroup but
   *  skips the group wiring. */
  const handleSpawnHome = async (
    cwd: string,
    provider: string,
    prompt: string,
    model?: string,
    permissionMode?: string,
    worktreeOrigin?: string,
    _remoteId?: string | null,
    images?: { media_type: string; data: string }[],
  ) => {
    const c = clientRef.current;
    if (!c || !cwd) return;
    try {
      // When the cwd is a worktree, autogroup under the parent repo's folder
      // name instead of the worktree branch. Server-side autogroup honors
      // the user's autoGroupSessions preference — if it's off, the session
      // still lands as an ungrouped tab.
      const session = await c.createSession(cwd, { provider, model, permissionMode, groupCwd: worktreeOrigin });
      c.subscribe(session.id);
      subscribedRef.current.add(session.id);
      setActiveId(session.id);
      if (prompt || images?.length) c.sendMessage(session.id, prompt || ' ', images);
    } catch (err) {
      console.error('[ChatApp] Failed to spawn session from home:', err);
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

  /** Click on a group header in the sidebar. Always focuses the group
   *  (renders GroupComposer in the main pane). Expansion still toggles —
   *  the user can collapse/expand the tab list without losing focus.
   *  Previously this auto-selected a member, which created the
   *  "Waiting for connection…" gap when no member was a fit and left
   *  a stale active session on the second (collapsing) click. */
  const handleToggleGroup = (groupId: string) => {
    setSelectedGroupId(groupId);
    setExpandedGroupIds(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  /** Focus a group without toggling its expansion state. Invoked by the
   *  hover "+" icon on a group header — swaps GroupComposer into the main
   *  pane and ensures the group is expanded so the user sees existing
   *  members underneath the composer. */
  const handleSelectGroup = (groupId: string) => {
    setActiveNavView('sessions');
    setSelectedGroupId(groupId);
    setExpandedGroupIds(prev => {
      if (prev.has(groupId)) return prev;
      const next = new Set(prev);
      next.add(groupId);
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
  /** Per-session running child processes + listening ports, pushed by the
   *  server's `session_activity`. Drives the sidebar badges. A session drops
   *  out of the map (badges hidden) once it reports fully idle. */
  const [sessionActivity, setSessionActivity] = useState<Record<string, SessionActivity>>({});
  /** Tunnel status per remote, pushed by the server's `remote.status`
   *  broadcasts. Drives the offline state on the chat-header forwards chip. */
  const [remoteStatuses, setRemoteStatuses] = useState<Record<string, { status: 'connecting' | 'online' | 'reconnecting' | 'offline'; lastError: string | null }>>({});
  // Terminals as first-class resources, keyed by sessionId. Fetched from the
  // bridge on connect (`onTerminalsSnapshot`) and kept in sync via the
  // `terminal_created` / `terminal_removed` / `terminal_exit` broadcasts. The
  // terminals dock renders straight from this — terminals are never inferred
  // from chat messages, and a create only shows up once its broadcast lands.
  const [terminals, setTerminals] = useState<Record<string, TerminalInfo[]>>({});
  // Bottom Terminals panel — collapsed means the panel is a single status
  // strip with no xterm body shown; expanded means full tabbed UI. Starts
  // collapsed (VSCode-style); opening/spawning a shell auto-expands it.
  const [terminalsPanelExpanded, setTerminalsPanelExpanded] = useState<boolean>(false);
  // The terminals dock is authored inside the chat panel (so it keeps all its
  // closures) but portaled into this host, which sits below the panels and
  // spans the full content width — VSCode-style, outside the file panels.
  const [termDockHost, setTermDockHost] = useState<HTMLDivElement | null>(null);
  /** Whether keyboard focus is inside the terminals dock — drives the same
   *  blue focus ring the workspace panels use. Tracked via a capture-phase
   *  pointer/focus listener since the xterm canvas doesn't bubble React focus. */
  const [terminalsFocused, setTerminalsFocused] = useState(false);
  useEffect(() => {
    if (!termDockHost) return;
    const onDown = (e: Event) => setTerminalsFocused(termDockHost.contains(e.target as Node));
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('focusin', onDown, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('focusin', onDown, true);
    };
  }, [termDockHost]);
  /** Maximize toggles the panel height between the default ~340px and a
   *  much taller 70vh — handy when watching a noisy dev server. */
  const [terminalsPanelMaximized, setTerminalsPanelMaximized] = useState<boolean>(false);
  /** User-resizable panel height in pixels. Persisted via prefs. Clamped
   *  to [120, viewportHeight * 0.85] at runtime. */
  const [terminalsPanelHeight, setTerminalsPanelHeight] = useState<number>(340);
  /** True while the user is dragging the splitter — used to show an overlay
   *  that prevents iframes/xterm from eating mousemove events. */
  const [panelResizing, setPanelResizing] = useState<boolean>(false);
  /** Per-session, per-shell custom display names. Persisted via the
   *  prefs system so renames survive across reloads. Falls back to the
   *  message's `terminalName` then to a derived value. */
  const [shellRenames, setShellRenames] = useState<Record<string, Record<string, string>>>({});
  /** Global Portless TLD — applies to every project (portless's proxy
   *  serves one TLD at a time, so this can't be per-project). */
  const [portlessTld, setPortlessTld] = useState<string>('localhost');
  /** When non-null, the tab with this shellId renders an inline rename
   *  input instead of its display name. */
  const [renamingShellId, setRenamingShellId] = useState<string | null>(null);
  /** Cross-action env vars taskr injected into each PTY at spawn time.
   *  Keyed by procId. Populated by the `terminal_env_injected` WS event. */
  const [injectedEnvByProc, setInjectedEnvByProc] = useState<Record<string, Record<string, string>>>({});
  /** Status-strip env popover state — which terminal's env is open. */
  const [envPopoverProcId, setEnvPopoverProcId] = useState<string | null>(null);
  /** Right-click context menu state for the tab strip. */
  const [tabContextMenu, setTabContextMenu] = useState<
    { shellId: string; procId: string; running: boolean; x: number; y: number } | null
  >(null);
  // Server is the source of truth for session state. This map is populated only by server messages.
  const [sessionStates, setSessionStates] = useState<Record<string, LocalSessionState>>({});
  const historyIdxRef = useRef(-1);
  const historyDraftRef = useRef('');
  const subscribedRef = useRef(new Set<string>());
  // pastedImages now lives in LocalSessionState.pastedImages, so each
  // focus-mode pane can buffer its own pending images independently.
  // Pulled once from the bridge on mount via /providers/opencode/info.
  // `null` = probe in flight, `{available: false}` = opencode binary is
  // missing or its first boot failed (in which case the New Session
  // modal hides the OpenCode option). Populated from opencode's
  // provider.list, so it reflects whichever providers the user has
  // authenticated for.
  const [opencodeInfo, setOpencodeInfo] = useState<{ available: boolean; models: Array<{ id: string; label: string; providerName: string }> } | null>(null);
  // Cached snapshot of the Claude Agent SDK's supportedModels(), shared by
  // every Claude picker. Populated lazily from `/providers/claude/info`; the
  // server fills the cache as soon as any Claude session reports its list.
  // Stays an empty array on first launch when no Claude session has booted yet.
  const [claudeModels, setClaudeModels] = useState<SupportedModel[]>([]);
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
  // ⌘F in-chat find widget (VSCode-style). Searches the active session's
  // rendered message stream via the CSS Custom Highlight API.
  const [findOpen, setFindOpen] = useState(false);
  const [explorerCollapsed, setExplorerCollapsed] = useState(false);
  // Search-as-a-card: when true the FileExplorer panel swaps its cards for the
  // search card. Driven from here so ⌘⇧F can toggle it.
  const [searchActive, setSearchActive] = useState(false);
  // Sidebar tab requested via keyboard shortcut. The nonce lets pressing the
  // same shortcut again re-fire (FileExplorer owns the actual active-tab state).
  const [tabRequest, setTabRequest] = useState<{ card: string; nonce: number } | null>(null);
  const tabNonceRef = useRef(0);
  const requestSidebarTab = useCallback((card: string) => {
    setExplorerCollapsed(false);
    setTabRequest({ card, nonce: ++tabNonceRef.current });
  }, []);
  const [projectSettings, setProjectSettings] = useState<{ open: boolean; sectionId?: string }>({ open: false });
  // Keyboard-shortcut overrides (command id → chord, or null to force-unbind);
  // defaults live in the keybinding registry. Hydrated from the bridge and kept
  // live across windows via the `onKeybindings` websocket broadcast.
  const [kbOverrides, setKbOverrides] = useState<KeybindingOverrides>({});
  const [showShortcuts, setShowShortcuts] = useState(false);
  // Tracks whether a plugin's <PluginDetailView /> is currently visible. Updated
  // from the codiby-code:linked-item-changed event so the right panel can claim space.
  const [pluginDetailOpen, setPluginDetailOpen] = useState(false);
  const [prLinks, setPrLinks] = useState<Record<string, { prNumber: number; title: string; url: string; headRefName: string; state: string }>>({});
  const [showPrDropdown, setShowPrDropdown] = useState(false);
  const [sessionPrs, setSessionPrs] = useState<{ number: number; title: string; headRefName: string; state: string; url: string; isDraft: boolean }[]>([]);
  const [openPR, setOpenPR] = useState<PRInfo | null>(null);

  const gitModifiedCacheRef = useRef<Record<string, GitModifiedState>>({});
  const [gitModified, setGitModified] = useState<GitModifiedState>({ staged: new Set(), unstaged: new Set(), untracked: new Set(), stats: new Map() });
  // Changes-section comparison mode: 'vs-main' lists everything this branch
  // changed relative to the base branch (merge-base); 'uncommitted' is the
  // classic staged/unstaged/untracked working-tree view. The resolved base
  // branch name (main/master/…) is detected per workspace. Refs mirror them so
  // refreshGitModified / diff handlers read the current value without re-binding.
  const [changesCompare, setChangesCompare] = useState<'vs-main' | 'uncommitted'>('vs-main');
  const [baseBranch, setBaseBranch] = useState<string>('main');
  const changesCompareRef = useRef(changesCompare);
  changesCompareRef.current = changesCompare;
  const baseBranchRef = useRef(baseBranch);
  baseBranchRef.current = baseBranch;
  const [client, setClient] = useState<ClaudeClient | null>(null);
  const clientRef = useRef<ClaudeClient | null>(null);
  // Live mirror of `activeId` readable from long-lived client callbacks
  // (which capture the value at construction time otherwise).
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
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
  // Top-level layout mode — controls the shape of the main UI. "standard" keeps
  // the current IDE-style layout (sidebar + editor + chat); "focus" hides the
  // IDE chrome and tiles multiple chats. Wiring of the actual mode-switching
  // comes in follow-up steps — for now this just drives the title bar pill.
  const [layoutMode, setLayoutMode] = useState<'standard' | 'horizontal' | 'focus'>(() => {
    try {
      const v = localStorage.getItem('claude-ui-layout-mode');
      if (v === 'focus' || v === 'horizontal' || v === 'standard') return v;
      return 'standard';
    } catch { return 'standard'; }
  });
  const changeLayoutMode = useCallback((mode: 'standard' | 'horizontal' | 'focus') => {
    setLayoutMode(mode);
    try { localStorage.setItem('claude-ui-layout-mode', mode); } catch {}
  }, []);

  // Workspace state for focus mode. Lifted here (rather than living inside
  // ChatFocusLayout) so the title bar can surface workspace-level actions
  // ("add active chat to workspace", "new chat in workspace") next to the
  // layout-mode pill.
  const [focusWorkspaces, setFocusWorkspaces] = useState<Workspace[]>(() => {
    return loadInitialWorkspaces([]).workspaces;
  });
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>(() => {
    return loadInitialWorkspaces([]).activeId;
  });
  const activeWorkspace = useMemo(
    () => focusWorkspaces.find(w => w.id === activeWorkspaceId) ?? focusWorkspaces[0]!,
    [focusWorkspaces, activeWorkspaceId],
  );
  // Picker popover for "add a chat to this workspace". Click-outside and
  // Escape close it; mounting is conditional in the JSX below.
  const [addChatPickerOpen, setAddChatPickerOpen] = useState(false);
  const addChatBtnRef = useRef<HTMLButtonElement>(null);
  const addChatPickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!addChatPickerOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (addChatPickerRef.current?.contains(t)) return;
      if (addChatBtnRef.current?.contains(t)) return;
      setAddChatPickerOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setAddChatPickerOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [addChatPickerOpen]);
  /** Move the given session into the currently-active workspace. Move
   *  semantics (not copy) — the session is removed from any other workspace
   *  that owned it so a chat is always in exactly one workspace. */
  const addSessionToActiveWorkspace = useCallback((sid: string) => {
    setFocusWorkspaces(prev => prev.map(w => {
      if (w.id === activeWorkspaceId) {
        if (w.sessionIds.includes(sid)) return w;
        const sessionIds = [...w.sessionIds, sid];
        return { ...w, sessionIds, layout: reconcileWorkspaceLayout(w.layout, sessionIds) };
      }
      if (w.sessionIds.includes(sid)) {
        const sessionIds = w.sessionIds.filter(id => id !== sid);
        return { ...w, sessionIds, layout: reconcileWorkspaceLayout(w.layout, sessionIds) };
      }
      return w;
    }));
  }, [activeWorkspaceId]);
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
  // Live unsaved buffer per editor path, keyed `${sessionId}::${path}`. Written
  // on every Monaco change (a ref write — no re-render) so switching away from a
  // pinned-and-modified tab and back restores the in-progress edits (only the
  // active tab's Monaco is mounted, so the rest rely on this).
  const liveBuffersRef = useRef<Record<string, string>>({});
  const liveBufKey = (sid: string, path: string) => `${sid}::${path}`;

  const emptyLocalState = (): LocalSessionState => ({
    messages: [], partialText: '', partialThinking: '', isStreaming: false, wasInterrupted: false, initInfo: null, permRequest: null,
    supportedModels: [],
    editorTabs: [], activeEditorPath: null, panelFocusTabId: null, panelFocusSeq: 0,
    openTerminalId: null, diffView: null, editorFullWidth: false,
    reviewComments: {}, reviewMode: false, reviewFiles: [], reviewIndex: 0, todos: [],
    input: '', inputHistory: [],
    contextTokens: 0,
    pendingMessages: [],
    openMockup: null, lastMockup: null,
    mockupComments: {}, mockupInspect: false,
    browsers: {}, activeBrowserName: null,
    browserComments: {}, browserInspect: {},
    openPlan: null, lastPlan: null, planComments: [], planRequestId: null,
    pastedImages: [],
  });

  const getState = (id: string | null): LocalSessionState => {
    if (!id) return emptyLocalState();
    return sessionStates[id] || emptyLocalState();
  };

  // setInput: update local state immediately and sync to server
  const setInput = (val: string | ((prev: string) => string)) => {
    if (!activeId) return;
    setInputForSession(activeId, val);
  };

  // Per-session variant — used by each focus-mode pane's composer so typing
  // into pane B edits session B's draft without forcing it active first.
  const setInputForSession = (sid: string, val: string | ((prev: string) => string)) => {
    if (!clientRef.current) return;
    const current = getState(sid).input;
    const newVal = typeof val === 'function' ? val(current) : val;
    setSessionStates(prev => ({
      ...prev,
      [sid]: { ...(prev[sid] || emptyLocalState()), input: newVal },
    }));
    clientRef.current.updateUIState(sid, { input: newVal });
  };

  // Per-session paste buffer setter — symmetric with setInputForSession.
  const setPastedImagesForSession = (
    sid: string,
    val: { media_type: string; data: string; preview: string }[] |
         ((prev: { media_type: string; data: string; preview: string }[]) => { media_type: string; data: string; preview: string }[]),
  ) => {
    setSessionStates(prev => {
      const s = prev[sid] || emptyLocalState();
      const next = typeof val === 'function' ? val(s.pastedImages) : val;
      return { ...prev, [sid]: { ...s, pastedImages: next } };
    });
  };

  const updateLocalState = useCallback((id: string, fn: (prev: LocalSessionState) => LocalSessionState) => {
    setSessionStates(prev => {
      const current = prev[id] || emptyLocalState();
      return { ...prev, [id]: fn(current) };
    });
  }, []);

  // --- Editor tab helpers (VSCode-style preview tabs) ----------------------
  // Each open file is a panel tab. At most one is a `preview` tab; opening
  // another file replaces it in place. Double-clicking the tab or editing the
  // file pins it (preview=false). All operate on the given session.

  // Open a file in the editor: activate if already open; else replace the
  // current preview tab; else append a new (preview) tab. Always reveal it.
  const openFileInEditor = useCallback((sid: string, path: string, content: string, line?: number, opts?: { pin?: boolean; column?: number; readOnly?: boolean; image?: boolean }) => {
    const pin = opts?.pin ?? false;
    const column = opts?.column;
    const readOnly = opts?.readOnly;
    const image = opts?.image;
    updateLocalState(sid, s => {
      const tabs = s.editorTabs;
      const idx = tabs.findIndex(t => t.path === path);
      let nextTabs: typeof tabs;
      if (idx >= 0) {
        // Already open — keep its dirty/preview/read-only state, just update
        // the target line/column (and pin if requested).
        nextTabs = tabs.map((t, i) => i === idx
          ? { ...t, line, column, preview: pin ? false : t.preview }
          : t);
      } else {
        const newTab = { path, content, line, column, dirty: false, preview: !pin, readOnly, image };
        const previewIdx = tabs.findIndex(t => t.preview);
        if (previewIdx >= 0) {
          // Replace the existing preview tab in place (keeps strip position).
          delete liveBuffersRef.current[liveBufKey(sid, tabs[previewIdx].path)];
          nextTabs = tabs.map((t, i) => i === previewIdx ? newTab : t);
        } else {
          nextTabs = [...tabs, newTab];
        }
      }
      return {
        ...s,
        editorTabs: nextTabs,
        activeEditorPath: path,
        panelFocusTabId: 'editor:' + path,
        panelFocusSeq: s.panelFocusSeq + 1,
      };
    });
  }, [updateLocalState]);

  // Pin a preview tab (double-click on the pill, or first edit).
  const pinEditor = useCallback((sid: string, path: string) => {
    updateLocalState(sid, s => ({
      ...s,
      editorTabs: s.editorTabs.map(t => t.path === path && t.preview ? { ...t, preview: false } : t),
    }));
  }, [updateLocalState]);

  // Mark a tab dirty/clean. Editing also pins it (a modified tab is never a
  // preview). Reverting to clean clears dirty but keeps it pinned.
  const markEditorDirty = useCallback((sid: string, path: string, dirty: boolean) => {
    updateLocalState(sid, s => ({
      ...s,
      editorTabs: s.editorTabs.map(t => t.path === path
        ? { ...t, dirty, preview: dirty ? false : t.preview }
        : t),
    }));
  }, [updateLocalState]);

  // Reveal an already-open editor tab (no content change).
  const setActiveEditor = useCallback((sid: string, path: string) => {
    updateLocalState(sid, s => (
      s.editorTabs.some(t => t.path === path)
        ? { ...s, activeEditorPath: path, panelFocusTabId: 'editor:' + path, panelFocusSeq: s.panelFocusSeq + 1 }
        : s
    ));
  }, [updateLocalState]);

  // Close an editor tab; if it was active, fall back to the left neighbour
  // (else null). Mirrors the browser close fallback.
  const closeEditor = useCallback((sid: string, path: string) => {
    delete liveBuffersRef.current[liveBufKey(sid, path)];
    updateLocalState(sid, s => {
      const idx = s.editorTabs.findIndex(t => t.path === path);
      if (idx < 0) return s;
      const nextTabs = s.editorTabs.filter(t => t.path !== path);
      let nextActive = s.activeEditorPath;
      if (s.activeEditorPath === path) {
        const neighbour = nextTabs[idx - 1] ?? nextTabs[idx] ?? nextTabs[nextTabs.length - 1] ?? null;
        nextActive = neighbour ? neighbour.path : null;
      }
      return {
        ...s,
        editorTabs: nextTabs,
        activeEditorPath: nextActive,
        editorFullWidth: nextActive == null ? false : s.editorFullWidth,
        ...(nextActive ? { panelFocusTabId: 'editor:' + nextActive, panelFocusSeq: s.panelFocusSeq + 1 } : {}),
      };
    });
  }, [updateLocalState]);

  // Update a tab's saved baseline + dirty after a successful write.
  const setEditorSaved = useCallback((sid: string, path: string, content: string, newPath?: string) => {
    delete liveBuffersRef.current[liveBufKey(sid, path)];
    updateLocalState(sid, s => ({
      ...s,
      editorTabs: s.editorTabs.map(t => t.path === path
        ? { ...t, path: newPath ?? t.path, content, dirty: false, preview: false, deleted: false }
        : t),
      activeEditorPath: s.activeEditorPath === path ? (newPath ?? path) : s.activeEditorPath,
    }));
  }, [updateLocalState]);

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
            if (s.status === 'archived') continue;
            if (subscribedRef.current.has(s.id)) continue;
            subscribedRef.current.add(s.id);
            toSubscribe.push(s.id);
            c.subscribe(s.id);
            // No auto-resume here: persisted sessions are shown immediately
            // but their Claude process is only booted when the user focuses
            // the tab (`notifyActiveTab` below) or sends a message. The
            // server handles the dedupe + lazy spawn.
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
            const openList = list.filter(s => s.status === 'open');
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
                // Pasted-but-unsent screenshots and queued messages are UI-only
                // (the server doesn't track them), so the `...state` spread would
                // otherwise wipe them whenever a session_state lands between paste
                // and send — which is exactly what happens on a fresh session's
                // first message as the provider boots.
                pastedImages: existing?.pastedImages ?? [],
                pendingMessages: existing?.pendingMessages ?? [],
                editorTabs: existing?.editorTabs ?? [],
                activeEditorPath: existing?.activeEditorPath ?? null,
                panelFocusTabId: existing?.panelFocusTabId ?? null,
                panelFocusSeq: existing?.panelFocusSeq ?? 0,
                contextTokens: existing?.contextTokens ?? 0,
                reviewComments: existing?.reviewComments ?? {},
                openMockup: existing?.openMockup ?? null,
                lastMockup: existing?.lastMockup ?? null,
                mockupComments: existing?.mockupComments ?? {},
                mockupInspect: false,
                browsers: existing?.browsers ?? {},
                activeBrowserName: existing?.activeBrowserName ?? null,
                browserComments: existing?.browserComments ?? {},
                browserInspect: existing?.browserInspect ?? {},
                openPlan: existing?.openPlan ?? null,
                lastPlan: existing?.lastPlan ?? null,
                planComments: existing?.planComments ?? [],
                planRequestId: existing?.planRequestId ?? null,
              },
            };
          });
          // Live terminals are fetched separately as a first-class resource
          // (client.fetchTerminals → onTerminalsSnapshot) as soon as we
          // subscribe — they're no longer reconstructed as chat messages.
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
              // Keep any text/thinking that streamed before the turn died instead
              // of discarding it along with the "thinking" preview.
              return { ...prev, [sid]: { ...s, isStreaming: false, messages: [...s.messages, ...carriedStreamMessages(s)], partialText: '', partialThinking: '', wasInterrupted: true } };
            });
          }
        },

        // Live bytes stream straight into the xterm via the per-procId
        // subscription in ClaudeClient (see InteractiveTerminalBubble). This
        // global callback is intentionally a no-op — terminals are no longer
        // chat messages, so there's nothing to append here.
        onTerminalData: () => {},

        onTerminalsSnapshot: (sid, list) => {
          setTerminals(prev => ({ ...prev, [sid]: list }));
        },

        onTerminalCreated: (sid, terminal) => {
          setTerminals(prev => {
            const arr = prev[sid] || [];
            if (arr.some(t => t.procId === terminal.procId)) return prev;
            return { ...prev, [sid]: [...arr, terminal] };
          });
          // Auto-focus the freshly created terminal and open the dock, so a
          // user's `/terminal` (or an agent's spawn_terminal) surfaces right
          // away. Runs on the broadcast — never optimistically.
          setActiveShellBySession(prev => ({ ...prev, [sid]: terminal.procId }));
          setMinimizedShells(prev => { if (!prev.has(terminal.procId)) return prev; const n = new Set(prev); n.delete(terminal.procId); return n; });
          if (sid === activeIdRef.current) setTerminalsPanelExpanded(true);
        },

        onTerminalRemoved: (sid, procId) => {
          setTerminals(prev => {
            const arr = prev[sid];
            if (!arr) return prev;
            return { ...prev, [sid]: arr.filter(t => t.procId !== procId) };
          });
          setActiveShellBySession(prev => (prev[sid] === procId ? (() => { const { [sid]: _drop, ...rest } = prev; return rest; })() : prev));
        },

        onTerminalExit: (sid, procId, code) => {
          setTerminals(prev => {
            const arr = prev[sid];
            if (!arr) return prev;
            return { ...prev, [sid]: arr.map(t => t.procId === procId ? { ...t, exitCode: code } : t) };
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
          // Opens as a preview tab, coexisting with any other open resources.
          openFileInEditor(sid, file.path, file.content, line ?? undefined);
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
            openTerminalId: null,
            diffView: null,
            // Resources coexist as tabs now: editor/browser tabs stay open.
          }));
        },

        // Server-initiated "open browser preview" — triggered by the
        // `browser_open` SDK tool. `name` selects/creates a named tab
        // within the session's browsers map; multiple can co-exist.
        // `openSeq` bumps per-name on every broadcast so the panel's
        // open-effect re-fires even for retry-after-error on the same URL.
        onOpenBrowser: (sid, name, url, title, cookieJar) => {
          if (!name || !url) return;
          const t = title || name;
          const jar = cookieJar || 'default';
          // The browser opens as its own panel tab and coexists with any
          // file/mockup/terminal tabs already open — we only bump the focus
          // seq so the workspace reveals (activates) this browser's tab.
          updateLocalState(sid, s => ({
            ...s,
            browsers: {
              ...s.browsers,
              [name]: { url, title: t, openSeq: Date.now(), cookieJar: jar },
            },
            activeBrowserName: name,
            panelFocusTabId: 'browser:' + name,
            panelFocusSeq: s.panelFocusSeq + 1,
          }));
        },

        // Server-initiated "focus this preview" — emitted by action-style
        // browser_* SDK tools (click/hover/type/…) when the auto-focus
        // setting resolves true. Only act if the preview is open in this
        // session; never re-open a closed tab from this hint. Also clears
        // competing side panels so the user actually sees the browser
        // when the action lands.
        onFocusBrowser: (sid, name) => {
          if (!name) return;
          updateLocalState(sid, s => {
            if (!s.browsers[name]) return s;
            return {
              ...s,
              activeBrowserName: name,
              panelFocusTabId: 'browser:' + name,
              panelFocusSeq: s.panelFocusSeq + 1,
            };
          });
        },

        // Server-initiated close for a specific named preview. The other
        // tabs in this session keep running. If the closed one was active,
        // fall back to whatever's still open (or `null` to hide the panel).
        onCloseBrowser: (sid, name) => {
          if (!name) return;
          updateLocalState(sid, s => {
            if (!s.browsers[name]) return s;
            const { [name]: _gone, ...rest } = s.browsers;
            const remaining = Object.keys(rest);
            const nextActive = s.activeBrowserName === name
              ? (remaining[0] ?? null)
              : s.activeBrowserName;
            const { [name]: _gi, ...nextInspect } = s.browserInspect;
            return { ...s, browsers: rest, activeBrowserName: nextActive, browserInspect: nextInspect };
          });
        },

        // Bridge → Electron CDP request forwarding (browser_snapshot,
        // browser_click, etc.). The handler routes to `cdp_*` IPC and
        // replies via `client.respondBrowserRequest`. Non-Electron viewers
        // (browser, mobile PWA) have no `window.codiby` bridge and
        // return an explicit error so the bridge surfaces it to the model.
        // The handler reads `name` off the request payload and builds the
        // correct OS-level webview label internally.
        onBrowserRequest: handleBrowserCdpRequest(
          (sid, requestId, payload) => c.respondBrowserRequest(sid, requestId, payload),
        ),

        // Initial-load + server-pushed preferences. Sent as the first WS
        // message on connect (so tabOrder/groups are populated before the
        // sessions list arrives) and again whenever a server-side mutation
        // broadcasts an update (e.g. MCP tools creating a group or moving
        // sessions between groups). Session visibility (open/archived)
        // lives on each session, not in preferences.
        onKeybindings: (overrides) => setKbOverrides(overrides || {}),
        onPreferences: (prefs) => {
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
          if (typeof prefs.autoFocusBrowserOnAction === 'boolean') {
            setAutoFocusBrowserOnAction(prefs.autoFocusBrowserOnAction);
          }
          if (typeof prefs.showTelegramSession === 'boolean') {
            setShowTelegramSession(prefs.showTelegramSession);
          }
          if (typeof prefs.interruptOnSend === 'boolean') {
            setInterruptOnSend(prefs.interruptOnSend);
          }
          if (typeof prefs.colorChatBySession === 'boolean') {
            setColorChatBySession(prefs.colorChatBySession);
          }
          if (typeof prefs.tintChatBackground === 'boolean') {
            setTintChatBackground(prefs.tintChatBackground);
          }
          if (prefs.sessionAccents && typeof prefs.sessionAccents === 'object') {
            setSessionAccents(prefs.sessionAccents as Record<string, string>);
          }
          if (Array.isArray(prefs.globalEnvVars)) {
            setGlobalEnvVars(prefs.globalEnvVars as ProjectEnvVar[]);
          }
          if (prefs.shellRenames && typeof prefs.shellRenames === 'object') {
            setShellRenames(prefs.shellRenames as Record<string, Record<string, string>>);
          }
          if (typeof prefs.portlessTld === 'string' && prefs.portlessTld.trim()) {
            setPortlessTld(prefs.portlessTld.trim());
          }
          if (typeof prefs.terminalsPanelHeight === 'number') {
            const h = prefs.terminalsPanelHeight;
            if (h > 80 && h < 4000) setTerminalsPanelHeight(h);
          }
        },

        onRemoteStatus: (remoteId, status, lastError) => {
          setRemoteStatuses(prev => ({ ...prev, [remoteId]: { status, lastError } }));
        },

        // External trigger (e.g. the `codiby` CLI) wants the UI to switch
        // to a specific session. Reopen it if it was archived so the tab
        // is actually visible before we activate it. The server
        // broadcasts the updated session list, which flips our derived
        // archived/open sets.
        onFocusSession: (sid) => {
          if (archivedIdsRef.current.has(sid)) {
            clientRef.current?.unarchiveSession(sid).catch(() => {});
          }
          setActiveId(sid);
        },

        // Server broadcasts this after an in-place /clear (no archive, no
        // rename). Reset local message state so the chat renders empty.
        onSessionCleared: (sid) => {
          setSessionStates(prev => {
            if (!prev[sid]) return prev;
            const next = { ...prev };
            next[sid] = { ...emptyLocalState(), input: prev[sid]!.input };
            return next;
          });
        },

        onWelcome: () => {},

        onPortlessStatus: (status) => {
          // Re-emit on a window event so any open Project Settings pane and
          // the action toast component can react without ChatApp owning a
          // dedicated piece of state. Lightweight pub/sub.
          window.dispatchEvent(new CustomEvent('portless_status', { detail: status }));
        },
        onPortlessFired: (info) => {
          window.dispatchEvent(new CustomEvent('portless_fired', { detail: info }));
        },
        onPortlessUrlResolved: (info) => {
          window.dispatchEvent(new CustomEvent('portless_url_resolved', { detail: info }));
        },
        onTerminalEnvInjected: ({ procId, env }) => {
          setInjectedEnvByProc(prev => ({ ...prev, [procId]: env }));
        },
        onFileChanges: (sid, changes) => {
          // Re-emit on a window event so any interested pane (file tree,
          // activity indicator, …) can react without ChatApp owning a
          // dedicated piece of state. Mirrors the portless_status pattern.
          window.dispatchEvent(new CustomEvent('file_changes', { detail: { sessionId: sid, changes } }));
        },
        onBranchChanged: (sid, branch) => {
          window.dispatchEvent(new CustomEvent('branch_changed', { detail: { sessionId: sid, branch } }));
        },
        onSessionActivity: (sid, activity) => {
          setSessionActivity(prev => {
            // Drop fully-idle sessions from the map so the badges disappear and
            // the object stays small.
            if (activity.childProcessCount === 0 && activity.listeningPorts.length === 0) {
              if (!prev[sid]) return prev;
              const next = { ...prev };
              delete next[sid];
              return next;
            }
            return { ...prev, [sid]: activity };
          });
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

  // Stop a session's Claude process without removing it from the sidebar — it
  // becomes "not running" and can be resumed later. Optimistic.
  const handleStopInstance = useCallback((id: string) => {
    clientRef.current?.stopSession(id).catch(() => {});
    setSessions(prev => prev.map(s => s.id === id ? { ...s, runtime_status: 'stopped' } : s));
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

  // Reopen a mockup from its chat bubble's "Open in preview" bar. The bubble
  // can't reach the per-session state, so it fires this event; we route it to
  // the active session (the only one whose chat is visible).
  useEffect(() => {
    const handler = (e: Event) => {
      const ev = e as CustomEvent<{ name: string; html: string }>;
      if (!activeId || !ev.detail?.name || ev.detail.html == null) return;
      const { name, html } = ev.detail;
      updateLocalState(activeId, s => ({
        ...s,
        openMockup: { name, html },
        lastMockup: { name, html },
        openTerminalId: null,
        diffView: null,
      }));
    };
    window.addEventListener('codiby-code:open-mockup', handler as EventListener);
    return () => window.removeEventListener('codiby-code:open-mockup', handler as EventListener);
  }, [activeId, updateLocalState]);

  // A saved-snippet badge in the chat was clicked (dispatched from Markdown.tsx).
  // Read the file and open it read-only in the preview pane of the active session.
  useEffect(() => {
    const handler = async (e: Event) => {
      const ev = e as CustomEvent<{ path: string }>;
      const path = ev.detail?.path;
      if (!activeId || !path || !clientRef.current) return;
      const file = await clientRef.current.readFile(path);
      if (file) openFileInEditor(activeId, path, file.content, undefined, { readOnly: true, pin: true });
    };
    window.addEventListener('codiby-code:open-file', handler as EventListener);
    return () => window.removeEventListener('codiby-code:open-file', handler as EventListener);
  }, [activeId, openFileInEditor]);

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
  // Last scroll offset, mirrored on every scroll so we can re-apply it after
  // the chat pane remounts (e.g. when a right-panel tab opens/closes).
  const lastScrollTopRef = useRef(0);
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
    lastScrollTopRef.current = el.scrollTop;
    stickToBottomRef.current = distanceFromBottom < 80;
    setShowScrollDown(distanceFromBottom > 200);
  }, []);

  // Callback ref for the active session's scroll container. The PanelsWorkspace
  // engine remounts this subtree whenever a right-panel tab opens/closes (the
  // layout tree flips between a single panel and a split), which would reset
  // the scroll to the top. Restoring here — at attach time, after children are
  // committed so scrollHeight is valid — survives those remounts: snap to the
  // latest message if the user was pinned to the bottom, else re-apply their
  // last offset. useCallback keeps the ref stable so it only fires on real
  // (un)mounts, not every render.
  const attachScrollRef = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node;
    if (!node) return;
    node.scrollTop = stickToBottomRef.current ? node.scrollHeight : lastScrollTopRef.current;
  }, []);

  const handleOpenTerminal = useCallback((id: string) => {
    const sid = activeId;
    if (sid) updateLocalState(sid, s => ({ ...s, openTerminalId: id, diffView: null }));
  }, [activeId, updateLocalState]);

  // Tell the bridge which tab is active so it can lazily boot that session's
  // Claude process if it hasn't been resumed yet. Idempotent — the server
  // ignores the message when the provider is already running.
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
  const { openMockup, openPlan, diffView, editorFullWidth, reviewComments, reviewMode, reviewFiles, reviewIndex, todos, input } = active;
  // Each open file is its own editor panel tab. `openFile`/`editorDirty` are
  // derived from the *active* editor tab so the LSP/debugger/save/line-jump
  // code that reads them keeps working transparently (it always sees the
  // visible file). `content` is the saved baseline; live edits live in Monaco
  // + `liveBuffersRef`.
  const activeEditorTab = active.activeEditorPath
    ? active.editorTabs.find(t => t.path === active.activeEditorPath) ?? null
    : null;
  const openFile = activeEditorTab
    ? { path: activeEditorTab.path, content: activeEditorTab.content, line: activeEditorTab.line, column: activeEditorTab.column, readOnly: activeEditorTab.readOnly ?? false }
    : null;
  const editorDirty = activeEditorTab?.dirty ?? false;
  const anyEditorOpen = active.editorTabs.length > 0;
  const openTerminal = active.openTerminalId ? active.messages.find(m => m.id === active.openTerminalId && m.isTerminal) || null : null;
  // Derived browser-panel state: a tab is "shown" only when there's an active
  // name AND that name still has an entry. Each open browser is its own panel
  // tab, so the right panel exists when ANY browser is open.
  const browserOpen = !!active.activeBrowserName && !!active.browsers[active.activeBrowserName];
  const activeBrowser = browserOpen ? active.browsers[active.activeBrowserName as string] : null;
  const anyBrowserOpen = Object.keys(active.browsers).length > 0;
  // Unified reveal request handed to the PanelsWorkspace: switch its active tab
  // to whatever was last opened/focused (editor or browser) whenever
  // `panelFocusSeq` bumps, so re-opening an already-open tab still surfaces it.
  const panelFocusReq = active.panelFocusTabId
    ? { tabId: active.panelFocusTabId, nonce: active.panelFocusSeq }
    : null;
  const hasRightPanel = anyEditorOpen || !!openMockup || anyBrowserOpen || !!openPlan || !!openTerminal || !!diffView || pluginDetailOpen || !!openPR;
  // While the inline GroupComposer is mounted (a group is focused but no
  // session inside it is selected) the main pane belongs to the composer, so
  // the per-session PanelsWorkspace must NOT render — otherwise the browser's
  // native BrowserView / mockup iframe floats over the composer. Gating the
  // workspace render here also unmounts BrowserPanel, which hides the view.
  const rightPanelVisible = hasRightPanel && !selectedGroupId;

  // Tear down a browser preview completely: destroy the BrowserView and drop
  // its panel tab + per-name inspect/comment state. If the closed browser was
  // the focused one, fall back to whichever browser is still open (or null).
  const closeBrowserFully = useCallback((sid: string, name: string) => {
    tryInvokeNative('close_browser_preview', { label: browserLabelFor(sid, name) });
    updateLocalState(sid, s => {
      const { [name]: _alive, ...restBrowsers } = s.browsers;
      const { [name]: _ins, ...restInspect } = s.browserInspect;
      const { [name]: _cmt, ...restComments } = s.browserComments;
      const remaining = Object.keys(restBrowsers);
      const nextActive = s.activeBrowserName === name
        ? (remaining[0] ?? null)
        : s.activeBrowserName;
      return {
        ...s,
        browsers: restBrowsers,
        browserInspect: restInspect,
        browserComments: restComments,
        activeBrowserName: nextActive,
        editorFullWidth: nextActive == null ? false : s.editorFullWidth,
      };
    });
  }, [updateLocalState]);

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

  // Prime the global Claude model cache from the bridge on connect. The
  // live `supported_models` WS message keeps the per-session lists fresh;
  // this seed covers pickers that render before any session is alive
  // (project settings, the new-session modal).
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    client.getClaudeInfo()
      .then(info => { if (!cancelled) setClaudeModels(info.models || []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [client]);

  // The same WS message that updates per-session state also reflects the
  // latest SDK snapshot. Mirror it into the shared list so modals refresh
  // without an extra HTTP round-trip.
  useEffect(() => {
    if (!activeId) return;
    const list = sessionStates[activeId]?.supportedModels;
    if (!list || list.length === 0) return;
    setClaudeModels(prev => {
      if (prev.length === list.length && prev.every((m, i) => m.id === list[i].id && m.label === list[i].label)) return prev;
      return list;
    });
  }, [activeId, sessionStates]);

  // Jump to line/column when they change (clicking search results, or a
  // go-to-definition landing in the already-active file).
  useEffect(() => {
    if (openFile?.line && editorRef.current) {
      const line = openFile.line;
      const column = openFile.column ?? 1;
      editorRef.current.revealPositionInCenter({ lineNumber: line, column });
      editorRef.current.setPosition({ lineNumber: line, column });
      editorRef.current.focus();
    }
  }, [openFile?.line, openFile?.column, openFile?.path]);

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
      openMockup: null,
      openTerminalId: null,
      diffView: null,
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
      if (activeId) {
        const sid = activeId;
        // Refresh on-disk content for every open editor tab, but never clobber
        // a tab with unsaved edits.
        for (const tab of active.editorTabs) {
          if (tab.dirty) continue;
          const curPath = tab.path;
          const curContent = tab.content;
          client.readFile(curPath).then(file => {
            if (file && file.content !== curContent) {
              updateLocalState(sid, s => ({
                ...s,
                editorTabs: s.editorTabs.map(x => x.path === curPath && !x.dirty ? { ...x, content: file.content } : x),
              }));
            }
          }).catch(() => {});
        }
      }
      refreshGitModified();
    }, 1000);
    return () => clearTimeout(t);
  }, [active.messages.length]);

  // Live editor sync, driven by the session file watcher (real-time, disk-truth):
  //   • change → reload on-disk content into an open, non-dirty tab for that file
  //   • unlink → strike through the tab (mark deleted) but KEEP the buffer so the
  //              user can re-save (Cmd+S) to resurrect the file
  //   • add    → a previously-deleted open tab reappeared on disk: clear the
  //              strike and reload its content
  // Unsaved edits are never clobbered (a dirty tab is left alone until saved).
  useEffect(() => {
    const sid = activeId;
    if (!sid) return;

    // Push fresh on-disk content into a tab. If it's the visible editor, update
    // the live Monaco model in place (preserving cursor) so the change shows
    // immediately — Monaco is uncontrolled, so state alone wouldn't repaint it.
    const reload = (abs: string) => {
      const client = clientRef.current;
      if (!client) return;
      client.readFile(abs).then(file => {
        if (!file) return;
        delete liveBuffersRef.current[liveBufKey(sid, abs)];
        if (activeEditorPathRef.current === abs && editorRef.current) {
          const ed = editorRef.current;
          const model = ed.getModel();
          if (model && model.getValue() !== file.content) {
            const pos = ed.getPosition();
            externalEditRef.current = true;
            try { model.setValue(file.content); } finally { externalEditRef.current = false; }
            if (pos) ed.setPosition(pos);
          }
        }
        updateLocalState(sid, s => ({
          ...s,
          editorTabs: s.editorTabs.map(t => t.path === abs
            ? { ...t, content: file.content, dirty: false, deleted: false }
            : t),
        }));
      }).catch(() => {});
    };

    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionId: string; changes: FileChange[] }>).detail;
      if (!detail || detail.sessionId !== sid) return;
      const root = explorerRootRef.current;
      if (!root) return;
      const tabs = editorTabsRef.current;
      for (const c of detail.changes) {
        if (c.isDir) continue;
        const abs = root.endsWith('/') ? root + c.path : root + '/' + c.path;
        const tab = tabs.find(t => t.path === abs);
        if (!tab) continue;
        if (c.kind === 'unlink') {
          updateLocalState(sid, s => ({
            ...s,
            editorTabs: s.editorTabs.map(t => t.path === abs ? { ...t, deleted: true } : t),
          }));
        } else if (c.kind === 'add' || c.kind === 'change') {
          // Reload when the file reappeared (was struck through) or when it
          // changed and the tab has no unsaved edits. Leave dirty tabs alone.
          if (tab.deleted || !tab.dirty) reload(abs);
        }
      }
    };
    window.addEventListener('file_changes', handler);
    return () => window.removeEventListener('file_changes', handler);
  }, [activeId, updateLocalState]);

  // Restart-on-MCP-change: RestartSuggestionBanner (rendered at the app root)
  // asks us to restart a session — we own the connected client, so we run it
  // here and report the outcome back to the banner.
  useEffect(() => {
    const handler = (e: Event) => {
      const sid = (e as CustomEvent<{ sessionId: string | null }>).detail?.sessionId;
      const client = clientRef.current;
      const done = (ok: boolean, error?: string) =>
        window.dispatchEvent(new CustomEvent('session_restart_done', { detail: { sessionId: sid ?? null, ok, error } }));
      if (!sid || !client) { done(false, 'Sesión no disponible'); return; }
      client.restartSession(sid)
        .then(() => done(true))
        .catch(err => done(false, err instanceof Error ? err.message : 'No se pudo reiniciar'));
    };
    window.addEventListener('request_session_restart', handler);
    return () => window.removeEventListener('request_session_restart', handler);
  }, []);

  const handleNewSession = () => {
    setSelectedGroupId(null);
    setShowNewSession(true);
  };

  const handleToggleAutoGroup = (next: boolean) => {
    setAutoGroupSessions(next);
    persistPrefs({ autoGroupSessions: next });
  };

  const handleToggleAutoFocusBrowserOnAction = (next: boolean) => {
    setAutoFocusBrowserOnAction(next);
    persistPrefs({ autoFocusBrowserOnAction: next });
  };

  const handleToggleInterruptOnSend = (next: boolean) => {
    setInterruptOnSend(next);
    persistPrefs({ interruptOnSend: next });
  };

  const handleToggleColorChatBySession = (next: boolean) => {
    setColorChatBySession(next);
    persistPrefs({ colorChatBySession: next });
  };

  const handleToggleTintChatBackground = (next: boolean) => {
    setTintChatBackground(next);
    persistPrefs({ tintChatBackground: next });
  };

  const handleCreateSession = async (cwd: string, provider?: string, remoteId?: string | null) => {
    const c = clientRef.current;
    if (!c) return;
    try {
      const session = await c.createSession(cwd, { provider, remoteId });
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
    // Clicking a session tab takes focus away from any group composer.
    setActiveNavView('sessions');
    setSelectedGroupId(null);
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
    if (session.runtime_status === 'stopped' && (!status || status === 'disconnected')) {
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

  /** Locally flip a session's status in the in-memory list — used to give
   *  the UI an immediate response while the PATCH request to the server
   *  is in flight. The authoritative update arrives via the broadcast
   *  session list right after. We also bump updated_at so the just-
   *  archived session jumps to the top of the restore dropdown right
   *  away instead of waiting for the server roundtrip. */
  const setSessionStatusLocal = (id: string, status: 'open' | 'archived') => {
    const now = Date.now();
    setSessions(prev => prev.map(s => s.id === id ? { ...s, status, updated_at: now } : s));
  };

  /** Hide a session from the tab bar (status=archived). Server persists
   *  it; the broadcast session list flips our derived archived set. */
  const handleArchiveSession = (id: string) => {
    setSessionStatusLocal(id, 'archived');
    clientRef.current?.archiveSession(id).catch(() => {});
  };

  const [closingSessionId, setClosingSessionId] = useState<string | null>(null);
  const [unsavedClosePrompt, setUnsavedClosePrompt] = useState(false);

  const closeTab = (id: string) => {
    clientRef.current?.unsubscribe(id);
    subscribedRef.current.delete(id);
    clientRef.current?.stopSession(id).catch(() => {});
    setSessionStates(prev => { const next = { ...prev }; delete next[id]; return next; });
    setSessionStatusLocal(id, 'archived');
    clientRef.current?.archiveSession(id).catch(() => {});
    if (activeId === id) {
      const openSessions = sessions.filter(s => s.id !== id && s.status === 'open');
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
    setSessionStatusLocal(id, 'open');
    clientRef.current?.unarchiveSession(id).catch(() => {});
    setActiveId(id);
    // Reconnect — note: this does NOT auto-spawn the provider; the server
    // boots it lazily when notifyActiveTab fires from the active-tab effect.
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
      const remaining = sessions.filter(s => s.id !== id && s.status === 'open');
      setActiveId(remaining.length > 0 ? remaining[0]!.id : null);
    }
    setSessionStates(prev => { const next = { ...prev }; delete next[id]; return next; });
    subscribedRef.current.delete(id);
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
   *  because handleCreateSession spawns a provider session with no resume id.
   *
   *  Special case: `main-session` (the Telegram bot's pseudo-tab) cannot be
   *  archived or replaced because the Telegram bridge holds the session id
   *  externally. Instead we ask the server to clear the chat history and
   *  reset the provider session id in place — the next inbound message
   *  starts a fresh Claude conversation under the same UI tab. */
  const clearSession = async (targetId: string) => {
    const c = clientRef.current;
    if (!c) return;
    const old = sessions.find(s => s.id === targetId);
    if (!old) return;

    if (targetId === 'main-session') {
      try {
        await c.clearSessionMessages(targetId);
        // Server broadcasts `session_cleared`; the onSessionCleared handler
        // empties the local state. The clear also stops the provider, but the
        // lazy-boot effect only fires when `activeId` changes — which it
        // doesn't on an in-place clear. Without this nudge the tab sits on
        // "Waiting for connection..." until the user switches tabs or sends a
        // message. Re-arm the lazy boot now so it reconnects immediately.
        c.notifyActiveTab(targetId);
      } catch (err) {
        console.error('[ChatApp] /clear main-session failed:', err);
      }
      return;
    }

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

    // Archive the previous session server-side (history kept, hidden from tabs).
    setSessionStatusLocal(targetId, 'archived');
    c.archiveSession(targetId).catch(() => {});

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
    // Re-run each command as a terminal resource — it shows up in the dock
    // once the `terminal_created` broadcast lands.
    for (const command of cmds) {
      void clientRef.current!.createTerminal(id, { command, cwd });
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

  // Per-session `codeBlock → badge` substitutions registered by the composer
  // when a large paste is offloaded to a file. Consumed (and cleared) on send.
  const snippetMapRef = useRef<Record<string, { block: string; badge: string }[]>>({});

  // Bring an offline session back to life so a just-staged message gets
  // flushed on reconnect — without the user having to switch tabs and back.
  // Resumes a stopped process; otherwise just (re)subscribes. Mirrors the
  // resume logic in handleSelectSession.
  const reviveSession = async (id: string) => {
    const c = clientRef.current;
    const session = sessions.find(s => s.id === id);
    if (!c || !session) return;
    try {
      if (session.runtime_status === 'stopped') {
        const updated = await c.resumeSession(id);
        setSessions(prev => prev.map(s => s.id === id ? updated : s));
        c.subscribe(updated.id);
        subscribedRef.current.add(updated.id);
        c.getSessionState(id);
      } else {
        c.subscribe(id);
        subscribedRef.current.add(id);
        c.getSessionState(id);
      }
    } catch (e) {
      console.error('[send] revive failed:', e);
    }
  };

  const handleSend = (sid: string | null = activeId) => {
    if (!sid || !clientRef.current) return;
    const state = getState(sid);
    let text = state.input.trim();
    // Swap any file-backed code blocks (large pastes) for their reference badge:
    // the composer shows the full block, but the agent receives the file path.
    const snippetMaps = snippetMapRef.current[sid];
    if (snippetMaps && snippetMaps.length) {
      for (const m of snippetMaps) text = text.split(m.block).join(m.badge);
      snippetMapRef.current[sid] = [];
    }
    const sessionPastedImages = state.pastedImages;
    if (!text && sessionPastedImages.length === 0) return;

    const session = sessions.find(s => s.id === sid);

    // Push to per-session input history
    if (text) {
      setSessionStates(prev => {
        const s = prev[sid] || emptyLocalState();
        const hist = [...s.inputHistory, text];
        if (hist.length > 100) hist.shift();
        return { ...prev, [sid]: { ...s, inputHistory: hist } };
      });
      // History refs are shared — they track navigation for whichever pane's
      // textarea last submitted, which is fine because nav is keyboard-driven
      // and only one textarea can be focused at a time.
      historyIdxRef.current = -1;
      historyDraftRef.current = '';
    }

    // Client-side `/clear`: archive the current chat under "Cleared: …" and
    // replace the active tab with a fresh session in the same slot. Never
    // sent to Claude. Lives above /terminal so a future SDK-side `/clear`
    // can't override it.
    if (text === '/clear') {
      setInputForSession(sid, '');
      clearSession(sid);
      return;
    }

    // Interactive PTY terminal: /terminal [initial cmd]   or   /t [initial cmd]
    // Client-side only — never sent to Claude. Creates a terminal resource via
    // the CRUD endpoint; the dock adds it when the `terminal_created` broadcast
    // arrives (see onTerminalCreated), never optimistically.
    const slashTermMatch = text.match(/^\/(terminal|t)(?:\s+([\s\S]*))?$/);
    if (slashTermMatch) {
      const initialCmd = slashTermMatch[2]?.trim() || '';
      const cwd = state.initInfo?.cwd || session?.cwd || '/';
      void clientRef.current?.createTerminal(sid, { command: initialCmd || undefined, cwd });
      setInputForSession(sid, '');
      return;
    }

    // Terminal command: > command  — same terminal-resource path as /terminal.
    if (text.startsWith('>')) {
      const command = text.slice(1).trim();
      if (!command) return;
      const cwd = state.initInfo?.cwd || session?.cwd || '/';
      void clientRef.current?.createTerminal(sid, { command, cwd });
      setInputForSession(sid, '');
      return;
    }

    const images = sessionPastedImages.length > 0 ? sessionPastedImages.map(({ media_type, data }) => ({ media_type, data })) : undefined;

    // If a permission/AskUserQuestion is pending, sending a new message means
    // the user wants to redirect — auto-deny the pending tool so the agent
    // unblocks and consumes the new message instead of staying parked.
    if (state.permRequest) {
      clientRef.current.respondToPermission(sid, state.permRequest.requestId, false);
      updateLocalState(sid, s => ({ ...s, permRequest: null }));
    }

    const effectiveText = text || ' ';

    // Session closed (remote bridge offline / runtime stopped): stage the
    // message locally with a "sending" loader instead of dropping it. The
    // flush effect ships it once the session reconnects; a timeout flips it to
    // "not delivered" with a Retry button if reconnection doesn't happen.
    const sessionStatus = statuses[sid] || 'disconnected';
    if (sessionStatus !== 'connected') {
      const msgId = crypto.randomUUID();
      const stagedMsg = {
        id: msgId,
        role: 'user' as const,
        content: effectiveText,
        timestamp: Date.now(),
        images: images?.map(img => ({ media_type: img.media_type, data: img.data })),
        deliveryStatus: 'sending' as const,
      };
      updateLocalState(sid, s => ({ ...s, messages: [...s.messages, stagedMsg] }));
      setInputForSession(sid, '');
      setPastedImagesForSession(sid, []);
      beginDelivery(sid, msgId);
      // Kick a resume/reconnect so the staged message ships on its own — a
      // stopped session would otherwise sit at "sending" until refocused.
      void reviveSession(sid);
      return;
    }

    const streamingNow = state.isStreaming;
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
      if (interruptOnSend) {
        // Barge-in mode: cancel the in-flight turn and stage this message
        // as the sole pending item. The drain effect fires on the
        // streaming→idle transition the interrupt causes, pops this entry,
        // and ships it. Any messages that were already queued get dropped
        // — "interrupt" implies discarding the rest of the lineup too.
        clientRef.current.interrupt(sid);
        updateLocalState(sid, s => ({
          ...s,
          isStreaming: false,
          // Preserve whatever streamed before the barge-in (committed ahead of
          // the new user message to keep the timeline order) — the incoming
          // `interrupted` status would otherwise wipe the live preview.
          messages: [...s.messages.filter(m => !m.isPending), ...carriedStreamMessages(s), pendingMsg],
          partialText: '',
          partialThinking: '',
          pendingMessages: [{ id: pendingId, text: effectiveText, images }],
        }));
      } else {
        // Queue mode: append behind any other pending messages.
        updateLocalState(sid, s => ({
          ...s,
          messages: [...s.messages, pendingMsg],
          pendingMessages: [
            ...s.pendingMessages,
            { id: pendingId, text: effectiveText, images },
          ],
        }));
      }
      setInputForSession(sid, '');
      setPastedImagesForSession(sid, []);
      return;
    }

    const userMsg = {
      id: crypto.randomUUID(),
      role: 'user' as const,
      content: effectiveText,
      timestamp: Date.now(),
      images: images?.map(img => ({ media_type: img.media_type, data: img.data })),
    };
    updateLocalState(sid, s => ({
      ...s,
      messages: [...s.messages, userMsg],
      isStreaming: true,
      wasInterrupted: false,
      partialText: '',
      partialThinking: '',
    }));
    setInputForSession(sid, '');
    setPastedImagesForSession(sid, []);
    clientRef.current.sendMessage(sid, effectiveText, images);
  };

  const handlePermission = (requestId: string, allow: boolean, updatedInput?: Record<string, unknown>) => {
    if (!activeId || !clientRef.current) return;
    clientRef.current.respondToPermission(activeId, requestId, allow, updatedInput);
    updateLocalState(activeId, s => ({ ...s, permRequest: null }));
  };

  const handleInterrupt = (sid: string | null = activeId) => {
    if (!sid || !clientRef.current) return;
    clientRef.current.interrupt(sid);
    updateLocalState(sid, s => ({
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

  // ── Offline message delivery ──────────────────────────────────────────────
  // Messages composed while a session is closed are staged with
  // `deliveryStatus: 'sending'`. We nudge the server to (re)establish the
  // session and arm a timeout that flips the bubble to 'failed' (Retry button)
  // if it doesn't reconnect in time. The flush effect below ships the message
  // once the session's status flips to 'connected'.
  const DELIVERY_TIMEOUT_MS = 20_000;
  const deliveryTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const beginDelivery = useCallback((sessionId: string, msgId: string) => {
    // Prompt the server to bring the (remote) session back up. `subscribe` is
    // idempotent and triggers tunnel acquire + a fresh status broadcast.
    clientRef.current?.subscribe(sessionId);
    const existing = deliveryTimersRef.current[msgId];
    if (existing) clearTimeout(existing);
    deliveryTimersRef.current[msgId] = setTimeout(() => {
      delete deliveryTimersRef.current[msgId];
      updateLocalState(sessionId, s => ({
        ...s,
        messages: s.messages.map(m =>
          m.id === msgId && m.deliveryStatus === 'sending'
            ? { ...m, deliveryStatus: 'failed' as const }
            : m
        ),
      }));
    }, DELIVERY_TIMEOUT_MS);
  }, [updateLocalState]);

  const retryDelivery = useCallback((sessionId: string, msgId: string) => {
    updateLocalState(sessionId, s => ({
      ...s,
      messages: s.messages.map(m =>
        m.id === msgId ? { ...m, deliveryStatus: 'sending' as const, timestamp: Date.now() } : m
      ),
    }));
    beginDelivery(sessionId, msgId);
  }, [updateLocalState, beginDelivery]);

  // Clear any armed delivery timers on unmount.
  useEffect(() => () => {
    for (const t of Object.values(deliveryTimersRef.current)) clearTimeout(t);
    deliveryTimersRef.current = {};
  }, []);

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

  // Flush staged offline messages once a session reconnects. We ship the
  // earliest `deliveryStatus: 'sending'` message when the session is connected
  // and idle; the next one flushes after that turn completes (status flips back
  // to connected with isStreaming false), so a backlog drains one turn at a
  // time. Also covers the Retry path, which re-marks a failed message as
  // 'sending' while already connected.
  useEffect(() => {
    const client = clientRef.current;
    if (!client) return;
    for (const [sid, state] of Object.entries(sessionStates)) {
      if (statuses[sid] !== 'connected' || state.isStreaming) continue;
      const next = state.messages.find(m => m.deliveryStatus === 'sending');
      if (!next) continue;
      const timer = deliveryTimersRef.current[next.id];
      if (timer) { clearTimeout(timer); delete deliveryTimersRef.current[next.id]; }
      updateLocalState(sid, s => ({
        ...s,
        messages: s.messages.map(m =>
          m.id === next.id ? { ...m, deliveryStatus: undefined, timestamp: Date.now() } : m
        ),
        isStreaming: true,
        wasInterrupted: false,
        partialText: '',
        partialThinking: '',
      }));
      client.sendMessage(sid, next.content, next.images);
    }
  }, [statuses, sessionStates, updateLocalState]);

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
    // Image files open in a dedicated preview tab rather than the text editor —
    // their bytes are binary and Monaco would only show garbage.
    if (IMAGE_EXTS.has((path.split('.').pop() || '').toLowerCase())) {
      const dataUrl = await client.readFileDataUrl(path);
      if (!dataUrl) return;
      const contentWidth = contentRef.current?.offsetWidth ?? 1200;
      if (contentWidth < 800) updateLocalState(activeId, s => ({ ...s, editorFullWidth: true }));
      openFileInEditor(activeId, path, dataUrl, undefined, { image: true, readOnly: true });
      return;
    }
    const file = await client.readFile(path);
    if (!file) return;
    // Opens as a preview tab. If the content area is too narrow for a split
    // view, open the editor fullscreen.
    const contentWidth = contentRef.current?.offsetWidth ?? 1200;
    if (contentWidth < 800) updateLocalState(activeId, s => ({ ...s, editorFullWidth: true }));
    openFileInEditor(activeId, file.path, file.content, line);
  };

  const handleFileDiff = async (path: string) => {
    if (!client || !activeId) return;
    // A changed image opens in the image preview tab — a text diff is
    // meaningless for binary, so show the current version visually instead.
    if (IMAGE_EXTS.has((path.split('.').pop() || '').toLowerCase())) { handleFileOpen(path); return; }
    const sid = activeId;
    const base = changesCompareRef.current === 'vs-main' ? baseBranchRef.current : null;
    const [file, original] = await Promise.all([
      client.readFile(path),
      client.readFileOriginal(path, base),
    ]);
    if (file) {
      updateLocalState(sid, s => ({ ...s, openTerminalId: null, diffView: { path, original, modified: file.content } }));
    }
  };

  const handleFileDiffFullView = async (path: string) => {
    if (!client || !activeId) return;
    if (IMAGE_EXTS.has((path.split('.').pop() || '').toLowerCase())) {
      handleFileOpen(path);
      updateLocalState(activeId, s => ({ ...s, editorFullWidth: !s.editorFullWidth }));
      return;
    }
    const sid = activeId;
    const base = changesCompareRef.current === 'vs-main' ? baseBranchRef.current : null;
    const [file, original] = await Promise.all([
      client.readFile(path),
      client.readFileOriginal(path, base),
    ]);
    if (file) {
      updateLocalState(sid, s => ({ ...s, openTerminalId: null, diffView: { path, original, modified: file.content }, editorFullWidth: !s.editorFullWidth }));
    }
  };

  const handleStartReview = () => {
    if (!activeId) return;
    const files = [...new Set([...gitModified.staged, ...gitModified.unstaged])].sort();
    if (files.length === 0) return;
    updateLocalState(activeId, s => ({ ...s, reviewMode: true, reviewFiles: files, reviewIndex: 0, editorFullWidth: true, openTerminalId: null }));
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
  // Mirrors the active session's open editor tabs so the file-watcher listener
  // (which runs outside render) can read the current set without re-subscribing.
  const editorTabsRef = useRef<LocalSessionState['editorTabs']>([]);
  const activeEditorPathRef = useRef<string | null>(null);
  // Set true while we push an external (on-disk) reload into Monaco so the
  // editor's onChange treats it as a disk update, not a user edit.
  const externalEditRef = useRef(false);

  const refreshGitModified = useCallback(async () => {
    const root = explorerRootRef.current;
    if (!client || !root) return;
    const base = changesCompareRef.current === 'vs-main' ? baseBranchRef.current : null;
    const entries = await client.getGitModified(root, base);
    const staged = new Set<string>();
    const unstaged = new Set<string>();
    const untracked = new Set<string>();
    const stats = new Map<string, { additions: number; deletions: number }>();
    for (const e of entries) {
      if (e.staged) staged.add(e.path);
      else unstaged.add(e.path);
      if (e.untracked) untracked.add(e.path);
      if (e.additions != null || e.deletions != null) {
        stats.set(e.path, { additions: e.additions ?? 0, deletions: e.deletions ?? 0 });
      }
    }
    const result = { staged, unstaged, untracked, stats };
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
    // Untitled files are born pinned + dirty (never a preview).
    openFileInEditor(activeId, name, '', undefined, { pin: true });
    markEditorDirty(activeId, name, true);
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
      // Rename the untitled tab (the active one) to the real path, or open it
      // fresh if for some reason it's no longer around.
      const oldPath = getState(activeId).activeEditorPath;
      if (oldPath) setEditorSaved(activeId, oldPath, saveAsPrompt.content, path);
      else openFileInEditor(activeId, path, saveAsPrompt.content, undefined, { pin: true });
      refreshGitModified();
    }
    setSaveAsPrompt(null);
    setSaveAsPath('');
  };

  const handleSaveFileWrapped = async () => {
    if (!openFile || !activeId) return;
    if (openFile.readOnly) return; // dependency / external file — view only
    // Untitled files need Save As
    if (openFile.path.startsWith('untitled-')) {
      const editor = editorRef.current;
      const content = editor?.getValue() || openFile.content;
      handleSaveAs(content);
      return;
    }
    // Normal save
    if (!clientRef.current) return;
    const editor = editorRef.current;
    if (!editor) return;
    const content = editor.getValue();
    const filePath = openFile.path;
    try {
      const ok = await clientRef.current.writeFile(filePath, content);
      if (ok) {
        setEditorSaved(activeId, filePath, content);
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
    const activeTab = s.activeEditorPath ? s.editorTabs.find(t => t.path === s.activeEditorPath) ?? null : null;
    if (activeTab) {
      if (activeTab.dirty) {
        setUnsavedClosePrompt(true);
        return;
      }
      closeEditor(activeId, activeTab.path);
    } else if (s.openTerminalId || s.diffView) {
      updateLocalState(activeId, st => ({ ...st, openTerminalId: null, diffView: null, editorFullWidth: false }));
    } else {
      handleCloseTab(activeId);
    }
  };

  // Spawn an anonymous interactive terminal in the dock for the active session
  // and focus it. Lifted to component scope (out of the terminals-dock render
  // closure) so the global keybinding handler can fire it too.
  const spawnNewTerminal = useCallback(() => {
    if (!activeId) return;
    const cwd = getState(activeId).initInfo?.cwd
      || sessions.find(s => s.id === activeId)?.cwd
      || '/';
    // Create a bare interactive shell via the CRUD endpoint. It appears in the
    // dock (auto-focused + expanded) when the `terminal_created` broadcast
    // lands — see onTerminalCreated.
    void clientRef.current?.createTerminal(activeId, { cwd });
    setTerminalsPanelExpanded(true);
  }, [activeId, sessions, getState]);
  const spawnNewTerminalRef = useRef(spawnNewTerminal);
  spawnNewTerminalRef.current = spawnNewTerminal;

  // Toggle the terminals dock and move keyboard focus with it: revealing the
  // panel focuses the terminal (the active shell's xterm self-focuses on mount;
  // we focus the dock host as a fallback when there are no shells yet), while
  // hiding it returns focus to the chat input. Drives the `toggle-terminals`
  // command + palette action so the keyboard never gets stranded on a panel
  // that just disappeared.
  const toggleTerminals = useCallback(() => {
    setTerminalsPanelExpanded(prev => {
      const next = !prev;
      if (next) {
        // The dock was unmounted while collapsed, so its xterm re-mounts and
        // attaches `.xterm-helper-textarea` a few frames after React renders the
        // expanded panel. Poll for it, then fall back to focusing the host (e.g.
        // when there are no shells yet) so the panel always takes focus.
        const host = termDockHost;
        if (host) {
          let tries = 0;
          const grab = () => {
            // Only the active shell is visible; the others sit under a
            // `display:none` wrapper (offsetParent === null) and can't be
            // focused, so pick the one that's actually laid out.
            const ta = Array.from(host.querySelectorAll<HTMLElement>('.xterm-helper-textarea'))
              .find(el => el.offsetParent !== null);
            if (ta) { ta.focus(); return; }
            if (tries++ < 30) requestAnimationFrame(grab);
            else host.focus();
          };
          requestAnimationFrame(grab);
        }
      } else {
        requestAnimationFrame(() => inputRef.current?.focus());
      }
      return next;
    });
  }, [termDockHost]);
  const toggleTerminalsRef = useRef(toggleTerminals);
  toggleTerminalsRef.current = toggleTerminals;

  const saveRef = useRef(handleSaveFileWrapped);
  saveRef.current = handleSaveFileWrapped;
  const newFileRef = useRef(handleNewFile);
  newFileRef.current = handleNewFile;
  const closePanelRef = useRef(handleCloseCurrentPanel);
  closePanelRef.current = handleCloseCurrentPanel;

  /** Build the list of open session ids the switcher cycles through, in
   *  the same top-to-bottom order the user sees in the sidebar — that means
   *  *group-clustered*: walking `tabOrder`, the first time we hit a session
   *  belonging to a group, we emit all of that group's members in their
   *  `tabOrder` positions; subsequent encounters with the same group are
   *  skipped. Ungrouped sessions are emitted in place. `main-session` is
   *  hoisted to the front to mirror `openSessions`.
   *
   *  Mirrors `TabBar.tsx`'s render loop (lines ~517–546) so Ctrl+Tab order
   *  matches what the user sees. Intentionally **not** MRU and **not**
   *  recency-sorted within a group — cycling through "recently edited"
   *  makes the selected slot move under the user's fingers between
   *  Ctrl+Tab presses, which is disorienting. Top-to-bottom is predictable. */
  const buildSwitcherIds = useCallback((): string[] => {
    const liveOpen = sessions.filter(s => s.status !== 'archived');
    const liveById = new Map(liveOpen.map(s => [s.id, s]));

    // Tab-order walk with main-session hoisted to front; anything live but
    // missing from tabOrder is appended at the end so it stays reachable.
    const walk: string[] = [];
    const seen = new Set<string>();
    const pushId = (id: string) => {
      if (liveById.has(id) && !seen.has(id)) { walk.push(id); seen.add(id); }
    };
    if (liveById.has('main-session')) pushId('main-session');
    tabOrder.forEach(pushId);
    liveOpen.forEach(s => pushId(s.id));

    // Group-cluster pass: emit each group's members together on first hit.
    const out: string[] = [];
    const emittedGroups = new Set<string>();
    for (const id of walk) {
      const gid = tabGroupMap[id];
      if (gid && tabGroups[gid]) {
        if (emittedGroups.has(gid)) continue;
        emittedGroups.add(gid);
        for (const m of walk) {
          if (tabGroupMap[m] === gid) out.push(m);
        }
      } else {
        out.push(id);
      }
    }
    return out;
  }, [sessions, tabOrder, tabGroupMap, tabGroups]);

  // ── Keybinding registry wiring ──────────────────────────────────────────
  // Resolve the user's overrides against the registry defaults, and expose the
  // result plus the command→action map through refs so the global keydown
  // listener mounts once and never re-binds when a shortcut changes.
  const kbBindings = useMemo(() => resolveBindings(kbOverrides), [kbOverrides]);
  const kbBindingsRef = useRef(kbBindings);
  kbBindingsRef.current = kbBindings;

  // Mirror the terminals-dock focus flag into a ref so the once-mounted global
  // keydown handler can gate condition-scoped commands (e.g. `new-terminal`,
  // which only fires while focus is inside the dock).
  const terminalsFocusedRef = useRef(terminalsFocused);
  terminalsFocusedRef.current = terminalsFocused;

  const commandHandlersRef = useRef<Record<string, () => void>>({});
  commandHandlersRef.current = {
    'command-palette': () => setShowPalette(p => !p),
    'toggle-explorer': () => setExplorerCollapsed(c => !c),
    'toggle-terminals': () => toggleTerminalsRef.current(),
    'new-terminal': () => spawnNewTerminalRef.current(),
    'focus-chat-input': () => inputRef.current?.focus(),
    'find-in-chat': () => setFindOpen(true),
    'search-files': () => { setSearchActive(true); setExplorerCollapsed(false); },
    'save-file': () => saveRef.current(),
    'new-file': () => newFileRef.current(),
    'close-tab': () => closePanelRef.current(),
    'new-session': () => setShowNewSession(true),
    'clear-chat': () => { if (activeId) clearSession(activeId); },
    'sidebar-files': () => requestSidebarTab('files'),
    'sidebar-changes': () => requestSidebarTab('changes'),
    'sidebar-toolsmcp': () => requestSidebarTab('toolsmcp'),
    'sidebar-processes': () => requestSidebarTab('processes'),
    'sidebar-prs': () => requestSidebarTab('prs'),
  };

  // Hydrate overrides from the bridge once a client is connected; live edits
  // (incl. from another window) arrive via the onKeybindings broadcast.
  useEffect(() => {
    clientRef.current?.getKeybindings().then(setKbOverrides).catch(() => {});
  }, [client]);

  // The editor sends the full override map; persist it and reflect it locally.
  const persistKeybindings = useCallback((next: KeybindingOverrides) => {
    setKbOverrides(next);
    clientRef.current?.updateKeybindings(next).catch(() => {});
  }, []);

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ctrl+Tab session switcher. Hold Ctrl, tap Tab to advance, release
      // to commit. We don't gate on `metaKey` here because Cmd+Tab is the
      // macOS app switcher and out of reach for the browser anyway —
      // Ctrl+Tab is the cross-platform shortcut for in-app tab cycling.
      if (e.key === 'Tab' && e.ctrlKey) {
        e.preventDefault();
        setSwitcher(prev => {
          // Opening for the first time: snapshot the tab-bar-ordered list.
          // Pre-select the neighbour of the currently-active session — next
          // on plain Ctrl+Tab, previous on Ctrl+Shift+Tab — so a single tap
          // + release advances by one slot, matching browser tab cycling.
          if (!prev.open) {
            const ids = buildSwitcherIds();
            if (ids.length < 2) return prev;
            const activeIdx = activeId ? ids.indexOf(activeId) : -1;
            const base = activeIdx === -1 ? 0 : activeIdx;
            const nextIdx = e.shiftKey
              ? (base - 1 + ids.length) % ids.length
              : (base + 1) % ids.length;
            return { open: true, idx: nextIdx, ids };
          }
          // Already open: cycle within the snapshot.
          const n = prev.ids.length;
          if (n === 0) return prev;
          const nextIdx = e.shiftKey
            ? (prev.idx - 1 + n) % n
            : (prev.idx + 1) % n;
          return { ...prev, idx: nextIdx };
        });
        return;
      }

      // Every other global shortcut resolves through the editable keybinding
      // registry (see src/lib/keybindings.ts). The Shift+Tab permission-mode
      // cycle keeps its own focus-gated handler below.
      const cmdId = matchCommand(e, kbBindingsRef.current, {
        terminalsFocused: terminalsFocusedRef.current,
      });
      if (cmdId) {
        const fn = commandHandlersRef.current[cmdId];
        if (fn) {
          e.preventDefault();
          fn();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [buildSwitcherIds]);

  // Ctrl-release commits the switcher selection — classic hold-to-show.
  // Esc cancels without switching. Both only matter while the switcher is
  // open, so we mount the listeners conditionally.
  useEffect(() => {
    if (!switcher.open) return;
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Control' || e.key === 'Meta') {
        const target = switcher.ids[switcher.idx];
        setSwitcher({ open: false, idx: 0, ids: [] });
        if (target && target !== activeId) handleSelectSession(target);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setSwitcher({ open: false, idx: 0, ids: [] });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const target = switcher.ids[switcher.idx];
        setSwitcher({ open: false, idx: 0, ids: [] });
        if (target && target !== activeId) handleSelectSession(target);
      }
    };
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('keydown', onKeyDown);
    };
    // handleSelectSession is stable for the relevant scope; including the
    // switcher state ensures we always commit the latest highlight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [switcher.open, switcher.idx, switcher.ids, activeId]);

  const activeStatus = activeId ? (statuses[activeId] || 'disconnected') : 'disconnected';
  const activeSession = sessions.find(s => s.id === activeId);

  // Keep the module-level "active remote" in sync so the client auto-injects
  // `?remoteId=` on session-agnostic endpoints (file browse, git, search…)
  // while a remote tab is focused. Done in the render body (not a useEffect)
  // because child effects — most notably FileExplorer's `listFiles` on
  // `rootPath` change — run BEFORE parent effects in React's commit phase.
  // If we waited for an effect, the first fetch after a tab change would
  // still see the previous tab's remoteId and hit the wrong filesystem.
  setActiveRemoteId(activeSession?.remoteId ?? null);

  // Bypass-mode warning gate. Switching a session to `bypassPermissions`
  // pops a confirmation modal the first time; the user can tick "don't show
  // again" to suppress it on future flips.
  const [pendingBypassSessionId, setPendingBypassSessionId] = useState<string | null>(null);
  // "Open Browser…" palette action — flipped to true to show the URL modal.
  // Replaces a `window.prompt` call that Chromium silently disables in
  // Electron (the action used to no-op when the user picked it).
  const [browserUrlModalOpen, setBrowserUrlModalOpen] = useState(false);

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

  // Ordered sessions for tab bar — anything with status === 'open'. The
  // Telegram bot's "main-session" pseudo-tab is pinned to the front when
  // visible, and hidden entirely when toggled off in Settings → Telegram
  // (it can't be closed from the regular UI, this is the only escape hatch).
  const orderedOpenSessions = useMemo(() => sessions
    .filter(s => s.status === 'open' && (showTelegramSession || s.id !== 'main-session'))
    .sort((a, b) => {
      if (a.id === 'main-session') return -1;
      if (b.id === 'main-session') return 1;
      const ai = tabOrder.indexOf(a.id);
      const bi = tabOrder.indexOf(b.id);
      return (ai === -1 ? Infinity : ai) - (bi === -1 ? Infinity : bi);
    }), [sessions, tabOrder, showTelegramSession]);

  /** Derive a remoteId/color/name for each tab group from its members. A
   *  group is "remote" only when every member sits on the same remote (mixed
   *  groups stay local — there's no sensible color to pick otherwise). The
   *  GroupComposer uses this to spawn new sessions on the right remote, and
   *  the sidebar / tab strip use it to tint the group header. */
  const groupRemoteInfo = useMemo(() => {
    const out: Record<string, { remoteId: string; remoteName: string | null; remoteColor: string | null }> = {};
    const byGroup = new Map<string, SessionInfo[]>();
    for (const s of sessions) {
      const gid = tabGroupMap[s.id];
      if (!gid) continue;
      let list = byGroup.get(gid);
      if (!list) { list = []; byGroup.set(gid, list); }
      list.push(s);
    }
    for (const [gid, members] of byGroup) {
      const ids = new Set(members.map(m => m.remoteId ?? null));
      if (ids.size !== 1) continue;
      const remoteId = [...ids][0];
      if (!remoteId) continue;
      const first = members.find(m => m.remoteId === remoteId);
      out[gid] = {
        remoteId,
        remoteName: first?.remoteName ?? null,
        remoteColor: first?.remoteColor ?? null,
      };
    }
    return out;
  }, [sessions, tabGroupMap]);

  // Sessions surfaced in the "+" dropdown's CLOSED section. Now backed by
  // the archived status — the legacy three-state model collapsed into
  // two, so "recently closed" and "archived" are the same list. The
  // most-recent-first sort lives further down (depends on
  // sessionLastMessageAt, which itself depends on sessionStates).
  const archivedSessions = useMemo(
    () => sessions.filter(s => s.status === 'archived'),
    [sessions],
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
      // Tool use / tool result messages DO count toward recency — a session
      // grinding through Read/Bash/Edit during a long agentic turn is the most
      // recently active one, and skipping its tool chatter used to freeze its
      // "last time" (and sink it in the order) until a final text reply landed.
      // Only pure UI bookkeeping (system notes: terminal/mockup spawn, etc.) is
      // ignored, since those aren't really the agent talking.
      let last = 0;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.role === 'system') continue;
        const t = m.timestamp;
        if (typeof t === 'number' && t > last) { last = t; break; }
      }
      // Take the max of the locally-derived last message and the server's
      // `updated_at` (bumped on every real message, including thinking). For a
      // session whose messages aren't loaded locally — a background tab, or one
      // mid-resubscribe where `messages` was momentarily reset — `last` is 0, so
      // relying on it alone would sink the session to `created_at` ("1d") and
      // then snap it back once messages reload. `updated_at` keeps it stable and
      // reflects activity even while it's only thinking.
      out[s.id] = Math.max(last, s.updated_at ?? 0, s.created_at ?? 0);
    }
    return out;
  }, [sessions, sessionStates]);

  // Per-session "where it left off" preview — the last real assistant/user
  // line (skipping system notes, tool calls and thinking), trimmed to a
  // single line. Feeds the Sessions overview board/list so each card recovers
  // its context without opening the session.
  const sessionLastPreview = useMemo(() => {
    const out: Record<string, string> = {};
    for (const s of sessions) {
      const msgs = sessionStates[s.id]?.messages || [];
      let preview = '';
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.role === 'system') continue;
        if (m.isToolResult || m.toolName) continue;
        if (m.isThinking) continue;
        const c = (m.content || '').trim();
        if (!c) continue;
        preview = c;
        break;
      }
      out[s.id] = preview.replace(/\s+/g, ' ').slice(0, 160);
    }
    return out;
  }, [sessions, sessionStates]);

  // Archived list shown in the TabBar's restore dropdown — sorted
  // most-recent first. We trust the server-stamped `updated_at` (bumped
  // on message/archive/rename) so a session you just closed jumps to
  // the top even though its in-memory state was cleared.
  const closedSessions = useMemo(
    () => archivedSessions
      .slice()
      .sort((a, b) => (b.updated_at ?? b.created_at ?? 0) - (a.updated_at ?? a.created_at ?? 0)),
    [archivedSessions],
  );

  const handleReorder = (fromId: string, toId: string) => {
    setTabOrder(prev => {
      // Ensure all open session IDs are in the order
      const openIds = sessions.filter(s => s.status === 'open').map(s => s.id);
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
  editorTabsRef.current = active.editorTabs;
  activeEditorPathRef.current = active.activeEditorPath;

  // A file is read-only when it lives outside the project (e.g. a TS lib
  // .d.ts) or inside any node_modules — we open dependency declarations for
  // navigation, not editing.
  const isExternalPath = useCallback((path: string) => {
    if (path.includes('/node_modules/')) return true;
    if (explorerRoot && !path.startsWith(explorerRoot)) return true;
    return false;
  }, [explorerRoot]);

  // Cross-file go-to-definition target. The backend (local or remote tunnel)
  // serves the file via readFile; externals open read-only. We reveal the
  // exact line/column the LSP pointed at (first result only).
  const navigateToDefinition = useCallback(async (rawPath: string, sel?: { startLineNumber?: number; startColumn?: number }) => {
    if (!clientRef.current || !activeId) return;
    const file = await clientRef.current.readFile(rawPath);
    if (!file) return;
    openFileInEditor(activeId, file.path, file.content, sel?.startLineNumber, {
      column: sel?.startColumn,
      readOnly: isExternalPath(file.path),
    });
  }, [activeId, isExternalPath, openFileInEditor]);

  // Stable handle so the (once-patched) Monaco editor service always calls the
  // latest navigate closure without re-patching on every editor mount.
  const navigateToDefinitionRef = useRef(navigateToDefinition);
  useEffect(() => { navigateToDefinitionRef.current = navigateToDefinition; }, [navigateToDefinition]);

  // Load git modified when root changes — instant from cache, then refresh
  useEffect(() => {
    if (explorerRoot) {
      const cached = gitModifiedCacheRef.current[explorerRoot];
      if (cached) setGitModified(cached);
      else setGitModified({ staged: new Set(), unstaged: new Set(), untracked: new Set(), stats: new Map() });
    } else {
      setGitModified({ staged: new Set(), unstaged: new Set(), untracked: new Set(), stats: new Map() });
    }
    refreshGitModified();
  }, [explorerRoot, refreshGitModified]);

  // Resolve the base branch for the "vs main" comparison, once per workspace.
  // Prefer the usual trunk names; fall back to the first local branch.
  useEffect(() => {
    if (!explorerRoot || !client) return;
    let cancelled = false;
    client.listBranches(explorerRoot).then(({ local, remote }) => {
      if (cancelled) return;
      const all = [...local, ...remote];
      const pick = ['main', 'master', 'develop', 'trunk'].find(b => all.includes(b));
      setBaseBranch(pick || local[0] || 'main');
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [explorerRoot, client]);

  // Re-fetch the changes list when the comparison mode or base branch changes.
  useEffect(() => { refreshGitModified(); }, [changesCompare, baseBranch, refreshGitModified]);

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

  // The server watcher pushes a branch_changed event when the active session's
  // repo switches branches (checkout from a terminal, an agent, or another
  // worktree). Update the status bar and re-read the changes list without
  // re-polling git on a timer.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionId: string; branch: string }>).detail;
      if (!detail || detail.sessionId !== activeId) return;
      setGitBranch(detail.branch || null);
      refreshGitModified();
    };
    window.addEventListener('branch_changed', handler);
    return () => window.removeEventListener('branch_changed', handler);
  }, [activeId, refreshGitModified]);

  // Client-side builtin slash commands (intercepted in handleSend, never sent to Claude).
  const BUILTIN_SLASH_COMMANDS = ['terminal', 't'];
  const sdkSlashCommands = active.initInfo?.slashCommands || [];
  const slashCommands = [...BUILTIN_SLASH_COMMANDS, ...sdkSlashCommands.filter((c: string) => !BUILTIN_SLASH_COMMANDS.includes(c))];
  const slash = useSlashCommands(input, slashCommands);
  const fileIndex = useFileIndex(client, explorerRoot);
  const fileMention = useFileMention(input, fileIndex);

  const paletteActions: PaletteAction[] = [
    { id: 'new-session', label: 'New Session', chord: kbBindings['new-session'] ?? undefined, section: 'Sessions', onRun: () => setShowNewSession(true) },
    { id: 'focus-input', label: 'Focus Chat Input', chord: kbBindings['focus-chat-input'] ?? undefined, section: 'Navigation', onRun: () => inputRef.current?.focus() },
    { id: 'toggle-explorer', label: explorerCollapsed ? 'Show File Explorer' : 'Hide File Explorer', chord: kbBindings['toggle-explorer'] ?? undefined, section: 'Navigation', onRun: () => setExplorerCollapsed(c => !c) },
    { id: 'toggle-terminals', label: terminalsPanelExpanded ? 'Collapse Terminals' : 'Expand Terminals', chord: kbBindings['toggle-terminals'] ?? undefined, section: 'Navigation', onRun: () => toggleTerminals() },
    { id: 'close-editor', label: 'Close Editor / Tab', chord: kbBindings['close-tab'] ?? undefined, section: 'Navigation', onRun: () => closePanelRef.current() },
    { id: 'new-file', label: 'New File', chord: kbBindings['new-file'] ?? undefined, section: 'Editor', onRun: handleNewFile },
    { id: 'save-file', label: 'Save File', chord: kbBindings['save-file'] ?? undefined, section: 'Editor', onRun: handleSaveFileWrapped },
    { id: 'clear-chat', label: 'Clear Chat', chord: kbBindings['clear-chat'] ?? undefined, section: 'Session', onRun: () => { if (activeId) clearSession(activeId); } },
    { id: 'keyboard-shortcuts', label: 'Keyboard Shortcuts', section: 'Navigation', onRun: () => setShowShortcuts(true) },
    { id: 'organize-tabs', label: 'Organize Tabs by Folder', section: 'Sessions', onRun: async () => {
      const c = clientRef.current;
      if (!c) return;
      const openSessions = sessions.filter(s => s.status === 'open');
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
    { id: 'command-palette', label: 'Command Palette', chord: kbBindings['command-palette'] ?? undefined, section: 'Navigation', onRun: () => {} },
    { id: 'open-browser', label: 'Open Browser…', section: 'Browser', onRun: () => {
      if (!activeId) return;
      // Defer the actual URL prompt to a React modal — `window.prompt` is
      // disabled by Chromium in Electron, so the historical inline `prompt()`
      // call was a silent dead end.
      setBrowserUrlModalOpen(true);
    } },
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

    // Cross-file go-to-definition. A standalone Monaco only knows about the one
    // model it has mounted, so when F12 / Cmd+Click resolves to another file
    // its editor service can't open it and returns null. We patch the service
    // (once — it's shared across editor instances): let Monaco handle same-file
    // jumps natively, and for a different file route the target through our tab
    // system instead. Uses the private _codeEditorService — the standard
    // standalone-Monaco escape hatch.
    const codeEditorService = (editor as unknown as { _codeEditorService?: any })._codeEditorService;
    if (codeEditorService && !codeEditorService.__taskrCrossFileNav) {
      const openCodeEditorBase = codeEditorService.openCodeEditor.bind(codeEditorService);
      codeEditorService.openCodeEditor = async (input: any, sourceEditor: any, sideBySide?: boolean) => {
        const handled = await openCodeEditorBase(input, sourceEditor, sideBySide);
        if (handled === null && input?.resource?.scheme === 'file') {
          // Different file — Monaco couldn't open it. `resource.path` is the
          // absolute fs path; `options.selection` is already 1-based Monaco
          // coords. Jump to the first definition (we ignore extra results).
          navigateToDefinitionRef.current(input.resource.path, input.options?.selection);
          return sourceEditor; // signal "handled" so Monaco doesn't warn
        }
        return handled;
      };
      codeEditorService.__taskrCrossFileNav = true;
    }

    // Jump to line/column if specified (search results, go-to-definition)
    if (openFile?.line) {
      const line = openFile.line;
      const column = openFile.column ?? 1;
      setTimeout(() => {
        editor.revealPositionInCenter({ lineNumber: line, column });
        editor.setPosition({ lineNumber: line, column });
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

  // Reconcile focus-mode workspaces with the host's open-sessions list: drop
  // sessions from workspaces once they close externally (and collapse their
  // panes), while preserving empty placeholder slots.
  //
  // We deliberately do NOT auto-assign open sessions to a workspace anymore —
  // workspaces start empty and the user picks which chats fill each slot. A
  // newly-opened chat therefore stays out of the grid until it's explicitly
  // assigned (via a slot picker or the title-bar "+chat" picker).
  useEffect(() => {
    const hostIds = new Set(orderedOpenSessions.map(s => s.id));
    setFocusWorkspaces(prev => {
      let changed = false;
      const cleaned = prev.map(w => {
        const validIds = w.sessionIds.filter(id => hostIds.has(id));
        const newLayout = reconcileWorkspaceLayout(w.layout, validIds);
        if (
          validIds.length === w.sessionIds.length &&
          sameLayout(newLayout, w.layout)
        ) return w;
        changed = true;
        return { ...w, sessionIds: validIds, layout: newLayout };
      });
      return changed ? cleaned : prev;
    });
  }, [orderedOpenSessions]);

  useEffect(() => {
    persistWorkspaces(focusWorkspaces, activeWorkspaceId);
  }, [focusWorkspaces, activeWorkspaceId]);

  const handleCloseWorkspace = useCallback((id: string) => {
    setFocusWorkspaces(prev => {
      if (prev.length <= 1) return prev;
      const next = prev.filter(w => w.id !== id);
      if (id === activeWorkspaceId) {
        setActiveWorkspaceId(next[0]!.id);
      }
      return next;
    });
  }, [activeWorkspaceId]);

  const handleRenameWorkspace = useCallback((id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setFocusWorkspaces(prev => prev.map(w => (w.id === id ? { ...w, name: trimmed } : w)));
  }, []);

  const handleReorderWorkspaces = useCallback((fromId: string, toId: string, position: 'above' | 'below') => {
    if (fromId === toId) return;
    setFocusWorkspaces(prev => {
      const fromIdx = prev.findIndex(w => w.id === fromId);
      if (fromIdx === -1) return prev;
      const moved = prev[fromIdx]!;
      const without = prev.filter((_, i) => i !== fromIdx);
      const toIdx = without.findIndex(w => w.id === toId);
      if (toIdx === -1) return prev;
      const insertAt = position === 'below' ? toIdx + 1 : toIdx;
      const next = [...without];
      next.splice(insertAt, 0, moved);
      return next;
    });
  }, []);

  // A stable accent color per session. Remote sessions keep their assigned
  // color; local ones get a deterministic hue from a palette so each chat has
  // a consistent identity across its focus-mode pane header and message cards.
  const getSessionAccent = useCallback((sid: string): string => {
    // 1. explicit per-session override
    const override = sessionAccents[sid];
    if (override) return override;
    // 2. inherit the session's group accent color, if grouped
    const gid = tabGroupMap[sid];
    const groupColor = gid ? tabGroups[gid]?.color : undefined;
    if (groupColor && GROUP_HEX_COLOR[groupColor]) return GROUP_HEX_COLOR[groupColor]!;
    // 3. remote color
    const s = sessions.find(x => x.id === sid);
    if (s?.remoteColor) return s.remoteColor;
    // 4. deterministic palette hue from the id
    let h = 0;
    for (let i = 0; i < sid.length; i++) h = (h * 31 + sid.charCodeAt(i)) >>> 0;
    return SESSION_ACCENT_PALETTE[h % SESSION_ACCENT_PALETTE.length]!;
  }, [sessions, sessionAccents, tabGroupMap, tabGroups]);

  /** Set (or clear, when color is null) a session's accent override. */
  const handlePickSessionAccent = useCallback((sid: string, color: string | null) => {
    setSessionAccents(prev => {
      const next = { ...prev };
      if (color) next[sid] = color; else delete next[sid];
      persistPrefs({ sessionAccents: next });
      return next;
    });
  }, []);

  // Render a composer for any given session. Used by both layouts: the
  // standard chat tree renders the active session's composer inline; the
  // focus-mode grid renders one per pane so the streaming/loader animation
  // is visible everywhere an agent is working.
  const renderComposer = (sid: string) => {
    const s = sessionStates[sid];
    if (!s) return null;
    const sess = sessions.find(x => x.id === sid);
    const status: ConnectionStatus = statuses[sid] || 'disconnected';
    const BUILTINS = ['terminal', 't'];
    const sdkCommands = s.initInfo?.slashCommands || [];
    const sessionSlashCommands = [
      ...BUILTINS,
      ...sdkCommands.filter((c: string) => !BUILTINS.includes(c)),
    ];
    return (
      <ChatComposer
        key={sid}
        sessionId={sid}
        autoFocus={sid === activeId}
        input={s.input}
        onChangeInput={(val) => setInputForSession(sid, val)}
        pastedImages={s.pastedImages}
        onChangePastedImages={(val) => setPastedImagesForSession(sid, val)}
        active={s}
        activeSession={sess ?? undefined}
        connectionStatus={status}
        opencodeInfo={opencodeInfo}
        claudeModels={claudeModels}
        slashCommands={sessionSlashCommands}
        client={client}
        cwd={s.initInfo?.cwd || sess?.cwd || null}
        onSend={() => handleSend(sid)}
        onRegisterSnippet={(block, badge) => { (snippetMapRef.current[sid] ||= []).push({ block, badge }); }}
        onInterrupt={() => handleInterrupt(sid)}
        onSelectModel={(modelId) => {
          if (!clientRef.current) return;
          const prevModel = sess?.model ?? null;
          if (prevModel === (modelId || null)) return;
          if (modelId) clientRef.current.setModel(sid, modelId);
          setSessions(prev => prev.map(x => x.id === sid ? { ...x, model: modelId || null } : x));
          // Log the switch inline so the chat reflects which model handled
          // which turns. Resolve a friendly label from the session's models
          // (falling back to the global list, then the raw id).
          const models = (s.supportedModels && s.supportedModels.length > 0) ? s.supportedModels : claudeModels;
          const label = modelId ? (models.find(m => m.id === modelId)?.label || modelId) : 'default';
          updateLocalState(sid, st => ({
            ...st,
            messages: [...st.messages, {
              id: crypto.randomUUID(),
              role: 'system' as const,
              content: `Modelo cambiado a ${label}`,
              timestamp: Date.now(),
            }],
          }));
        }}
        onSelectPermissionMode={(mode) => {
          if (!clientRef.current) return;
          requestPermissionMode(sid, mode);
        }}
        onFocus={() => { if (sid !== activeId) handleSelectSession(sid); }}
      />
    );
  };

  const composerNode = activeId ? renderComposer(activeId) : null;

  /**
   * Render the per-session chat scroll area (messages + streaming partials +
   * inline permission request). Used by both layouts: the standard view
   * mounts it once for the active session; focus mode mounts it per pane so
   * every session's history and live stream is visible at once.
   *
   * `scrollRef` / `permRequestRef` are global refs tied to the currently-
   * active session's auto-scroll behavior, so we only attach them when this
   * pane is the active one. Non-active panes still scroll naturally — they
   * just don't drive the global scroll-to-bottom indicator.
   */
  const renderChatBody = (sid: string, accent?: string): ReactNode => {
    const cs = getState(sid);
    const status: ConnectionStatus = statuses[sid] || 'disconnected';
    const isActiveSession = sid === activeId;
    return (
      <div
        ref={isActiveSession ? attachScrollRef : undefined}
        onScroll={isActiveSession ? handleMessagesScroll : undefined}
        style={accent && tintChatBackground ? { backgroundColor: `${accent}0d` } : undefined}
        className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 space-y-1"
      >
        {cs.messages.length === 0 && !cs.partialText && (
          <div className="flex items-center justify-center h-full">
            <p className="text-zinc-600 text-sm">
              {status === 'connecting' ? 'Connecting to Claude...' :
               status === 'connected' ? 'Send a message to start' :
               'Waiting for connection...'}
            </p>
          </div>
        )}
        {cs.messages.length > visibleMessageCount && (
          <button
            className="w-full py-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            onClick={() => setVisibleMessageCount(prev => prev + 200)}
          >
            Show {Math.min(200, cs.messages.length - visibleMessageCount)} older messages ({cs.messages.length - visibleMessageCount} hidden)
          </button>
        )}
        {(() => {
          const grouped = collapseToolRuns(groupMessages(
            [...cs.messages]
              .filter(m => {
                // Queued user messages render after the live thinking/text
                // preview (below), so the in-flight assistant turn they
                // interrupted stays above them in the timeline. Keeping them
                // in this list would float them above the live preview.
                if (m.isPending) return false;
                if (m.isTerminal && !m.isManagedTerminal) return false;
                // Terminals are a first-class resource rendered only in the
                // bottom Terminals dock — never inline in the chat stream.
                // (Old persisted history may still carry these flags.)
                if (m.isInteractiveTerminal) return false;
                return true;
              })
              .sort((a, b) => (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER))
              .slice(-visibleMessageCount)
          ));
          const activeAskId = cs.permRequest?.toolName === 'AskUserQuestion' ? cs.permRequest.requestId : null;
          return grouped.map((item, i) => {
            const isLast = i === grouped.length - 1;
            if ('agent' in item) {
              return <AgentBubble key={item.agent.id} agent={item.agent} children={item.children} onOpenTerminal={handleOpenTerminal} />;
            }
            if ('toolRun' in item) {
              const hasContentAfter = i < grouped.length - 1 || !!cs.partialText;
              return (
                <ToolRunBubble
                  key={item.items[0]!.id}
                  group={item}
                  onOpenTerminal={handleOpenTerminal}
                  sessionId={sid}
                  client={clientRef.current || undefined}
                  hasContentAfter={hasContentAfter}
                />
              );
            }
            const isAskTool = item.toolName === 'AskUserQuestion' && Array.isArray((item.toolInput as any)?.questions);
            const hasResult = !!(item as any).toolResult;
            const answerCb = isLast && isAskTool && !hasResult
              ? (answers: Record<string, string>) => {
                  if (activeAskId && item.id === activeAskId && cs.permRequest) {
                    handlePermission(cs.permRequest.requestId, true, { ...cs.permRequest.input, answers });
                    return;
                  }
                  if (!clientRef.current) return;
                  clientRef.current.respondToPermission(sid, item.id, true, { ...(item.toolInput as object), answers });
                  const lines = Object.entries(answers).map(([q, v]) => `- ${q} → ${v}`);
                  clientRef.current.sendMessage(sid, lines.join('\n'));
                }
              : undefined;
            return (
              <div key={item.id} id={`msg-${item.id}`}>
                <MessageBubble
                  message={item}
                  onOpenTerminal={handleOpenTerminal}
                  isLast={isLast}
                  onAnswerAskUser={answerCb}
                  sessionId={sid}
                  client={clientRef.current || undefined}
                  accent={accent}
                  interactiveMinimized={item.isInteractiveTerminal ? minimizedShells.has(item.id) : undefined}
                  onToggleInteractiveMinimize={item.isInteractiveTerminal ? toggleShellMinimized : undefined}
                  onCancelPending={(id) => removePendingMessage(sid, id)}
                  onRetry={(id) => retryDelivery(sid, id)}
                />
              </div>
            );
          });
        })()}
        {cs.partialThinking && (
          <div className="py-1">
            <div className="flex items-start gap-1.5 text-[12px] text-zinc-500">
              <Sparkles className="w-3 h-3 mt-1 shrink-0 opacity-70 text-violet-300/70 animate-pulse" />
              <span className="font-medium uppercase tracking-wide text-[10px] mt-[3px] shrink-0">
                Thinking
              </span>
            </div>
            <div className="mt-1 ml-5 pl-2.5 border-l border-zinc-800/80">
              <p className="text-[12px] italic text-zinc-400 leading-relaxed whitespace-pre-wrap break-words">
                {cs.partialThinking}
                <span className="inline-block ml-0.5 w-1.5 h-3 bg-zinc-500/70 align-middle animate-pulse" />
              </p>
            </div>
          </div>
        )}
        {cs.partialText && (
          <div className="py-1">
            <p className="text-[13px] text-zinc-300 whitespace-pre-wrap break-words leading-relaxed">
              {cs.partialText}
            </p>
          </div>
        )}
        {/* Queued user messages — rendered after the live preview so they sit
            below the in-flight assistant turn (thinking/text) they follow,
            preserving timeline order. */}
        {cs.messages.filter(m => m.isPending).map((m, idx, arr) => (
          <div key={m.id} id={`msg-${m.id}`}>
            <MessageBubble
              message={m}
              onOpenTerminal={handleOpenTerminal}
              isLast={idx === arr.length - 1}
              sessionId={sid}
              client={clientRef.current || undefined}
              accent={accent}
              onCancelPending={(id) => removePendingMessage(sid, id)}
              onRetry={(id) => retryDelivery(sid, id)}
            />
          </div>
        ))}
        {/* Inline permission request — skip for AskUserQuestion (rendered inline by the tool card) */}
        {cs.permRequest && cs.permRequest.toolName !== 'AskUserQuestion' && (() => {
          const req = cs.permRequest;
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
            <div ref={isActiveSession ? permRequestRef : undefined} className={`py-1 pl-3 ml-1 border-l-2 ${isAskUser ? 'border-violet-500/50' : 'border-amber-500/50'}`}>
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
              {isBash && (
                <div className="rounded bg-[#0d0d0d] border border-border mb-2 px-3 py-2">
                  <pre className="text-[12px] font-mono text-green-400 whitespace-pre-wrap break-all m-0 leading-snug">
                    <span className="text-zinc-600 select-none">$ </span>{input.command as string}
                  </pre>
                </div>
              )}
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
              {isPlan && (
                <div className="rounded border border-violet-500/30 bg-violet-500/5 mb-2 px-3 py-2 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[10px] text-violet-400">◆</span>
                    <span className="text-[11px] text-violet-300 font-semibold uppercase tracking-wide shrink-0">Plan</span>
                    <span className="text-[11px] text-zinc-500 truncate">
                      {planContent ? (planContent.split('\n').find(l => l.trim()) || '').slice(0, 80) : 'No plan content'}
                    </span>
                  </div>
                  {planContent && !cs.openPlan && (
                    <button
                      className="text-[11px] text-violet-300 hover:text-violet-200 hover:bg-violet-500/15 rounded px-2 py-0.5 shrink-0"
                      onClick={() => updateLocalState(sid, s => ({
                        ...s,
                        openPlan: { content: planContent, allowedPrompts },
                        lastPlan: { content: planContent, allowedPrompts },
                        openMockup: null, openTerminalId: null, diffView: null,
                      }))}
                      title="Reopen plan in the side panel"
                    >
                      Open in side panel
                    </button>
                  )}
                </div>
              )}
              {isAskUser && askQuestions.length > 0 && (
                <AskUserQuestionForm
                  questions={askQuestions}
                  onSubmit={(answers) => {
                    handlePermission(req.requestId, true, { ...input, answers });
                  }}
                />
              )}
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
                    if (isPlan && clientRef.current) {
                      setSessions(prev => prev.map(s => s.id === sid ? { ...s, permission_mode: 'acceptEdits' } : s));
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
                      if (clientRef.current) {
                        setSessions(prev => prev.map(s => s.id === sid ? { ...s, permission_mode: 'acceptEdits' } : s));
                        clientRef.current.setPermissionMode(sid, 'acceptEdits');
                        clientRef.current.updateSession(sid, { permissionMode: 'acceptEdits' }).catch(() => {});
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
    );
  };

  return (
    <Providers>
      <div className="h-screen bg-base flex flex-col overflow-hidden">
        {/* Custom title bar — system chrome is hidden via Electron's
         *  `titleBarStyle: 'hiddenInset'`, which keeps the macOS traffic lights
         *  on the left and frees up the rest of the bar for our own content.
         *  The whole strip is a drag region, except for interactive controls
         *  (layout-mode pill) which opt out with `app-region: no-drag`. */}
        <div
          className={`fixed top-0 left-0 right-0 z-[9999] flex items-center select-none border-b ${
            layoutMode === 'horizontal'
              ? 'h-10 bg-[#131418] border-[#2a2b30]'
              : 'h-9 bg-base border-border'
          }`}
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          {/* Reserve room for macOS traffic lights / Windows left padding */}
          {IS_MAC ? <div className="w-20 shrink-0" /> : <div className="w-3 shrink-0" />}

          {/* Session controls — collapse toggle (standard only) + new +
              history. Live in the titlebar so the activity bar stays focused
              on view switching, and so they're reachable in every mode. */}
          <div
            className="flex items-center gap-0.5 mr-2 shrink-0"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            {layoutMode === 'standard' && (
              <button
                className={`w-7 h-6 flex items-center justify-center rounded-md transition-colors ${
                  tabsCollapsed ? 'text-zinc-500 hover:text-zinc-200 hover:bg-surface-light' : 'text-zinc-200 bg-surface-light'
                }`}
                onClick={toggleTabsCollapsed}
                title={tabsCollapsed ? 'Show sessions' : 'Hide sessions'}
                aria-label={tabsCollapsed ? 'Show sessions sidebar' : 'Hide sessions sidebar'}
              >
                <PanelLeft className="w-3.5 h-3.5" />
              </button>
            )}
            <ActivityBarSessionActions
              closedSessions={closedSessions}
              onNew={handleNewSession}
              onReopen={handleReopenSession}
              onArchive={handleArchiveSession}
            />
            <RunningInstancesButton
              sessions={sessions}
              sessionStreaming={sessionStreaming}
              sessionHasPermission={sessionHasPermission}
              onStop={handleStopInstance}
            />
          </div>

          {/* Active-session info controls — relocated here from the old
              per-chat info bar. Sits just after the session controls on the
              left; opts out of the window drag region so the buttons click. */}
          {activeId && (
            <div
              className="flex items-center gap-2 mr-2 min-w-0 shrink"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            >
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
              <div className="relative">
                {prLinks[activeId] ? (
                  <button
                    className="flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] bg-green-500/15 text-green-400 border border-green-500/25 hover:bg-green-500/25 transition-colors"
                    onClick={(e) => {
                      e.stopPropagation();
                      const linked = prLinks[activeId!];
                      setOpenPR({ number: linked.prNumber, title: linked.title, url: linked.url, headRefName: linked.headRefName, state: linked.state });
                      if (activeId) updateLocalState(activeId, s => ({ ...s, diffView: null }));
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

            </div>
          )}

          {/* Horizontal mode: session tab strip takes the middle.
              Standard/Focus mode: centered "current session" pill opens
              the command palette. */}
          {layoutMode === 'horizontal' ? (
            <SessionTabStrip
              sessions={orderedOpenSessions}
              activeSessionId={activeId}
              sessionStatuses={statuses}
              sessionStreaming={sessionStreaming}
              sessionInterrupted={sessionInterrupted}
              sessionTurnComplete={turnCompleteIds}
              sessionHasPermission={sessionHasPermission}
              tabGroups={tabGroups}
              tabGroupMap={tabGroupMap}
              groupRemoteInfo={groupRemoteInfo}
              expandedGroupIds={expandedGroupIds}
              onSelect={handleSelectSession}
              onClose={handleCloseTab}
              onNew={handleNewSession}
              onToggleGroup={handleToggleGroup}
              onCloseGroup={handleRequestDeleteGroup}
            />
          ) : (
            <>
              <div className="flex-1" />
              <button
                onClick={() => setShowPalette(true)}
                title="Search sessions, files, commands (⌘P)"
                className="group absolute left-1/2 -translate-x-1/2 h-6 w-[420px] max-w-[40vw] px-2.5 flex items-center gap-2 bg-surface hover:bg-surface-light border border-border hover:border-border-light rounded-md transition-colors"
                style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
              >
                <Search className="w-3.5 h-3.5 shrink-0 text-zinc-500 group-hover:text-zinc-400" />
                <span className="flex-1 min-w-0 text-center text-[12px] font-medium text-zinc-200 truncate">
                  {activeSession?.name ?? 'No active session'}
                </span>
                <span className="flex items-center gap-0.5 shrink-0 text-[10px] text-zinc-500 group-hover:text-zinc-400 font-mono">
                  <kbd className="px-1 py-px bg-surface-lighter border border-border rounded">⌘</kbd>
                  <kbd className="px-1 py-px bg-surface-lighter border border-border rounded">P</kbd>
                </span>
              </button>
            </>
          )}

          {/* Port forwards chip — only renders when the active session lives
              on a remote. The popover handles its own visibility. */}
          <div className="ml-auto mr-1.5 flex items-center" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
            <PortForwardsPopover
              client={client}
              session={activeSession}
              tunnelStatus={activeSession?.remoteId ? remoteStatuses[activeSession.remoteId]?.status : undefined}
            />
          </div>

          {/* Right cluster: workspace actions (only in focus mode) + layout
              switcher. Both groups opt out of the drag region so clicks
              register as button presses instead of starting a window drag. */}
          {layoutMode === 'focus' && (
            <div
              className="mr-1.5 flex items-center gap-0.5 relative"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            >
              <button
                ref={addChatBtnRef}
                onClick={() => setAddChatPickerOpen(v => !v)}
                title="Add a chat to this workspace"
                className="w-7 h-6 flex items-center justify-center rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-surface-light transition-colors"
              >
                <BookmarkPlus className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={handleNewSession}
                title="New chat in this workspace"
                className="w-7 h-6 flex items-center justify-center rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-surface-light transition-colors"
              >
                <MessageSquarePlus className="w-3.5 h-3.5" />
              </button>
              {addChatPickerOpen && (() => {
                // Group sessions by their tab-group id (using `tabGroupMap`),
                // collecting ungrouped sessions into a synthetic "Ungrouped"
                // bucket so every session shows up even if it isn't grouped.
                const buckets = new Map<string, { id: string; name: string; sessions: SessionInfo[] }>();
                const UNGROUPED = '__ungrouped__';
                for (const s of orderedOpenSessions) {
                  const gid = tabGroupMap[s.id] ?? UNGROUPED;
                  if (!buckets.has(gid)) {
                    const meta = gid === UNGROUPED
                      ? { id: UNGROUPED, name: 'Ungrouped' }
                      : { id: gid, name: tabGroups[gid]?.name ?? 'Group' };
                    buckets.set(gid, { ...meta, sessions: [] });
                  }
                  buckets.get(gid)!.sessions.push(s);
                }
                const sections = Array.from(buckets.values());
                return (
                  <div
                    ref={addChatPickerRef}
                    className="absolute right-0 top-7 z-[10000] w-72 max-h-[420px] overflow-y-auto bg-surface border border-border-light rounded-lg shadow-xl py-1"
                  >
                    {orderedOpenSessions.length === 0 ? (
                      <div className="px-3 py-4 text-xs text-zinc-500 text-center">No open chats.</div>
                    ) : (
                      sections.map(section => (
                        <div key={section.id}>
                          <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">
                            {section.name}
                          </div>
                          {section.sessions.map(s => {
                            const inWs = activeWorkspace?.sessionIds.includes(s.id) ?? false;
                            const status = statuses[s.id] || 'disconnected';
                            const dot =
                              status === 'connected' ? 'bg-green-400' :
                              status === 'connecting' ? 'bg-amber-400' :
                              'bg-zinc-600';
                            return (
                              <button
                                key={s.id}
                                disabled={inWs}
                                onClick={() => {
                                  addSessionToActiveWorkspace(s.id);
                                  setAddChatPickerOpen(false);
                                }}
                                className="w-full px-3 py-1.5 flex items-center gap-2 text-left hover:bg-surface-light disabled:opacity-40 disabled:hover:bg-transparent"
                              >
                                <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
                                <div className="flex-1 min-w-0">
                                  <div className="text-[12.5px] text-zinc-200 truncate">{s.name}</div>
                                  <div className="text-[10.5px] text-zinc-500 font-mono truncate">{s.cwd}</div>
                                </div>
                                {inWs && (
                                  <span className="text-[10px] text-zinc-500 shrink-0">In workspace</span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      ))
                    )}
                  </div>
                );
              })()}
            </div>
          )}

          {/* Right: settings + layout-mode pill (clickable — opt out of drag) */}
          <button
            onClick={() => setProjectSettings(prev => ({ open: !prev.open }))}
            title="Settings"
            aria-label="Settings"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            className={`mr-1.5 flex items-center justify-center w-7 h-7 rounded-lg bg-surface border border-border transition-colors ${projectSettings.open ? 'text-zinc-100 ring-1 ring-border-light' : 'text-zinc-500 hover:text-zinc-300'}`}
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></svg>
          </button>
          <div
            className={`${IS_MAC ? 'mr-3' : 'mr-36'} flex items-center gap-0.5 bg-surface border border-border rounded-lg p-0.5`}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <button
              onClick={() => changeLayoutMode('standard')}
              className={`flex items-center justify-center w-7 h-6 rounded-md transition-colors ${
                layoutMode === 'standard'
                  ? 'bg-surface-lighter text-zinc-100 ring-1 ring-border-light'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
              title="Standard layout (vertical tabs)"
            >
              <PanelsTopLeft className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => changeLayoutMode('horizontal')}
              className={`flex items-center justify-center w-7 h-6 rounded-md transition-colors ${
                layoutMode === 'horizontal'
                  ? 'bg-surface-lighter text-zinc-100 ring-1 ring-border-light'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
              title="Horizontal tabs"
            >
              <PanelTop className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => changeLayoutMode('focus')}
              className={`flex items-center justify-center w-7 h-6 rounded-md transition-colors ${
                layoutMode === 'focus'
                  ? 'bg-surface-lighter text-zinc-100 ring-1 ring-border-light'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
              title="Chat Focus layout"
            >
              <LayoutGrid className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
        {layoutMode === 'focus' ? (
          <div className="flex-1 flex min-h-0 min-w-0 pt-9 relative">
            <ChatFocusLayout
              sessions={orderedOpenSessions}
              activeSessionId={activeId}
              onSelectSession={handleSelectSession}
              paneAccent={colorChatBySession ? getSessionAccent : undefined}
              accentPalette={SESSION_ACCENT_PALETTE}
              onPickAccent={handlePickSessionAccent}
              onExpandSession={(sid) => { handleSelectSession(sid); changeLayoutMode('standard'); }}
              renderComposer={renderComposer}
              renderBody={(sid) => renderChatBody(sid, colorChatBySession ? getSessionAccent(sid) : undefined)}
              workspaces={focusWorkspaces}
              setWorkspaces={setFocusWorkspaces}
              activeWorkspaceId={activeWorkspaceId}
              setActiveWorkspaceId={setActiveWorkspaceId}
              onCloseWorkspace={handleCloseWorkspace}
              onRenameWorkspace={handleRenameWorkspace}
              onReorderWorkspaces={handleReorderWorkspaces}
            />
            {/* Off-screen-but-measurable anchor that keeps the embedded
                BrowserView attached (and its bounds fresh) while the panel
                chrome is unmounted. Without it the webview's bounds would
                go stale on layout switches and the page would jump on the
                way back to standard layout. */}
            {browserOpen && activeId && activeBrowser && active.activeBrowserName && (
              <FocusBrowserAnchor
                label={browserLabelFor(activeId, active.activeBrowserName)}
                url={activeBrowser.url}
                title={activeBrowser.title}
                openSeq={activeBrowser.openSeq}
                cookieJar={activeBrowser.cookieJar}
              />
            )}
          </div>
        ) : (
        <div className={`flex-1 flex min-h-0 min-w-0 ${layoutMode === 'horizontal' ? 'pt-10' : 'pt-9'}`}>
          {/* Standard layout keeps the vertical TabBar sidebar; horizontal
              layout drops it because the SessionTabStrip in the titlebar
              handles session navigation. */}
          {layoutMode === 'standard' && (
            <TabBar
              sessions={orderedOpenSessions}
              closedSessions={closedSessions}
              activeSessionId={activeId}
              sessionStatuses={statuses}
              sessionStreaming={sessionStreaming}
              sessionInterrupted={sessionInterrupted}
              sessionTurnComplete={turnCompleteIds}
              sessionHasPermission={sessionHasPermission}
              sessionActivity={sessionActivity}
              sessionLastMessageAt={sessionLastMessageAt}
              pinnedSessionIds={pinnedSessionIds}
              onTogglePin={handleTogglePin}
              onSelect={handleSelectSession}
              onNew={handleNewSession}
              onClose={handleCloseTab}
              onReopen={handleReopenSession}
              onRename={handleRenameSession}
              onReorder={handleReorder}
              accentPalette={SESSION_ACCENT_PALETTE}
              getSessionAccent={getSessionAccent}
              onPickSessionAccent={colorChatBySession ? handlePickSessionAccent : undefined}
              tabGroups={tabGroups}
              tabGroupMap={tabGroupMap}
              groupRemoteInfo={groupRemoteInfo}
              expandedGroupIds={expandedGroupIds}
              onCreateGroup={handleCreateGroup}
              onGroupTabs={handleGroupTabs}
              onAddToGroup={handleAddToGroup}
              onUngroupTab={handleUngroupTab}
              onToggleGroup={handleToggleGroup}
              onSelectGroup={handleSelectGroup}
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
              activeNavView={activeNavView}
              onSelectNavView={setActiveNavView}
            />
          )}
          {/* Side Panel: Explorer (cards) — Search now lives inside it as a card,
              Settings moved to the titlebar, the old Activity Bar is gone.
              Hidden in group mode: a group tab is selected to compose a new
              session, but `activeId` still points at the last opened session,
              so the tree would show stale files from a possibly-different folder. */}
          {activeNavView === 'sessions' && activeId && !(selectedGroupId && tabGroups[selectedGroupId]) && (
          <FileExplorer
            client={client}
            rootPath={explorerRoot}
            collapsed={explorerCollapsed}
            onToggle={() => setExplorerCollapsed(c => !c)}
            onFileOpen={handleFileOpen}
            onFileDiff={handleFileDiff}
            onFileDiffFullView={handleFileDiffFullView}
            gitModified={gitModified}
            activeFilePath={openFile?.path ?? null}
            activeDiffPath={diffView?.path ?? null}
            changesCompare={changesCompare}
            onChangesCompareChange={setChangesCompare}
            baseBranch={baseBranch}
            activeSessionId={activeId}
            onOpenTerminal={(command) => {
              const msg = active.messages.findLast(m => m.isTerminal && m.terminalCommand === command);
              if (msg) { if (activeId) updateLocalState(activeId, s => ({ ...s, openTerminalId: msg.id, diffView: null })); }
            }}
            onStartReview={handleStartReview}
            onRefreshGit={refreshGitModified}
            tools={active.initInfo?.tools}
            sessionName={activeSession?.name}
            searchActive={searchActive}
            onSearchActiveChange={setSearchActive}
            requestedTab={tabRequest}
            renderSearchCard={(onClose) => (
              <SearchPanel client={client} rootPath={explorerRoot} onFileOpen={handleFileOpen} onClose={onClose} />
            )}
          />
          )}

          <div className="flex-1 flex flex-col min-w-0">
            {activeNavView === 'sessions-board' ? (
              <SessionsBoardView
                sessions={sessions}
                statuses={statuses}
                streaming={sessionStreaming}
                hasPermission={sessionHasPermission}
                lastMessageAt={sessionLastMessageAt}
                lastPreview={sessionLastPreview}
                prLinks={prLinks}
                tabGroups={tabGroups}
                tabGroupMap={tabGroupMap}
                onSelectSession={handleSelectSession}
                onAssignGroup={(sid, gid) => gid ? handleAddToGroup(sid, gid) : handleUngroupTab(sid)}
              />
            ) : !activeId ? (
              <GroupComposer
                groupName=""
                groupCwd={
                  // Most recent session's cwd is a sensible default; the
                  // composer's folder picker still surfaces all recent dirs.
                  [...sessions]
                    .sort((a, b) => (sessionLastMessageAt[b.id] || 0) - (sessionLastMessageAt[a.id] || 0))
                    .find(s => s.cwd)?.cwd || ''
                }
                client={client}
                opencodeInfo={opencodeInfo}
                claudeModels={claudeModels}
                onSpawn={handleSpawnHome}
                onBrowseFolder={() => setShowNewSession(true)}
              />
            ) : (
              <>
              <div ref={contentRef} className="flex-1 flex min-h-0">
                {/* Unified session workspace — chat (left) + resources (right),
                    or the group composer, all inside one per-session PanelsWorkspace.
                    Sidebars stay outside; everything else in the central area is a tab. */}
                {(activeId || (selectedGroupId && tabGroups[selectedGroupId])) && (() => {
                  const groupMode = !!(selectedGroupId && tabGroups[selectedGroupId]);
                  const wsId = groupMode ? ('group:' + (selectedGroupId || 'x')) : (activeId || 'none');
                  const panelTabs: PanelTab[] = [];
                  if (groupMode) {
                    panelTabs.push({ id: 'group-composer', kind: 'group-composer', title: tabGroups[selectedGroupId as string]!.name, icon: '✦', zone: 'chat', closable: false });
                  } else if (activeId) {
                    panelTabs.push({ id: 'chat', kind: 'chat', title: 'Chat', icon: '💬', zone: 'chat', closable: false });
                    // One panel tab per open file (VSCode-style). At most one
                    // is an italic `preview` tab, replaced when the next file
                    // opens unless pinned (double-click) or modified.
                    for (const t of active.editorTabs) {
                      panelTabs.push({ id: 'editor:' + t.path, kind: t.image ? 'image' : 'editor', title: t.path.split('/').pop() || 'editor', icon: t.image ? '🖼️' : '📄', dirty: t.dirty, preview: t.preview, deleted: t.deleted, zone: 'main' });
                    }
                    if (openMockup) panelTabs.push({ id: 'mockup', kind: 'mockup', title: openMockup.name, icon: '🎨', zone: 'main' });
                    // One panel tab per open browser — the previews live
                    // side-by-side in the panel strip instead of behind an
                    // in-component tab bar. Tab id encodes the browser name.
                    for (const [bName, b] of Object.entries(active.browsers)) {
                      panelTabs.push({ id: 'browser:' + bName, kind: 'browser', title: b.title || bName, icon: '🌐', zone: 'main' });
                    }
                    if (openPlan) panelTabs.push({ id: 'plan', kind: 'plan', title: 'Plan', icon: '📋', zone: 'main' });
                    if (pluginDetailOpen) panelTabs.push({ id: 'plugin', kind: 'plugin', title: 'Plugin', icon: '🧩', zone: 'main' });
                    if (openPR) panelTabs.push({ id: 'pr', kind: 'pr', title: openPR.number ? ('PR #' + openPR.number) : 'PR', icon: '◧', zone: 'main' });
                    if (openTerminal) panelTabs.push({ id: 'terminal', kind: 'terminal', title: openTerminal.terminalCommand || 'terminal', icon: '▸', zone: 'main' });
                    if (diffView) panelTabs.push({ id: 'diff', kind: 'diff', title: diffView.path.split('/').pop() || 'diff', icon: '±', zone: 'main' });
                  }

                  const closePanelTab = (tab: PanelTab) => {
                    if (!activeId) return;
                    switch (tab.kind) {
                      case 'editor': case 'image': closeEditor(activeId, tab.id.slice('editor:'.length)); break;
                      case 'mockup': updateLocalState(activeId, s => ({ ...s, openMockup: null, editorFullWidth: false, mockupInspect: false })); break;
                      case 'browser': closeBrowserFully(activeId, tab.id.slice('browser:'.length)); break;
                      case 'plan': updateLocalState(activeId, s => ({ ...s, openPlan: null, editorFullWidth: false })); break;
                      case 'plugin': setPluginDetailOpen(false); break;
                      case 'pr': setOpenPR(null); break;
                      case 'terminal': updateLocalState(activeId, s => ({ ...s, openTerminalId: null })); break;
                      case 'diff': updateLocalState(activeId, s => ({ ...s, diffView: null, editorFullWidth: false })); break;
                    }
                  };

                  const renderPanelTab = (tab: PanelTab) => {
                    switch (tab.kind) {
                      case 'chat': {
                        return (
                          <div className="h-full w-full min-h-0 min-w-0 flex flex-col overflow-hidden relative">
                  <ChatFindWidget
                    open={findOpen}
                    onClose={() => setFindOpen(false)}
                    getContainer={() => scrollRef.current}
                  />
                  <div className="flex flex-1 min-h-0">
                  {/* When a group is focused (sidebar click) but no session
                      inside it is selected, render the inline new-session
                      composer instead of the chat body. Otherwise mount the
                      active session's chat (same path used by focus mode). */}
                  {selectedGroupId && tabGroups[selectedGroupId] ? (
                    <GroupComposer
                      groupName={tabGroups[selectedGroupId]!.name}
                      groupCwd={
                        tabGroups[selectedGroupId]!.cwd
                          || sessions.find(s => tabGroupMap[s.id] === selectedGroupId)?.cwd
                          || ''
                      }
                      client={client}
                      opencodeInfo={opencodeInfo}
                      claudeModels={claudeModels}
                      remoteId={groupRemoteInfo[selectedGroupId]?.remoteId ?? null}
                      remoteName={groupRemoteInfo[selectedGroupId]?.remoteName ?? null}
                      remoteColor={groupRemoteInfo[selectedGroupId]?.remoteColor ?? null}
                      onSpawn={(cwd, provider, prompt, model, permissionMode, worktreeOrigin, remoteId, images) =>
                        handleSpawnInGroup(selectedGroupId, cwd, provider, prompt, model, permissionMode, worktreeOrigin, remoteId, images)
                      }
                      onBrowseFolder={() => setShowNewSession(true)}
                    />
                  ) : (
                    activeId && renderChatBody(activeId, colorChatBySession ? getSessionAccent(activeId) : undefined)
                  )}

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
                      {todos.every(t => t.status === 'completed') && activeId && (
                        <div className="border-t border-border p-1.5 shrink-0">
                          <button
                            type="button"
                            className="w-full text-[11px] text-zinc-400 hover:text-zinc-100 bg-surface-light/40 hover:bg-surface-light rounded py-1 transition-colors"
                            onClick={() => updateLocalState(activeId, s => ({ ...s, todos: [] }))}
                          >
                            Close
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                  </div>

                  {termDockHost && createPortal((() => {
                    if (!activeId) return null;
                    // Terminals are a first-class resource — the dock renders
                    // straight from the fetched list, not from chat messages.
                    const shells = terminals[activeId] || [];
                    const hasShells = shells.length > 0;
                    const activeShellId = hasShells
                      ? (activeShellBySession[activeId] || shells[shells.length - 1]!.id)
                      : null;
                    const activeShell = hasShells
                      ? (shells.find(s => s.id === activeShellId) || shells[shells.length - 1]!)
                      : null;
                    const runningCount = shells.filter(s => s.exitCode === null).length;
                    const idleCount = shells.length - runningCount;
                    // "(interactive shell)" is the server's placeholder command
                    // for a bare shell — surface a friendlier label instead.
                    const shellLabel = (s: TerminalInfo): string =>
                      s.terminalName || (s.command && s.command !== '(interactive shell)' ? s.command : 'shell');

                    // Close === kill: DELETE the terminal; the tab disappears
                    // when the `terminal_removed` broadcast lands (which also
                    // clears activeShell state via onTerminalRemoved).
                    const dismissProcId = (procId: string, shellId: string) => {
                      try { void clientRef.current?.deleteTerminal(activeId, procId); } catch {}
                      setMinimizedShells(prev => {
                        if (!prev.has(shellId)) return prev;
                        const n = new Set(prev); n.delete(shellId); return n;
                      });
                    };

                    // Helper used by both the collapsed bar and the expanded
                    // panel toolbar. Anonymous shells (no terminalName) live
                    // only in the panel — the chat filter excludes them. Shares
                    // the same component-scoped implementation as the
                    // `new-terminal` keybinding (see spawnNewTerminal).
                    const spawnNewShellHere = spawnNewTerminal;

                    // Collapsed state — thin status bar with counter + chips.
                    // Always rendered (even with zero shells) so the user
                    // always has a quick way to spawn or open the panel.
                    if (!terminalsPanelExpanded) {
                      return (
                        <div
                          className={`order-last shrink-0 mx-1.5 mb-1.5 rounded-[12px] border ${terminalsFocused ? 'border-blue-500/60' : 'border-[#2a2b30]'} bg-[image:linear-gradient(180deg,#141519,#101113)] shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_6px_18px_rgba(0,0,0,0.3)] px-3 py-1.5 flex items-center gap-2.5 transition-colors`}
                          title={hasShells ? 'Expand Terminals panel' : 'No terminals yet'}
                        >
                          <button
                            type="button"
                            onClick={() => hasShells && setTerminalsPanelExpanded(true)}
                            className="flex items-center gap-2.5 flex-1 min-w-0 text-left cursor-pointer disabled:cursor-default"
                            disabled={!hasShells}
                          >
                            <Terminal className={`w-3.5 h-3.5 ${hasShells ? 'text-emerald-400' : 'text-zinc-600'}`} strokeWidth={1.75} />
                            <span className="text-[11.5px] text-zinc-300 font-medium">Terminals</span>
                            <span className="text-[10.5px] text-zinc-500 font-mono">
                              {hasShells ? `${runningCount} running${idleCount ? ` · ${idleCount} idle` : ''}` : 'none'}
                            </span>
                            <span className="inline-flex items-center gap-1.5 ml-1">
                              {shells.filter(s => s.exitCode === null).slice(-4).map(s => {
                                const pid = s.procId || s.id;
                                const renamed = shellRenames[activeId]?.[pid];
                                return (
                                  <span
                                    key={s.id}
                                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-[10px] font-mono text-emerald-300"
                                    title={renamed || shellLabel(s)}
                                  >
                                    <span className="w-1 h-1 rounded-full bg-emerald-400 animate-pulse" />
                                    {(renamed || shellLabel(s)).slice(0, 14)}
                                  </span>
                                );
                              })}
                            </span>
                          </button>
                          <div className="ml-auto inline-flex items-center gap-1 shrink-0">
                            <button
                              type="button"
                              onClick={spawnNewShellHere}
                              className="h-6 px-2 inline-flex items-center gap-1 rounded text-[10.5px] text-zinc-300 hover:text-zinc-100 hover:bg-surface-light"
                              title="New shell"
                            >
                              <Plus className="w-3 h-3" />
                              new
                            </button>
                            {hasShells && (
                              <button
                                type="button"
                                onClick={() => setTerminalsPanelExpanded(true)}
                                className="h-6 w-6 inline-flex items-center justify-center rounded text-zinc-500 hover:text-zinc-200 hover:bg-surface-light"
                                title="Expand panel"
                              >
                                <ChevronUp className="w-3 h-3" />
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    }

                    // Expanded state — full bottom panel. `order-last` pins
                    // it under the composer regardless of JSX position.
                    const startResize = (e: React.MouseEvent) => {
                      e.preventDefault();
                      // Maximize state is incompatible with manual drag — clear it
                      // so the splitter has a known starting height to grow from.
                      if (terminalsPanelMaximized) setTerminalsPanelMaximized(false);
                      const startY = e.clientY;
                      const startHeight = terminalsPanelMaximized
                        ? Math.round(window.innerHeight * 0.7)
                        : terminalsPanelHeight;
                      setPanelResizing(true);
                      const onMove = (ev: MouseEvent) => {
                        const dy = startY - ev.clientY; // dragging up grows the panel
                        const next = startHeight + dy;
                        const max = Math.round(window.innerHeight * 0.85);
                        const clamped = Math.min(max, Math.max(120, next));
                        setTerminalsPanelHeight(clamped);
                      };
                      const onUp = () => {
                        document.removeEventListener('mousemove', onMove);
                        document.removeEventListener('mouseup', onUp);
                        setPanelResizing(false);
                        // Persist whatever the final value ended up being.
                        setTerminalsPanelHeight(h => { persistPrefs({ terminalsPanelHeight: h }); return h; });
                      };
                      document.addEventListener('mousemove', onMove);
                      document.addEventListener('mouseup', onUp);
                    };
                    return (
                      <div
                        className={`order-last shrink-0 mx-1.5 mb-1.5 rounded-[12px] border ${terminalsFocused ? 'border-blue-500/60' : 'border-[#2a2b30]'} bg-base overflow-hidden shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_6px_18px_rgba(0,0,0,0.3)] flex flex-col relative transition-colors`}
                        style={{ height: terminalsPanelMaximized ? '70vh' : terminalsPanelHeight }}
                      >
                        {/* Drag handle — 6px-tall hit zone pinned just inside the
                            top edge (kept inside so the rounded card's overflow
                            clip doesn't swallow it). 2px line on hover. */}
                        <div
                          onMouseDown={startResize}
                          onDoubleClick={() => setTerminalsPanelHeight(340)}
                          title="Drag to resize · double-click to reset"
                          className="absolute top-0 left-0 right-0 h-1.5 z-20 cursor-row-resize group"
                          style={{ touchAction: 'none' }}
                        >
                          <div className={`absolute inset-x-0 top-0 h-[2px] transition-colors ${panelResizing ? 'bg-violet-500' : 'bg-transparent group-hover:bg-violet-500/60'}`} />
                        </div>
                        {/* Fullscreen overlay during resize so xterm / iframes
                            don't swallow the mousemove. */}
                        {panelResizing && <div className="fixed inset-0 z-[9999] cursor-row-resize" />}
                        {/* Tab strip + tools — fixed h-9 keeps the active
                            indicator consistent regardless of tab count.
                            Active state uses an inset box-shadow so the
                            indicator never bleeds into the parent border. */}
                        <div className="flex items-center border-b border-border bg-surface/40 shrink-0 h-9">
                          <div className="flex items-stretch overflow-x-auto h-full">
                            {shells.map(sh => {
                              const running = sh.exitCode === null;
                              const code = sh.exitCode;
                              const exited = !running;
                              const isActive = sh.id === activeShellId;
                              const procId = sh.procId || sh.id;
                              const renamed = shellRenames[activeId]?.[procId];
                              const fallback = shellLabel(sh).slice(0, 24);
                              const name = renamed || fallback;
                              const isRenaming = renamingShellId === sh.id;
                              const dotCls = running
                                ? 'bg-emerald-400 animate-pulse'
                                : code === 0 ? 'bg-zinc-600' : 'bg-red-400';
                              return (
                                <button
                                  key={sh.id}
                                  onClick={() => {
                                    if (isRenaming) return;
                                    setActiveShellBySession(prev => ({ ...prev, [activeId]: sh.id }));
                                    setMinimizedShells(prev => {
                                      if (!prev.has(sh.id)) return prev;
                                      const n = new Set(prev); n.delete(sh.id); return n;
                                    });
                                  }}
                                  onContextMenu={(e) => {
                                    e.preventDefault();
                                    setTabContextMenu({
                                      shellId: sh.id,
                                      procId,
                                      running,
                                      x: e.clientX,
                                      y: e.clientY,
                                    });
                                  }}
                                  onDoubleClick={(e) => {
                                    e.stopPropagation();
                                    setRenamingShellId(sh.id);
                                  }}
                                  className={`group relative inline-flex items-center gap-2 h-full px-3 text-[12px] transition-colors max-w-[220px] ${
                                    isActive
                                      ? 'text-zinc-50 bg-violet-500/[0.07]'
                                      : exited
                                        ? 'text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.02]'
                                        : 'text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.02]'
                                  }`}
                                  style={isActive ? { boxShadow: 'inset 0 -2px 0 #8b5cf6' } : undefined}
                                  title={`${name}${sh.cwd ? ' · ' + sh.cwd : ''} — double-click or right-click to rename`}
                                >
                                  <span
                                    className={`w-2 h-2 rounded-full shrink-0 ${dotCls}`}
                                    style={isActive ? { boxShadow: '0 0 0 3px rgba(139, 92, 246, 0.18)' } : undefined}
                                  />
                                  {isRenaming ? (
                                    <input
                                      autoFocus
                                      defaultValue={renamed || fallback}
                                      onClick={(e) => e.stopPropagation()}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                          const next = (e.currentTarget.value || '').trim();
                                          setShellRenames(prev => {
                                            const sidMap = { ...(prev[activeId] || {}) };
                                            if (next) sidMap[procId] = next; else delete sidMap[procId];
                                            const out = { ...prev, [activeId]: sidMap };
                                            persistPrefs({ shellRenames: out });
                                            return out;
                                          });
                                          setRenamingShellId(null);
                                        } else if (e.key === 'Escape') {
                                          setRenamingShellId(null);
                                        }
                                      }}
                                      onBlur={(e) => {
                                        const next = (e.currentTarget.value || '').trim();
                                        setShellRenames(prev => {
                                          const sidMap = { ...(prev[activeId] || {}) };
                                          if (next && next !== fallback) sidMap[procId] = next;
                                          else delete sidMap[procId];
                                          const out = { ...prev, [activeId]: sidMap };
                                          persistPrefs({ shellRenames: out });
                                          return out;
                                        });
                                        setRenamingShellId(null);
                                      }}
                                      className="bg-transparent border border-violet-500/50 rounded px-1 py-px font-medium text-[12px] text-zinc-50 outline-none focus:border-violet-400 min-w-[80px] max-w-[140px]"
                                    />
                                  ) : (
                                    <span className="font-medium truncate">{name}</span>
                                  )}
                                  {!isRenaming && (
                                    <span
                                      role="button"
                                      tabIndex={-1}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        if (running) {
                                          try { clientRef.current?.killTerminal(activeId, procId); } catch {}
                                        } else {
                                          dismissProcId(procId, sh.id);
                                        }
                                      }}
                                      className="opacity-0 group-hover:opacity-100 w-4 h-4 inline-flex items-center justify-center rounded text-zinc-500 hover:text-red-300 hover:bg-red-500/10 transition-opacity"
                                      title={running ? 'Kill shell' : 'Remove from chat'}
                                    >
                                      <X className="w-3 h-3" />
                                    </span>
                                  )}
                                </button>
                              );
                            })}
                          </div>
                          <div className="ml-auto flex items-center gap-0.5 px-1.5">
                            <button
                              type="button"
                              onClick={spawnNewShellHere}
                              className="h-6 px-2 inline-flex items-center gap-1 rounded text-[11px] text-zinc-300 hover:text-zinc-100 hover:bg-surface-light"
                              title="New shell"
                            >
                              <Plus className="w-3 h-3" />
                              new
                            </button>
                            <span className="w-1 h-1 rounded-full bg-zinc-700 mx-1.5" />
                            <button
                              type="button"
                              onClick={() => setTerminalsPanelMaximized(v => !v)}
                              className="h-6 w-6 rounded inline-flex items-center justify-center text-zinc-400 hover:text-zinc-100 hover:bg-surface-light"
                              title={terminalsPanelMaximized ? 'Restore panel height' : 'Maximize panel'}
                            >
                              {terminalsPanelMaximized
                                ? <Minimize2 className="w-3 h-3" />
                                : <Maximize2 className="w-3 h-3" />}
                            </button>
                            <button
                              type="button"
                              onClick={() => setTerminalsPanelExpanded(false)}
                              className="h-6 w-6 rounded inline-flex items-center justify-center text-zinc-400 hover:text-zinc-100 hover:bg-surface-light"
                              title="Collapse panel"
                            >
                              <ChevronDown className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>

                        {/* Status strip for the active terminal — hidden when there are no shells */}
                        {activeShell && (() => {
                          const activeProcId = activeShell.procId || activeShell.id;
                          const injected = activeShell.injectedEnv;
                          const injectedCount = injected ? Object.keys(injected).length : 0;
                          return (
                          <div className="px-3.5 py-1.5 border-b border-border bg-surface/30 flex items-center gap-3 text-[11px] shrink-0 relative">
                            <span className="font-mono text-violet-300 font-medium">{shellRenames[activeId]?.[activeProcId] || activeShell.terminalName || 'shell'}</span>
                            {activeShell.terminalUrl && (
                              <>
                                <span className="text-zinc-700">/</span>
                                <a
                                  href={activeShell.terminalUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="font-mono text-zinc-400 hover:text-violet-300 truncate"
                                  title={activeShell.terminalUrl}
                                >
                                  {activeShell.terminalUrl.replace(/^https?:\/\//, '')}
                                </a>
                              </>
                            )}
                            {injectedCount > 0 && (
                              <button
                                type="button"
                                onClick={() => setEnvPopoverProcId(prev => prev === activeProcId ? null : activeProcId)}
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-[10px] font-mono text-emerald-300 hover:bg-emerald-500/15"
                                title={`${injectedCount} env vars injected · click to inspect`}
                              >
                                <Check className="w-3 h-3" />
                                env · {injectedCount}
                              </button>
                            )}
                            {envPopoverProcId === activeProcId && injected && (
                              <>
                                <div className="fixed inset-0 z-[9998]" onClick={() => setEnvPopoverProcId(null)} />
                                <div className="absolute left-0 top-full mt-1 z-[9999] w-[420px] rounded-md border border-border-light bg-surface shadow-2xl overflow-hidden">
                                  <div className="px-3 py-2 border-b border-border bg-surface-light/40 flex items-center gap-2">
                                    <Check className="w-3 h-3 text-emerald-400" />
                                    <span className="text-[11.5px] font-medium text-zinc-200">Injected env</span>
                                    <span className="text-[10.5px] text-zinc-500 ml-auto">at spawn time</span>
                                  </div>
                                  <div className="max-h-[260px] overflow-y-auto py-1">
                                    {Object.entries(injected).map(([k, v]) => (
                                      <div key={k} className="px-3 py-1 grid grid-cols-[1fr_auto] gap-2 items-center hover:bg-surface-light">
                                        <span className="font-mono text-[11px] text-violet-300 truncate" title={k}>{k}</span>
                                        <span className="font-mono text-[11px] text-emerald-300 truncate" title={v}>{v}</span>
                                      </div>
                                    ))}
                                  </div>
                                  <div className="px-3 py-1.5 border-t border-border text-[10.5px] text-zinc-500 leading-snug">
                                    Restart this shell to pick up changes to the source actions' hostnames.
                                  </div>
                                </div>
                              </>
                            )}
                            <span className="ml-auto inline-flex items-center gap-3 text-zinc-500 shrink-0">
                              {activeShell.cwd && (
                                <span className="font-mono text-[10.5px] truncate max-w-[280px]" title={activeShell.cwd}>
                                  {(() => {
                                    const home = (typeof window !== 'undefined' && (window as any).__HOME__) || '';
                                    const cwd = activeShell.cwd!;
                                    const s = home && cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;
                                    return s;
                                  })()}
                                </span>
                              )}
                              {activeShell.exitCode === null ? (
                                <span className="inline-flex items-center gap-1 text-emerald-400">
                                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                                  running
                                </span>
                              ) : (
                                <span className={activeShell.exitCode === 0 ? 'text-zinc-500' : 'text-red-300'}>
                                  exit {activeShell.exitCode ?? 0}
                                </span>
                              )}
                            </span>
                          </div>
                          );
                        })()}

                        {/* xterm body — all shells stay mounted so scrollback/cursor survives tab switching */}
                        <div className="flex-1 min-h-0 relative">
                          {!hasShells && (
                            <div className="absolute inset-0 flex items-center justify-center text-zinc-500 text-[12px] gap-3">
                              <span>No terminals open.</span>
                              <button
                                type="button"
                                onClick={spawnNewShellHere}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-violet-500/40 bg-violet-500/10 text-violet-200 hover:bg-violet-500/20 text-[11.5px]"
                              >
                                <Plus className="w-3 h-3" />
                                New shell
                              </button>
                            </div>
                          )}
                          {shells.map(sh => (
                            <div
                              key={sh.id}
                              className="absolute inset-0"
                              style={sh.id === activeShellId ? undefined : { display: 'none' }}
                            >
                              {clientRef.current && (
                                <InteractiveTerminalBubble
                                  terminal={sh}
                                  sessionId={activeId}
                                  client={clientRef.current}
                                  hideHeader
                                  hidden={sh.id !== activeShellId}
                                />
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })(), termDockHost)}

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

                  {/* Input — hidden while the inline GroupComposer is mounted,
                      since the composer renders its own send affordance. */}
                  {!selectedGroupId && composerNode}
                          </div>
                        );
                      }
                      case 'group-composer': {
                        return (
                          <div className="h-full w-full min-h-0 min-w-0 flex flex-col overflow-y-auto">
                    <GroupComposer
                      groupName={tabGroups[selectedGroupId]!.name}
                      groupCwd={
                        tabGroups[selectedGroupId]!.cwd
                          || sessions.find(s => tabGroupMap[s.id] === selectedGroupId)?.cwd
                          || ''
                      }
                      client={client}
                      opencodeInfo={opencodeInfo}
                      claudeModels={claudeModels}
                      remoteId={groupRemoteInfo[selectedGroupId]?.remoteId ?? null}
                      remoteName={groupRemoteInfo[selectedGroupId]?.remoteName ?? null}
                      remoteColor={groupRemoteInfo[selectedGroupId]?.remoteColor ?? null}
                      onSpawn={(cwd, provider, prompt, model, permissionMode, worktreeOrigin, remoteId, images) =>
                        handleSpawnInGroup(selectedGroupId, cwd, provider, prompt, model, permissionMode, worktreeOrigin, remoteId, images)
                      }
                      onBrowseFolder={() => setShowNewSession(true)}
                    />
                          </div>
                        );
                      }
                      case 'image': {
                        if (!activeId) return null;
                        const iPath = tab.id.slice('editor:'.length);
                        const iTab = active.editorTabs.find(t => t.path === iPath);
                        if (!iTab) return null;
                        return (
                          <ImagePreview
                            path={iPath}
                            src={iTab.content}
                            onClose={() => closeEditor(activeId, iPath)}
                            onReveal={() => client?.revealInFinder(iPath)}
                          />
                        );
                      }
                      case 'editor': {
                        if (!activeId) return null;
                        // Each open file is its own panel tab; the path is in
                        // the tab id. Only the active tab mounts (Panel renders
                        // the active tab only), so there's exactly one Monaco.
                        const ePath = tab.id.slice('editor:'.length);
                        const eTab = active.editorTabs.find(t => t.path === ePath);
                        if (!eTab) return null;
                        const liveKey = liveBufKey(activeId, ePath);
                        return (
                          <div className="h-full w-full min-h-0 min-w-0 flex flex-col">
                  <div className="flex-1 flex flex-col min-w-0">
                    <div className={showDebugPanel ? 'flex-1 min-h-0' : 'flex-1'} style={showDebugPanel ? { flex: '1 1 60%' } : undefined}>
                      <Editor
                        key={ePath}
                        path={ePath}
                        defaultValue={liveBuffersRef.current[liveKey] ?? eTab.content}
                        theme="vs-dark"
                        onMount={(editor, monaco) => {
                          // This tab just became the visible one — keep the
                          // active-editor pointer in sync (drives LSP/debugger
                          // and the focus-mode/anchor logic via derived openFile).
                          if (active.activeEditorPath !== ePath) setActiveEditor(activeId, ePath);
                          handleEditorMount(editor, monaco);
                        }}
                        onChange={(value) => {
                          // Ref write (no re-render) preserves unsaved edits
                          // across tab switches; dirty/pin go through state.
                          liveBuffersRef.current[liveKey] = value ?? '';
                          // An external (on-disk) reload sets the model value
                          // programmatically — that's not a user edit, so skip
                          // the dirty toggle (reload() updates baseline itself).
                          if (externalEditRef.current) return;
                          markEditorDirty(activeId, ePath, (value ?? '') !== eTab.content);
                        }}
                        options={{
                          minimap: { enabled: false },
                          fontSize: 13,
                          lineNumbers: 'on',
                          scrollBeyondLastLine: false,
                          wordWrap: 'on',
                          padding: { top: 8 },
                          glyphMargin: true,
                          readOnly: !!eTab.readOnly,
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
                          </div>
                        );
                      }
                      case 'mockup': {
                        if (!(openMockup && activeId)) return null;
                        return (
                          <div className="h-full w-full min-h-0 min-w-0 flex flex-col">
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
                          </div>
                        );
                      }
                      case 'browser': {
                        if (!activeId) return null;
                        // Each browser is its own panel tab — the name is
                        // encoded in the tab id. Render that one preview; the
                        // panel chrome owns tab switching, so there's no
                        // in-component strip.
                        const name = tab.id.slice('browser:'.length);
                        const b = active.browsers[name];
                        if (!b) return null;
                        const label = browserLabelFor(activeId, name);
                        const commentsForActive = (active.browserComments[name]?.[b.url]) ?? NO_BROWSER_COMMENTS;
                        return (
                          <div className="h-full w-full min-h-0 min-w-0 flex flex-col">
                    <BrowserPanel
                      label={label}
                      url={b.url}
                      title={b.title}
                      openSeq={b.openSeq}
                      cookieJar={b.cookieJar}
                      obscured={showPalette || projectSettings.open || switcher.open}
                      inspect={!!active.browserInspect[name]}
                      comments={commentsForActive}
                      // Mounting means this browser's tab is the active one —
                      // keep `activeBrowserName` (focus-mode anchor + chip
                      // highlight) in sync with what's actually visible.
                      onMountFocus={() => updateLocalState(activeId, s => (
                        s.activeBrowserName === name || !s.browsers[name]
                          ? s
                          : { ...s, activeBrowserName: name }
                      ))}
                      onUrlChanged={(nextUrl) => updateLocalState(activeId, s => {
                        const cur = s.browsers[name];
                        if (!cur || cur.url === nextUrl) return s;
                        // Mirror in-page navigation into session state, but
                        // do NOT bump `openSeq` — that signal is reserved for
                        // model-driven `browser_open` calls. Bumping it here
                        // would force the panel's open-effect / reset-effect
                        // to re-fire on every link click.
                        return {
                          ...s,
                          browsers: { ...s.browsers, [name]: { ...cur, url: nextUrl } },
                        };
                      })}
                      onSetInspect={(next) => updateLocalState(activeId, s => ({
                        ...s,
                        browserInspect: { ...s.browserInspect, [name]: next },
                      }))}
                      onSetComments={(next) => updateLocalState(activeId, s => ({
                        ...s,
                        browserComments: {
                          ...s.browserComments,
                          [name]: {
                            ...(s.browserComments[name] ?? {}),
                            [b.url]: next,
                          },
                        },
                      }))}
                      onSendToChat={(md) => {
                        if (!clientRef.current) return;
                        const browserUrl = b.url;
                        const clearedCommentsForName = {
                          ...(active.browserComments[name] ?? {}),
                          [browserUrl]: [],
                        };
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
                            browserInspect: { ...s.browserInspect, [name]: false },
                            browserComments: { ...s.browserComments, [name]: clearedCommentsForName },
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
                            browserInspect: { ...s.browserInspect, [name]: false },
                            browserComments: { ...s.browserComments, [name]: clearedCommentsForName },
                          }));
                          clientRef.current.sendMessage(activeId, md);
                        }
                      }}
                      onWriteToChat={(md) => {
                        setInput(prev => prev ? prev + (prev.endsWith('\n') ? '' : '\n\n') + md : md);
                        updateLocalState(activeId, s => ({
                          ...s,
                          browserInspect: { ...s.browserInspect, [name]: false },
                        }));
                        inputRef.current?.focus();
                      }}
                      onClose={() => closeBrowserFully(activeId, name)}
                    />
                          </div>
                        );
                      }
                      case 'plan': {
                        if (!(openPlan && activeId)) return null;
                        return (
                          <div className="h-full w-full min-h-0 min-w-0 flex flex-col">
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
                          </div>
                        );
                      }
                      case 'plugin': {
                        if (!(pluginDetailOpen)) return null;
                        return (
                          <div className="h-full w-full min-h-0 min-w-0 flex flex-col">
                  <PluginDetailView />
                          </div>
                        );
                      }
                      case 'pr': {
                        if (!(openPR)) return null;
                        return (
                          <div className="h-full w-full min-h-0 min-w-0 flex flex-col">
                  <PRDetail pr={openPR} cwd={active.initInfo?.cwd || sessions.find(s => s.id === activeId)?.cwd} onClose={() => setOpenPR(null)} />
                          </div>
                        );
                      }
                      case 'terminal': {
                        if (!(openTerminal && activeId)) return null;
                        return (
                          <div className="h-full w-full min-h-0 min-w-0 flex flex-col">
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
                          </div>
                        );
                      }
                      case 'diff': {
                        if (!(diffView)) return null;
                        return (
                          <div className="h-full w-full min-h-0 min-w-0 flex flex-col">
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
                        <span className="text-[10px] shrink-0" style={{ color: '#d6a85f' }}>M</span>
                        <span className="text-[12px] font-mono truncate" style={{ color: '#d6a85f' }}>{diffView.path.split('/').pop()}</span>
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
                          </div>
                        );
                      }
                      default: return null;
                    }
                  };

                  return (
                    <PanelsWorkspace
                      sessionId={wsId}
                      tabs={panelTabs}
                      renderTab={renderPanelTab}
                      onCloseTab={closePanelTab}
                      activeTabRequest={panelFocusReq}
                      suppressFocus={terminalsFocused}
                      onTabDoubleClick={(tabId) => {
                        if (activeId && tabId.startsWith('editor:')) pinEditor(activeId, tabId.slice('editor:'.length));
                      }}
                    />
                  );
                })()}
              </div>

              {/* Terminals dock — portaled here from the chat panel so it spans
                  the full content width at the bottom, below all panels and
                  outside the file explorer (VSCode-style). */}
              <div ref={setTermDockHost} tabIndex={-1} className="shrink-0 flex flex-col min-w-0 outline-none" />

              {/* Permission modal removed — shown inline in chat */}
            </>
            )}
          </div>
        </div>
        )}

        {/* Status bar */}
        <div className="flex items-center justify-between px-3 h-[22px] bg-[#131418] border-t border-border text-[11px] shrink-0 select-none">
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
        <KeyboardShortcutsModal
          open={showShortcuts}
          onClose={() => setShowShortcuts(false)}
          overrides={kbOverrides}
          onChange={persistKeybindings}
        />
        <ProjectSettingsModal
          open={projectSettings.open}
          onClose={() => setProjectSettings({ open: false })}
          tabGroups={tabGroups}
          tabGroupMap={tabGroupMap}
          autoGroupSessions={autoGroupSessions}
          onToggleAutoGroup={handleToggleAutoGroup}
          autoFocusBrowserOnAction={autoFocusBrowserOnAction}
          onToggleAutoFocusBrowserOnAction={handleToggleAutoFocusBrowserOnAction}
          interruptOnSend={interruptOnSend}
          onToggleInterruptOnSend={handleToggleInterruptOnSend}
          colorChatBySession={colorChatBySession}
          onToggleColorChatBySession={handleToggleColorChatBySession}
          tintChatBackground={tintChatBackground}
          onToggleTintChatBackground={handleToggleTintChatBackground}
          showTelegramSession={showTelegramSession}
          onToggleShowTelegramSession={(next) => {
            setShowTelegramSession(next);
            persistPrefs({ showTelegramSession: next });
          }}
          globalEnvVars={globalEnvVars}
          onChangeGlobalEnvVars={(next) => {
            setGlobalEnvVars(next);
            persistPrefs({ globalEnvVars: next });
          }}
          portlessTld={portlessTld}
          onChangePortlessTld={(next) => {
            const v = next.trim() || 'localhost';
            setPortlessTld(v);
            persistPrefs({ portlessTld: v });
          }}
          client={client}
          claudeModels={claudeModels}
          activeSessionCwd={sessions.find(s => s.id === activeId)?.cwd}
          activeSessionGroupId={activeId ? tabGroupMap[activeId] : undefined}
          onDeleteGroup={handleDeleteGroup}
          onPatchGroup={(groupId, patch) => {
            const current = tabGroups[groupId];
            if (!current) return;
            const next: TabGroupInfo = { ...current, ...patch };
            // Clean up undefined / empty-string keys so absence = "inherit from global".
            for (const k of Object.keys(patch) as (keyof TabGroupInfo)[]) {
              if (patch[k] === undefined || patch[k] === '') delete (next as unknown as Record<string, unknown>)[k as string];
            }
            const newGroups = { ...tabGroups, [groupId]: next };
            setTabGroups(newGroups);
            persistPrefs({ tabGroups: newGroups });
          }}
        />
        <PortlessActionToast />
        {tabContextMenu && (() => {
          const menu = tabContextMenu;
          const closeMenu = () => setTabContextMenu(null);
          return (
            <>
              <div className="fixed inset-0 z-[9998]" onClick={closeMenu} onContextMenu={(e) => { e.preventDefault(); closeMenu(); }} />
              <div
                role="menu"
                className="fixed z-[9999] min-w-[180px] rounded-md border border-border-light bg-surface shadow-2xl overflow-hidden text-[12px]"
                style={{ left: menu.x, top: menu.y }}
              >
                <button
                  type="button"
                  onClick={() => { setRenamingShellId(menu.shellId); closeMenu(); }}
                  className="w-full text-left px-3 py-1.5 text-zinc-200 hover:bg-surface-light flex items-center gap-2"
                >
                  <span className="w-3 h-3 inline-flex items-center justify-center text-zinc-400">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="w-3 h-3"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                  </span>
                  Rename
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (!activeId) { closeMenu(); return; }
                    if (menu.running) {
                      try { clientRef.current?.killTerminal(activeId, menu.procId); } catch {}
                    } else {
                      dismissShellPersistent(menu.procId, menu.shellId);
                    }
                    closeMenu();
                  }}
                  className="w-full text-left px-3 py-1.5 text-zinc-200 hover:bg-surface-light flex items-center gap-2"
                >
                  <span className="w-3 h-3 inline-flex items-center justify-center text-zinc-400">
                    <X className="w-3 h-3" />
                  </span>
                  {menu.running ? 'Kill shell' : 'Remove from chat'}
                </button>
              </div>
            </>
          );
        })()}
        <BypassWarningModal
          open={pendingBypassSessionId !== null}
          onCancel={() => setPendingBypassSessionId(null)}
          onConfirm={() => {
            if (pendingBypassSessionId) applyPermissionMode(pendingBypassSessionId, 'bypassPermissions');
            setPendingBypassSessionId(null);
          }}
        />
        <BrowserUrlModal
          open={browserUrlModalOpen}
          onCancel={() => setBrowserUrlModalOpen(false)}
          onConfirm={(rawName, rawUrl) => {
            setBrowserUrlModalOpen(false);
            if (!activeId) return;
            const trimmedName = rawName.trim();
            if (!trimmedName || !BROWSER_NAME_RE.test(trimmedName)) return;
            const trimmed = rawUrl.trim();
            if (!trimmed) return;
            // localhost / loopback / private IPv4 / *.local default to http;
            // everything else gets https. Kept in lockstep with
            // BrowserPanel.coerceUrlScheme.
            let next: string;
            if (/^https?:\/\//i.test(trimmed)) {
              next = trimmed;
            } else {
              const bare = trimmed.replace(/^\/\//, '');
              const host = bare.split('/')[0]!.split('?')[0]!.split('#')[0]!;
              const hostname = host.split(':')[0]!.toLowerCase();
              const isLoopbackOrPrivate =
                hostname === 'localhost' ||
                hostname === '0.0.0.0' ||
                hostname === '127.0.0.1' ||
                hostname.startsWith('127.') ||
                hostname === '::1' ||
                hostname.endsWith('.local') ||
                hostname.endsWith('.localhost') ||
                /^10\./.test(hostname) ||
                /^192\.168\./.test(hostname) ||
                /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname);
              next = `${isLoopbackOrPrivate ? 'http' : 'https'}://${bare}`;
            }
            try { new URL(next); } catch { return; }
            updateLocalState(activeId, s => ({
              ...s,
              browsers: {
                ...s.browsers,
                [trimmedName]: {
                  url: next,
                  title: trimmedName,
                  openSeq: Date.now(),
                  cookieJar: s.browsers[trimmedName]?.cookieJar ?? 'default',
                },
              },
              activeBrowserName: trimmedName,
              panelFocusTabId: 'browser:' + trimmedName,
              panelFocusSeq: s.panelFocusSeq + 1,
            }));
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
        <CtrlTabSwitcher
          open={switcher.open}
          sessions={switcher.ids.map(id => sessions.find(s => s.id === id)!).filter(Boolean)}
          selectedIdx={switcher.idx}
          sessionStates={sessionStates}
          sessionLastMessageAt={sessionLastMessageAt}
          tabGroups={tabGroups}
          tabGroupMap={tabGroupMap}
          onSelectIdx={(i) => setSwitcher(s => ({ ...s, idx: i }))}
          onCommit={() => {
            const target = switcher.ids[switcher.idx];
            setSwitcher({ open: false, idx: 0, ids: [] });
            if (target && target !== activeId) handleSelectSession(target);
          }}
          onClose={() => setSwitcher({ open: false, idx: 0, ids: [] })}
        />
        {/* Unsaved changes dialog */}
        {unsavedClosePrompt && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center" onClick={() => setUnsavedClosePrompt(false)}>
            <div className="absolute inset-0 bg-black/50" />
            <div className="relative bg-surface border border-border-light rounded-xl shadow-2xl p-5 max-w-sm w-full" onClick={e => e.stopPropagation()}>
              <h3 className="text-sm font-semibold text-zinc-200 mb-2">Unsaved Changes</h3>
              <p className="text-[13px] text-zinc-400 mb-4">
                Do you want to save changes to <span className="text-zinc-200 font-mono">{openFile?.path.split('/').pop()}</span> before closing?
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="flat" onPress={() => {
                  setUnsavedClosePrompt(false);
                  const p = activeId ? getState(activeId).activeEditorPath : null;
                  if (activeId && p) closeEditor(activeId, p);
                }}>Don't Save</Button>
                <Button variant="flat" onPress={() => setUnsavedClosePrompt(false)}>Cancel</Button>
                <Button onPress={async () => {
                  setUnsavedClosePrompt(false);
                  const p = activeId ? getState(activeId).activeEditorPath : null;
                  await handleSaveFileWrapped();
                  if (activeId && p) closeEditor(activeId, p);
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

/** Keeps the embedded BrowserView alive (and bounds-pinned) while the
 *  chat-focus layout is active and there's no `BrowserPanel` chrome to host
 *  it. The anchor div fills the focus content area so when the user flips
 *  back to standard layout — at which point the panel chrome mounts and
 *  takes over — the webview snaps cleanly into the right pane instead of
 *  being stuck at stale or zero bounds. The webview itself is hidden here
 *  (`visible: false`) so it doesn't render over the focus grid. */
function FocusBrowserAnchor(props: {
  label: string;
  url: string;
  title: string;
  openSeq: number;
  cookieJar: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  useBrowserPreviewBounds({
    hostRef,
    label: props.label,
    url: props.url,
    title: props.title,
    openSeq: props.openSeq,
    cookieJar: props.cookieJar,
    visible: false,
  });
  return (
    <div
      ref={hostRef}
      aria-hidden
      className="absolute inset-0 pointer-events-none invisible"
    />
  );
}
