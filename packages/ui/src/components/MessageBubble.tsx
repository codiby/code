import { useState, useEffect, useMemo, useRef, lazy, Suspense, memo } from 'react';
import { ChevronDown, ChevronRight, Sparkles, Copy, Check } from 'lucide-react';
import type { ChatMessage, ClaudeClient } from '../lib/claude-client';
import { Markdown } from './Markdown';
import { MobileImageViewer } from './mobile/MobileImageViewer';

const DiffEditor = lazy(() => import('@monaco-editor/react').then(m => ({ default: m.DiffEditor })));
const Editor = lazy(() => import('@monaco-editor/react').then(m => ({ default: m.default })));

interface Props {
  message: ChatMessage;
  onOpenTerminal?: (msgId: string) => void;
  isLast?: boolean;
  onAnswerAskUser?: (answers: Record<string, string>) => void;
  // Only required for interactive PTY bubbles (/terminal slash command).
  sessionId?: string;
  client?: ClaudeClient;
  /** Optional per-session accent (hex) used to tint the user message card so
   *  panes are visually distinguishable in focus mode. Falls back to the
   *  default blue when absent. */
  accent?: string;
  interactiveMinimized?: boolean;
  onToggleInteractiveMinimize?: (msgId: string) => void;
  /** Removes a queued (still-unsent) user message from the local queue.
   *  Wired by ChatApp; only fires for bubbles where `message.isPending` is true. */
  onCancelPending?: (msgId: string) => void;
  /** Re-attempts delivery of a message whose offline send timed out.
   *  Wired by ChatApp; only fires for bubbles where `deliveryStatus === 'failed'`. */
  onRetry?: (msgId: string) => void;
}

/** Short `9:41`-style clock for the hover stamp; null when we have no usable
 *  timestamp so callers can skip rendering. */
function formatMsgTime(ts?: number): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** Full date+time shown in the native tooltip on hover. */
function formatMsgTimeFull(ts: number): string {
  return new Date(ts).toLocaleString();
}

/** Timestamp that fades in when the parent `.group` is hovered. `side` picks
 *  which edge it floats off so it never reflows the bubble's own text:
 *  user bubbles show it to the left, assistant text to the right. */
function HoverTime({ ts, side }: { ts?: number; side: 'left' | 'right' }) {
  const label = formatMsgTime(ts);
  if (label === null) return null;
  const pos = side === 'left'
    ? 'right-full mr-2 top-1/2 -translate-y-1/2'
    : 'left-full ml-2 top-1/2 -translate-y-1/2';
  return (
    <span
      title={formatMsgTimeFull(ts!)}
      className={`pointer-events-none absolute ${pos} text-[11px] tabular-nums text-zinc-600 whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity`}
    >
      {label}
    </span>
  );
}

function parseTableRows(raw: string): { headers: string[]; rows: string[][] } | null {
  const lines = raw.split('\n').filter(l => l.trim());
  if (lines.length < 2) return null;
  const parse = (line: string) => line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
  const headers = parse(lines[0]!);
  // Second line must be separator (dashes)
  if (!/^[\s|:-]+$/.test(lines[1]!)) return null;
  const rows = lines.slice(2).map(parse);
  return { headers, rows };
}

/** Renders text with inline `code`, ```code blocks```, **bold**, and tables */
function FormattedText({ text, className }: { text: string; className?: string }) {
  type Part = string | { type: 'code' | 'codeblock' | 'bold' | 'table'; content: string; lang?: string };
  const parts: Part[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    // Markdown table: lines starting with |
    const tableMatch = remaining.match(/^(\|[^\n]+\|\n)(\|[-:\s|]+\|\n)((?:\|[^\n]+\|\n?)+)/);
    if (tableMatch) {
      parts.push({ type: 'table', content: tableMatch[0] });
      remaining = remaining.slice(tableMatch[0].length);
      continue;
    }

    // Code block: ```lang\n...\n```
    const blockMatch = remaining.match(/^```(\w*)\n([\s\S]*?)```/);
    if (blockMatch) {
      parts.push({ type: 'codeblock', content: blockMatch[2]!, lang: blockMatch[1] });
      remaining = remaining.slice(blockMatch[0].length);
      continue;
    }

    // Inline code: `...`
    const inlineMatch = remaining.match(/^`([^`\n]+)`/);
    if (inlineMatch) {
      parts.push({ type: 'code', content: inlineMatch[1]! });
      remaining = remaining.slice(inlineMatch[0].length);
      continue;
    }

    // Bold: **...**
    const boldMatch = remaining.match(/^\*\*([^*]+)\*\*/);
    if (boldMatch) {
      parts.push({ type: 'bold', content: boldMatch[1]! });
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    // Plain text until next special char
    const nextSpecial = remaining.slice(1).search(/[`*|]/);
    if (nextSpecial === -1) {
      parts.push(remaining);
      break;
    }
    parts.push(remaining.slice(0, nextSpecial + 1));
    remaining = remaining.slice(nextSpecial + 1);
  }

  return (
    <span className={className}>
      {parts.map((part, i) => {
        if (typeof part === 'string') {
          return <span key={i}>{part}</span>;
        }
        if (part.type === 'code') {
          return (
            <code key={i} className="bg-zinc-800 text-indigo-300 text-[12px] px-1.5 py-0.5 rounded font-mono">
              {part.content}
            </code>
          );
        }
        if (part.type === 'codeblock') {
          return (
            <pre key={i} className="bg-blue-950/40 border border-blue-900/30 rounded-md px-3 py-2 my-1.5 text-[12px] font-mono text-zinc-300 overflow-x-auto leading-snug">
              <code>{part.content}</code>
            </pre>
          );
        }
        if (part.type === 'bold') {
          return <strong key={i} className="text-zinc-100 font-semibold">{part.content}</strong>;
        }
        if (part.type === 'table') {
          const table = parseTableRows(part.content);
          if (!table) return <span key={i}>{part.content}</span>;
          return (
            <div key={i} className="my-2 overflow-x-auto rounded border border-border-light">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="bg-surface-light">
                    {table.headers.map((h, j) => (
                      <th key={j} className="px-3 py-1.5 text-left font-medium text-zinc-200 border-b border-border-light whitespace-nowrap"><FormattedText text={h} /></th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {table.rows.map((row, ri) => (
                    <tr key={ri} className="border-b border-border last:border-0 hover:bg-surface-light/30">
                      {row.map((cell, ci) => (
                        <td key={ci} className="px-3 py-1 text-zinc-400 whitespace-nowrap"><FormattedText text={cell} /></td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        return null;
      })}
    </span>
  );
}

function toolSummary(message: ChatMessage): string {
  const raw = message.toolInput;
  if (!raw) return '';
  if (typeof raw === 'string') return raw.slice(0, 80);
  const input = raw as Record<string, unknown>;
  if (Array.isArray(input.questions) && (input.questions as any)[0]?.question) {
    return String((input.questions as any)[0].question).slice(0, 80);
  }
  if (input.plan) return 'Plan';
  if (input.command) return String(input.command).slice(0, 80);
  if (input.file_path) return String(input.file_path);
  if (input.path) return String(input.path);
  if (input.pattern) return String(input.pattern).slice(0, 60);
  if (input.query) return String(input.query).slice(0, 60);
  if (input.url) return String(input.url).slice(0, 80);
  const json = JSON.stringify(input);
  return json.length > 80 ? json.slice(0, 77) + '...' : json;
}

const LANG_MAP: Record<string, string> = {
  ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact',
  py: 'python', rs: 'rust', go: 'go', json: 'json', css: 'css', html: 'html',
  md: 'markdown', sh: 'shell', bash: 'shell', yml: 'yaml', yaml: 'yaml',
  toml: 'toml', sql: 'sql', swift: 'swift', kt: 'kotlin', rb: 'ruby',
};

function langFromPath(filePath: string): string {
  const ext = filePath.split('.').pop() || '';
  return LANG_MAP[ext] || 'plaintext';
}

const MONACO_SHARED_OPTS = {
  readOnly: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  fontSize: 12,
  lineNumbers: 'off' as const,
  glyphMargin: false,
  folding: false,
  lineDecorationsWidth: 0,
  overviewRulerLanes: 0,
  scrollbar: { vertical: 'hidden' as const, horizontal: 'auto' as const },
  renderOverviewRuler: false,
  contextmenu: false,
  domReadOnly: true,
};

function CopyButton({ text, title = 'Copy' }: { text: string; title?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={copied ? 'Copied' : title}
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="shrink-0 rounded p-1 text-zinc-500 hover:text-zinc-200 hover:bg-white/5 transition-colors"
    >
      {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

function ToolBubble({ message, isLast, onAnswerAskUser }: { message: ChatMessage; isLast?: boolean; onAnswerAskUser?: (answers: Record<string, string>) => void }) {
  const input = (message.toolInput && typeof message.toolInput === 'object' ? message.toolInput : null) as Record<string, unknown> | null;
  const isEdit = message.toolName === 'Edit' && input && typeof input.old_string === 'string' && typeof input.new_string === 'string';
  const isWrite = message.toolName === 'Write' && input && typeof input.content === 'string';
  const isBash = message.toolName === 'Bash' && input && typeof input.command === 'string';
  const isPlan = message.toolName === 'ExitPlanMode' && input && typeof input.plan === 'string';
  const isAskUser = message.toolName === 'AskUserQuestion' && input && Array.isArray((input as any).questions);
  const askQuestions = isAskUser ? ((input as any).questions as { question: string; header?: string; options?: { label: string; description?: string }[] }[]) : [];
  let askAnswers: Record<string, string> | null = null;
  if (isAskUser) {
    if ((input as any).answers && typeof (input as any).answers === 'object') {
      askAnswers = (input as any).answers as Record<string, string>;
    } else if (message.toolResult?.content) {
      const content = message.toolResult.content;
      // Synthetic tool_result added by the server stores answers as JSON.
      try {
        const parsed = JSON.parse(content);
        if (parsed && typeof parsed.answers === 'object') {
          askAnswers = parsed.answers as Record<string, string>;
        }
      } catch {}
      // SDK's real tool_result is plain text in the form
      //   `User has answered your questions: "Q1"="A1" ...`
      // Fall back to a regex parse so reloaded sessions still surface answers
      // even if the synthetic was overwritten by the SDK's text result.
      if (!askAnswers) {
        const out: Record<string, string> = {};
        const re = /"([^"]+)"="([^"]+)"/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(content)) !== null) {
          out[m[1]!] = m[2]!;
        }
        if (Object.keys(out).length > 0) askAnswers = out;
      }
    }
  }
  const planContent = isPlan ? input!.plan as string : '';
  const filePath = input && typeof input.file_path === 'string' ? input.file_path as string : null;
  const lang = filePath ? langFromPath(filePath) : 'plaintext';

  const oldLines = isEdit ? (input.old_string as string).split('\n').length : 0;
  const newLines = isEdit ? (input.new_string as string).split('\n').length : 0;
  const diffHeight = isEdit ? Math.min(Math.max(oldLines, newLines) * 19 + 20, 300) : 0;
  const writeLines = isWrite ? (input.content as string).split('\n').length : 0;
  const writeHeight = isWrite ? Math.min(writeLines * 19 + 20, 250) : 0;
  // Claude's AskUserQuestion tool keys answers by question text — its
  // tool_result formatter looks up `answers[question.question]`. Submit and
  // read using question text; keep local selection state index-keyed for
  // display, and translate at the submit boundary. `customMode[i]` flips a
  // question into free-text mode where `askSelections[i]` holds the typed
  // string instead of an option label.
  const unansweredAsk = !!isAskUser && askQuestions.some(q => !askAnswers || !askAnswers[q.question]);
  const summary = toolSummary(message);
  // mockup_write result: surface a one-line bar to reopen the mockup in the
  // preview panel. Name + html come straight off the tool input; the size is
  // lifted from the result text ("… saved (5 KB).") so it matches what the
  // server reported, falling back to measuring the html.
  const isMockupWrite = /mockup_write$/.test(message.toolName || '');
  const mockupName = isMockupWrite && input && typeof input.name === 'string' ? (input.name as string) : null;
  const mockupHtml = isMockupWrite && input && typeof input.html === 'string' ? (input.html as string) : null;
  const mockupOk = isMockupWrite && !!message.toolResult && !message.toolResult.isError && !!mockupName && mockupHtml !== null;
  const mockupSize = (() => {
    if (!mockupOk) return null;
    const m = message.toolResult!.content?.match(/\(([\d.]+\s*[KMG]?B)\)/i);
    if (m) return m[1]!;
    const bytes = new Blob([mockupHtml!]).size;
    return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
  })();
  const openMockup = () => {
    if (!mockupOk) return;
    window.dispatchEvent(
      new CustomEvent('codiby-code:open-mockup', { detail: { name: mockupName, html: mockupHtml } }),
    );
  };
  // AskUserQuestion: always default to expanded when this bubble is last —
  // the user expects to see either the live form (unanswered) or the
  // preserved selection/custom text (answered) without having to click.
  const [expanded, setExpanded] = useState(!!isLast && (unansweredAsk || !!isAskUser));
  const [askSelections, setAskSelections] = useState<Record<string, string>>({});
  const [askCustomMode, setAskCustomMode] = useState<Record<string, boolean>>({});
  const canAnswer = !!onAnswerAskUser && !!isAskUser && unansweredAsk;
  const buildAskAnswers = (sels: Record<string, string>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [key, val] of Object.entries(sels)) {
      const q = askQuestions[Number(key)]?.question;
      const trimmed = val.trim();
      if (q && trimmed) out[q] = trimmed;
    }
    return out;
  };
  const handleAskSelect = (qIdx: number, label: string) => {
    if (!canAnswer) return;
    const key = String(qIdx);
    setAskCustomMode(prev => ({ ...prev, [key]: false }));
    const next = { ...askSelections, [key]: label };
    setAskSelections(next);
    if (askQuestions.length === 1) onAnswerAskUser!(buildAskAnswers(next));
  };
  const handleAskEnterCustom = (qIdx: number) => {
    if (!canAnswer) return;
    const key = String(qIdx);
    setAskCustomMode(prev => ({ ...prev, [key]: true }));
    setAskSelections(prev => ({ ...prev, [key]: '' }));
  };
  const handleAskCustomChange = (qIdx: number, text: string) => {
    const key = String(qIdx);
    setAskSelections(prev => ({ ...prev, [key]: text }));
  };
  const submitAskCustomSingle = (qIdx: number) => {
    if (!canAnswer) return;
    const key = String(qIdx);
    const val = (askSelections[key] || '').trim();
    if (!val) return;
    onAnswerAskUser!(buildAskAnswers({ [key]: val }));
  };
  const allAskAnswered = askQuestions.every((_, i) => (askSelections[String(i)] || '').trim());

  return (
    <div className="py-0.5 pl-3 ml-1 border-l-2 border-border select-none">
      <div
        className="flex items-center gap-1.5 cursor-pointer"
        onClick={() => setExpanded(e => !e)}
      >
        <span className="text-zinc-600 shrink-0">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        <span className="text-[11px] font-mono text-violet-400">{message.toolName}</span>
        {!expanded && summary && (
          <span className="text-[11px] text-zinc-600 font-mono truncate max-w-md">{summary}</span>
        )}
        {message.autoApproved && (
          <span
            className="ml-auto shrink-0 text-[9px] uppercase tracking-wider text-emerald-400/80 bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 rounded font-mono"
            title="Auto-approved by the current permission mode"
          >
            auto
          </span>
        )}
      </div>
      {mockupOk && (
        <button
          type="button"
          onClick={openMockup}
          title={`Open mockup "${mockupName}" in preview`}
          className="mt-1.5 w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-dashed border-violet-500/35 bg-violet-500/[0.04] hover:bg-violet-500/10 transition-colors text-left"
        >
          <span className="text-[12px] text-violet-400 shrink-0 leading-none">▣</span>
          <span className="text-[12px] font-medium text-violet-200 font-mono truncate">{mockupName}</span>
          {mockupSize && <span className="text-[11px] text-zinc-500 shrink-0">· {mockupSize}</span>}
          <span className="ml-auto flex items-center gap-0.5 text-[11px] text-violet-300 shrink-0">
            Open in preview
            <ChevronRight size={12} />
          </span>
        </button>
      )}
      {expanded && (
        <div className="mt-1">
          {filePath && (
            <p className="text-[10px] text-zinc-500 font-mono mb-1 truncate">{filePath}</p>
          )}

          {isEdit && (
            <div className="rounded overflow-hidden border border-border mb-1" style={{ height: diffHeight }}>
              <Suspense fallback={<div className="p-2 text-[11px] text-zinc-600">Loading diff...</div>}>
                <DiffEditor
                  original={input.old_string as string}
                  modified={input.new_string as string}
                  language={lang}
                  theme="vs-dark"
                  options={{ ...MONACO_SHARED_OPTS, renderSideBySide: true }}
                />
              </Suspense>
            </div>
          )}

          {isWrite && (
            <div className="rounded overflow-hidden border border-border mb-1" style={{ height: writeHeight }}>
              <Suspense fallback={<div className="p-2 text-[11px] text-zinc-600">Loading editor...</div>}>
                <Editor
                  value={(input.content as string).slice(0, 10000)}
                  language={lang}
                  theme="vs-dark"
                  options={{ ...MONACO_SHARED_OPTS, lineNumbers: 'on' }}
                />
              </Suspense>
            </div>
          )}

          {isBash && (
            <div className="group relative rounded bg-[#0d0d0d] border border-border mb-1 px-3 py-2">
              <div className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <CopyButton text={input.command as string} title="Copy command" />
              </div>
              <pre className="text-[12px] font-mono text-green-400 whitespace-pre-wrap break-all m-0 leading-snug pr-7 select-text cursor-text">
                <span className="text-zinc-600 select-none">$ </span>{input.command as string}
              </pre>
            </div>
          )}

          {isPlan && (
            <div className="rounded border border-violet-500/30 bg-violet-500/[0.03] mb-1 px-3 py-2 max-h-[400px] overflow-y-auto">
              <Markdown text={planContent} />
            </div>
          )}

          {isAskUser && (
            <div className="space-y-2 mb-1">
              {askQuestions.map((q, i) => {
                const key = String(i);
                const isCustom = canAnswer && askCustomMode[key] === true;
                const answer = askAnswers ? askAnswers[q.question] : undefined;
                // When showing a saved/finalized answer, surface a free-text
                // answer that doesn't match any option label so the user can
                // see what they typed.
                const customDisplayAnswer =
                  !canAnswer && answer && !(q.options || []).some(o => o.label === answer)
                    ? answer
                    : null;
                return (
                  <div key={i}>
                    {q.header && (
                      <span className="inline-block text-[10px] font-semibold text-violet-400 bg-violet-400/10 px-1.5 py-0.5 rounded mb-1">
                        {q.header}
                      </span>
                    )}
                    <p className="text-[12px] text-zinc-300 leading-relaxed mb-1">{q.question}</p>
                    {q.options && q.options.length > 0 && (
                      <div className="space-y-0.5">
                        {q.options.map((opt, j) => {
                          const selected = canAnswer
                            ? !isCustom && askSelections[key] === opt.label
                            : answer === opt.label;
                          const baseCls = `w-full text-left px-2 py-1 rounded border text-[11px] transition-colors ${
                            selected
                              ? 'border-violet-400/50 bg-violet-500/10'
                              : canAnswer
                                ? 'border-border/60 bg-transparent hover:border-zinc-600 hover:bg-surface-light/50'
                                : 'border-border/60 bg-transparent'
                          }`;
                          const inner = (
                            <div className="flex items-start gap-2">
                              <span className={`w-3 h-3 rounded-full border flex items-center justify-center shrink-0 mt-0.5 ${selected ? 'border-violet-400' : 'border-zinc-700'}`}>
                                {selected && <span className="w-1.5 h-1.5 rounded-full bg-violet-400" />}
                              </span>
                              <div className="min-w-0">
                                <span className={`${selected ? 'text-zinc-200 font-medium' : 'text-zinc-400'}`}>{opt.label}</span>
                                {opt.description && <p className="text-[10px] text-zinc-600 mt-0.5 leading-snug">{opt.description}</p>}
                              </div>
                            </div>
                          );
                          return canAnswer ? (
                            <button key={j} type="button" onClick={() => handleAskSelect(i, opt.label)} className={baseCls}>
                              {inner}
                            </button>
                          ) : (
                            <div key={j} className={baseCls}>{inner}</div>
                          );
                        })}
                        {canAnswer && (isCustom ? (
                          <div className="flex items-stretch gap-1">
                            <input
                              autoFocus
                              type="text"
                              value={askSelections[key] || ''}
                              onChange={(e) => handleAskCustomChange(i, e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && askQuestions.length === 1) {
                                  e.preventDefault();
                                  submitAskCustomSingle(i);
                                } else if (e.key === 'Escape') {
                                  e.preventDefault();
                                  setAskCustomMode(prev => ({ ...prev, [key]: false }));
                                  setAskSelections(prev => ({ ...prev, [key]: '' }));
                                }
                              }}
                              placeholder="Type your own answer…"
                              className="flex-1 px-2 py-1 rounded border border-violet-400/50 bg-violet-500/10 text-[11px] text-zinc-100 placeholder:text-zinc-500 outline-none"
                            />
                            {askQuestions.length === 1 && (
                              <button
                                type="button"
                                disabled={!(askSelections[key] || '').trim()}
                                onClick={() => submitAskCustomSingle(i)}
                                className="px-3 rounded text-[11px] bg-violet-600/20 text-violet-300 hover:bg-violet-600/30 disabled:opacity-40 transition-colors"
                              >
                                Send
                              </button>
                            )}
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleAskEnterCustom(i)}
                            className="w-full text-left px-2 py-1 rounded border border-dashed border-border/60 text-[11px] text-zinc-500 hover:text-zinc-300 hover:border-zinc-600 transition-colors"
                          >
                            + Other (write your own answer)
                          </button>
                        ))}
                      </div>
                    )}
                    {customDisplayAnswer && (
                      <div className="mt-1 px-2 py-1 rounded border border-violet-400/40 bg-violet-500/5 text-[11px] text-zinc-300">
                        <span className="text-zinc-500">Custom: </span>{customDisplayAnswer}
                      </div>
                    )}
                  </div>
                );
              })}
              {canAnswer && askQuestions.length > 1 && (
                <button
                  type="button"
                  disabled={!allAskAnswered}
                  onClick={() => onAnswerAskUser!(buildAskAnswers(askSelections))}
                  className="px-3 py-1 rounded text-[12px] bg-violet-600/15 text-violet-400 hover:bg-violet-600/25 transition-colors disabled:opacity-40"
                >
                  Submit answers
                </button>
              )}
            </div>
          )}

          {!isEdit && !isWrite && !isBash && !isPlan && !isAskUser && !!message.toolInput && (
            <pre className="text-[11px] text-zinc-600 whitespace-pre-wrap break-all m-0 bg-transparent p-0 max-h-24 overflow-auto leading-tight">
              {typeof message.toolInput === 'string'
                ? message.toolInput
                : JSON.stringify(message.toolInput, null, 2)}
            </pre>
          )}

          {message.toolResult && !isAskUser && (
            <div className={`mt-1.5 rounded border ${message.toolResult.isError ? 'border-red-500/30 bg-red-950/10' : 'border-border bg-surface/40'} overflow-hidden`}>
              <div className={`text-[10px] font-mono px-2 py-0.5 ${message.toolResult.isError ? 'text-red-400' : 'text-zinc-500'} border-b ${message.toolResult.isError ? 'border-red-500/20' : 'border-border'}`}>
                {message.toolResult.isError ? 'error' : 'result'}
              </div>
              <pre className="text-[11px] font-mono text-zinc-400 whitespace-pre-wrap break-all m-0 px-2 py-1.5 max-h-64 overflow-auto leading-snug">
                {message.toolResult.content}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const ANSI_COLORS: Record<number, string> = {
  30: '#6b7280', 31: '#ef4444', 32: '#22c55e', 33: '#eab308', 34: '#3b82f6',
  35: '#a855f7', 36: '#06b6d4', 37: '#d4d4d8', 39: '',
  90: '#71717a', 91: '#f87171', 92: '#4ade80', 93: '#facc15', 94: '#60a5fa',
  95: '#c084fc', 96: '#22d3ee', 97: '#f4f4f5',
};

export function AnsiText({ text }: { text: string }) {
  const parts = useMemo(() => {
    // Strip non-SGR ANSI sequences (cursor movement, screen clear, etc.)
    // eslint-disable-next-line no-control-regex
    const cleaned = text.replace(/\x1b\[[0-9;]*[A-HJKSTfhln]/g, '').replace(/\x1b\[\?[0-9;]*[hl]/g, '').replace(/\r/g, '');
    const result: { text: string; color?: string; bold?: boolean; dim?: boolean }[] = [];
    // eslint-disable-next-line no-control-regex
    const re = /\x1b\[([0-9;]*)m/g;
    let lastIndex = 0;
    let color: string | undefined;
    let bold = false;
    let dim = false;

    let match;
    while ((match = re.exec(cleaned)) !== null) {
      if (match.index > lastIndex) {
        result.push({ text: cleaned.slice(lastIndex, match.index), color, bold, dim });
      }
      const codes = match[1]!.split(';').map(Number);
      for (const code of codes) {
        if (code === 0) { color = undefined; bold = false; dim = false; }
        else if (code === 1) bold = true;
        else if (code === 2) dim = true;
        else if (code === 22) { bold = false; dim = false; }
        else if (ANSI_COLORS[code] !== undefined) color = ANSI_COLORS[code] || undefined;
      }
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < cleaned.length) {
      result.push({ text: cleaned.slice(lastIndex), color, bold, dim });
    }
    return result;
  }, [text]);

  return (
    <>
      {parts.map((p, i) => (
        <span
          key={i}
          style={{
            color: p.color,
            fontWeight: p.bold ? 700 : undefined,
            opacity: p.dim ? 0.6 : undefined,
          }}
        >
          {p.text}
        </span>
      ))}
    </>
  );
}

function openTerminalWindow(command: string, content: string, exitCode?: number) {
  const running = exitCode === undefined;
  // Strip ANSI for plain text, but keep for the HTML version
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>$ ${command}</title>
<style>
  body { margin: 0; background: #1b1b1b; color: #a1a1aa; font-family: 'SF Mono','Fira Code',monospace; font-size: 13px; }
  .header { padding: 8px 12px; background: #2a2a2a; border-bottom: 1px solid #333; display: flex; align-items: center; gap: 8px; position: sticky; top: 0; }
  .cmd { color: #e4e4e7; }
  .status { font-size: 11px; }
  .ok { color: #4ade80; } .fail { color: #f87171; } .run { color: #fbbf24; }
  pre { margin: 0; padding: 12px; white-space: pre-wrap; word-break: break-all; line-height: 1.5; }
</style></head><body>
<div class="header"><span style="color:#71717a;font-size:11px">$</span><span class="cmd">${command.replace(/</g, '&lt;')}</span>
${running ? '<span class="status run">running...</span>' : exitCode === 0 ? '<span class="status ok">exit 0</span>' : `<span class="status fail">exit ${exitCode}</span>`}
</div><pre>${content.replace(/</g, '&lt;')}</pre></body></html>`;
  const win = window.open('', '_blank', 'width=800,height=600');
  if (win) { win.document.write(html); win.document.close(); }
}

function TerminalBubble({ message, onOpenInPanel }: { message: ChatMessage; onOpenInPanel?: (msgId: string) => void }) {
  const running = message.exitCode === undefined;
  const [collapsed, setCollapsed] = useState(!running && message.content.length > 0);
  const termRef = useRef<HTMLPreElement>(null);

  // Auto-collapse when done
  const prevRunning = useRef(running);
  if (prevRunning.current && !running) {
    prevRunning.current = false;
  }

  // Auto-scroll terminal output to bottom
  useEffect(() => {
    if (!termRef.current || collapsed) return;
    const el = termRef.current;
    // Use rAF to scroll after the DOM has painted the new content
    const raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [message.content, collapsed]);

  return (
    <div className="py-1">
      <div className="rounded-lg border border-border-light overflow-hidden">
        <div
          className="flex items-center gap-2 px-3 py-1.5 bg-surface-light border-b border-border-light cursor-pointer select-none"
          onClick={() => setCollapsed(c => !c)}
        >
          <span className="text-zinc-500 shrink-0">
            {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          </span>
          <span className="text-[10px] text-zinc-500">$</span>
          <span className="text-[12px] font-mono text-zinc-200 flex-1 truncate">{message.terminalCommand}</span>
          {running && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" />}
          {!running && message.exitCode === 0 && <span className="text-[10px] text-green-400 shrink-0">exit 0</span>}
          {!running && message.exitCode !== 0 && <span className="text-[10px] text-red-400 shrink-0">exit {message.exitCode}</span>}
          {onOpenInPanel && (
            <button
              className="text-zinc-600 hover:text-zinc-300 text-[11px] shrink-0 px-1"
              onClick={(e) => { e.stopPropagation(); onOpenInPanel(message.id); }}
              title="Open in panel"
            >
              &#x2197;
            </button>
          )}
        </div>
        {!collapsed && (
          <>
            {message.content && (
              <pre ref={termRef} className="px-3 py-2 text-[12px] font-mono text-zinc-400 whitespace-pre-wrap break-all leading-snug max-h-64 overflow-auto m-0 bg-transparent">
                <AnsiText text={message.content} />
                {running && <span className="inline-block w-1.5 h-3 bg-zinc-500/60 animate-pulse ml-0.5 align-text-bottom" />}
              </pre>
            )}
            {!message.content && running && (
              <div className="px-3 py-2 text-[11px] text-zinc-600">Running...</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Agent tool call card — groups sub-tools inside a collapsible card */
export function AgentBubble({ agent, children, onOpenTerminal }: { agent: ChatMessage; children: ChatMessage[]; onOpenTerminal?: (msgId: string) => void }) {
  const [expanded, setExpanded] = useState(true);
  const input = (agent.toolInput && typeof agent.toolInput === 'object' ? agent.toolInput : {}) as Record<string, unknown>;
  const description = (input.description as string) || (input.prompt as string)?.slice(0, 80) || 'Agent';
  const running = !agent.toolResult;
  const grouped = collapseToolRuns(children);

  return (
    <div className="py-1">
      <div className="rounded-lg border border-cyan-500/20 overflow-hidden bg-cyan-500/[0.03]">
        {/* Header */}
        <div
          className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none"
          onClick={() => setExpanded(e => !e)}
        >
          <span className="text-zinc-500 shrink-0">
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
          <span className="text-[11px] font-mono font-medium text-cyan-400">Agent</span>
          <span className="text-[11px] text-zinc-400 truncate flex-1">{description}</span>
          {running && (
            <span
              className="w-3 h-3 rounded-full border border-cyan-500/40 border-t-cyan-300 animate-spin shrink-0"
              aria-label="Agent running"
            />
          )}
          {children.length > 0 && (
            <span className="text-[10px] text-zinc-600 bg-surface-light px-1.5 py-0.5 rounded-full shrink-0">
              {children.length} tool{children.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>

        {/* Sub-tools */}
        {expanded && grouped.length > 0 && (
          <div className="border-t border-cyan-500/10 px-2 py-1 space-y-0">
            {grouped.map((item, idx) => {
              if ('toolRun' in item) {
                const hasContentAfter = idx < grouped.length - 1;
                return (
                  <ToolRunBubble
                    key={item.items[0]!.id}
                    group={item}
                    onOpenTerminal={onOpenTerminal}
                    hasContentAfter={hasContentAfter}
                  />
                );
              }
              const msg = item as ChatMessage;
              return <MessageBubble key={msg.id} message={msg} onOpenTerminal={onOpenTerminal} />;
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export type ToolRunGroup = { toolRun: true; items: ChatMessage[] };
export type GroupedItem =
  | ChatMessage
  | { agent: ChatMessage; children: ChatMessage[] }
  | ToolRunGroup;

const NEVER_COLLAPSE = new Set([
  'Agent', 'AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode', 'TodoWrite',
  'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList',
]);

/** Folds runs of ≥ 2 consecutive tool_use messages (any tool names) into a
 *  single ToolRunGroup card. Agent groups, plain assistant/user messages, and
 *  tools in NEVER_COLLAPSE pass through. */
export function collapseToolRuns<T extends GroupedItem | ChatMessage>(items: T[]): (T | ToolRunGroup)[] {
  const out: (T | ToolRunGroup)[] = [];
  let i = 0;
  const isCollapsibleTool = (it: T) =>
    !('agent' in (it as object)) &&
    !('toolRun' in (it as object)) &&
    !!(it as ChatMessage).toolName &&
    !(it as ChatMessage).isToolResult &&
    !NEVER_COLLAPSE.has((it as ChatMessage).toolName!);
  while (i < items.length) {
    const item = items[i]!;
    if (isCollapsibleTool(item)) {
      const run: ChatMessage[] = [item as ChatMessage];
      let j = i + 1;
      while (j < items.length && isCollapsibleTool(items[j]!)) {
        run.push(items[j] as ChatMessage);
        j++;
      }
      if (run.length >= 2) {
        out.push({ toolRun: true, items: run });
        i = j;
        continue;
      }
    }
    out.push(item);
    i++;
  }
  return out;
}

function toolNounPlural(toolName: string, n: number): string {
  switch (toolName) {
    case 'Read': return `${n} file${n === 1 ? '' : 's'}`;
    case 'Edit': return `${n} edit${n === 1 ? '' : 's'}`;
    case 'Write': return `${n} file${n === 1 ? '' : 's'}`;
    case 'Bash': return `${n} command${n === 1 ? '' : 's'}`;
    case 'Grep': return `${n} search${n === 1 ? '' : 'es'}`;
    case 'Glob': return `${n} pattern${n === 1 ? '' : 's'}`;
    case 'WebFetch': return `${n} URL${n === 1 ? '' : 's'}`;
    case 'WebSearch': return `${n} quer${n === 1 ? 'y' : 'ies'}`;
    case 'ToolSearch': return `${n} lookup${n === 1 ? '' : 's'}`;
    case 'NotebookEdit': return `${n} edit${n === 1 ? '' : 's'}`;
    default: return `${n}×`;
  }
}

/** Builds the collapsed-card label. Single-type runs render as
 *  "<ToolName> <N noun>" ("Read 3 files"); mixed runs collapse to a generic
 *  "<N> tools" so the bar stays compact. */
export function toolRunSummary(items: ChatMessage[]): { name: string | null; label: string } {
  const names = new Set(items.map(m => m.toolName!).filter(Boolean));
  if (names.size === 1) {
    const tn = items[0]!.toolName!;
    return { name: tn, label: toolNounPlural(tn, items.length) };
  }
  return { name: null, label: `${items.length} tools` };
}

export function ToolRunBubble({
  group,
  onOpenTerminal,
  sessionId,
  client,
  hasContentAfter,
}: {
  group: ToolRunGroup;
  onOpenTerminal?: (msgId: string) => void;
  sessionId?: string;
  client?: ClaudeClient;
  /** True once an assistant text message (or any later item) follows this
   *  group — used to auto-collapse once the agent moves past the tool phase.
   *  The user can still re-expand manually after that. */
  hasContentAfter?: boolean;
}) {
  // Default expanded while this is the latest activity. We auto-collapse the
  // first time content arrives after the group (assistant text, user reply, a
  // following Agent card). After that, the user owns the toggle — we don't
  // auto-toggle again, so re-expanding after the auto-collapse sticks.
  const [expanded, setExpanded] = useState(!hasContentAfter);
  const autoCollapsedRef = useRef(false);
  useEffect(() => {
    if (hasContentAfter && !autoCollapsedRef.current) {
      autoCollapsedRef.current = true;
      setExpanded(false);
    }
  }, [hasContentAfter]);

  const { name, label } = toolRunSummary(group.items);
  const anyError = group.items.some(m => m.toolResult?.isError);
  const anyRunning = group.items.some(m => !m.toolResult);

  return (
    <div className="py-1">
      <div className="rounded-lg border border-violet-500/20 overflow-hidden bg-violet-500/[0.03]">
        <div
          className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none"
          onClick={() => setExpanded(e => !e)}
        >
          <span className="text-zinc-500 shrink-0">
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
          {name ? (
            <>
              <span className="text-[11px] font-mono font-medium text-violet-400 shrink-0">{name}</span>
              <span className="text-[11px] text-zinc-400 truncate flex-1">{label}</span>
            </>
          ) : (
            <span className="text-[11px] font-mono font-medium text-violet-400 truncate flex-1">{label}</span>
          )}
          {anyRunning && (
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" />
          )}
          {anyError && (
            <span className="text-[9px] uppercase tracking-wider text-red-400/80 bg-red-500/10 border border-red-500/20 px-1.5 py-0.5 rounded font-mono shrink-0">
              error
            </span>
          )}
        </div>
        {expanded && (
          <div className="border-t border-violet-500/10 px-2 py-1 space-y-0">
            {group.items.map(m => (
              <MessageBubble
                key={m.id}
                message={m}
                onOpenTerminal={onOpenTerminal}
                sessionId={sessionId}
                client={client}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Groups flat messages: Agent tool_use + everything produced by its
 *  sub-agent becomes a single group. Also attaches each tool_result to the
 *  tool_use that produced it (by id), so results render inside the tool card
 *  instead of as a separate bubble.
 *
 *  Grouping key: `parentToolUseId`. Every message the SDK emits on behalf of
 *  a sub-agent is tagged with the parent Agent's `tool_use` id; we collect
 *  those under the Agent card. This replaces a positional heuristic that
 *  stopped at the first non-tool message, which lost every tool call after
 *  the sub-agent's first tool result (results are rendered as plain
 *  assistant messages with no `toolName`, terminating the old loop). */
export function groupMessages(messages: ChatMessage[]): (ChatMessage | { agent: ChatMessage; children: ChatMessage[] })[] {
  // Index tool results by the id of the tool_use they answer.
  const resultByToolId = new Map<string, ChatMessage>();
  for (const m of messages) {
    if (m.isToolResult && m.toolUseId) resultByToolId.set(m.toolUseId, m);
  }
  const attach = (msg: ChatMessage): ChatMessage => {
    if (!msg.toolName) return msg;
    const res = resultByToolId.get(msg.id);
    return res ? { ...msg, toolResult: res } : msg;
  };

  // Set of Agent tool_use ids that are live in this window. A message is a
  // sub-agent message iff its parentToolUseId is in this set. (Scoping to the
  // visible window avoids accidentally folding bubbles into an older Agent
  // card that happens to share a reused id.)
  const agentIds = new Set<string>();
  for (const m of messages) {
    if (m.toolName === 'Agent') agentIds.add(m.id);
  }

  const result: (ChatMessage | { agent: ChatMessage; children: ChatMessage[] })[] = [];
  const groupByAgentId = new Map<string, { agent: ChatMessage; children: ChatMessage[] }>();

  for (const raw of messages) {
    const msg = attach(raw);

    // Skip tool_result messages that were paired with a tool_use above;
    // they're rendered inside that card via `attach()`.
    if (msg.isToolResult && msg.toolUseId && resultByToolId.has(msg.toolUseId)) {
      continue;
    }

    // Sub-agent message: nest under its Agent parent if we've seen one.
    const parentId = msg.parentToolUseId;
    if (parentId && agentIds.has(parentId)) {
      const group = groupByAgentId.get(parentId);
      if (group) {
        group.children.push(msg);
        continue;
      }
      // Parent Agent message hasn't been processed yet (shouldn't happen
      // given the SDK emits the Agent tool_use before its sub-agent output,
      // but fall through defensively and render as a top-level bubble).
    }

    if (msg.toolName === 'Agent') {
      const group: { agent: ChatMessage; children: ChatMessage[] } = { agent: msg, children: [] };
      groupByAgentId.set(msg.id, group);
      result.push(group);
      continue;
    }

    result.push(msg);
  }

  return result;
}

function ThinkingBubble({ message }: { message: ChatMessage }) {
  const [open, setOpen] = useState(false);
  const redacted = !!message.thinkingRedacted;
  const Chevron = open ? ChevronDown : ChevronRight;
  const text = message.content || '';
  const firstLine = text.split('\n').find((l) => l.trim()) ?? '';
  const preview = firstLine.length > 90 ? firstLine.slice(0, 89) + '…' : firstLine;
  return (
    <div className="py-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="group flex w-full items-start gap-1.5 text-left text-[12px] text-zinc-500 hover:text-zinc-300 transition-colors"
      >
        <Chevron className="w-3.5 h-3.5 mt-0.5 shrink-0 opacity-70 group-hover:opacity-100" />
        <Sparkles className="w-3 h-3 mt-1 shrink-0 opacity-60" />
        <span className="font-medium uppercase tracking-wide text-[10px] mt-0.5 shrink-0">
          {redacted ? 'Encrypted thought' : 'Thought'}
        </span>
        {!open && preview && (
          <span className="ml-1 truncate italic text-zinc-500/80">{preview}</span>
        )}
      </button>
      {open && (
        <div className="mt-1 ml-5 pl-2.5 border-l border-zinc-800/80">
          {redacted ? (
            <p className="text-[12px] italic text-zinc-500 leading-relaxed">
              {text}
            </p>
          ) : (
            <Markdown
              text={text}
              className="text-[12px] italic text-zinc-400 leading-relaxed"
            />
          )}
        </div>
      )}
    </div>
  );
}

export const MessageBubble = memo(function MessageBubble({ message, onOpenTerminal, isLast, onAnswerAskUser, sessionId, client, accent, interactiveMinimized, onToggleInteractiveMinimize, onCancelPending, onRetry }: Props) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const isToolUse = !!message.toolName;
  const isThinking = !!message.isThinking;
  // Local fullscreen image-viewer state — only the bubbles that contain
  // clickable images ever set this, but it lives at the top so any branch
  // can render the (portal-mounted) viewer next to its main content.
  const [viewerSrc, setViewerSrc] = useState<string | null>(null);
  const viewer = <MobileImageViewer src={viewerSrc} onClose={() => setViewerSrc(null)} />;

  // Interactive terminals are a first-class resource rendered only in the
  // terminals dock (desktop) / shells list (mobile) — never inline here.

  if (message.isTerminal) {
    return <TerminalBubble message={message} onOpenInPanel={onOpenTerminal} />;
  }

  if (isSystem) {
    if (message.images && message.images.length > 0) {
      return (
        <>
          <div className="flex flex-col items-center gap-1.5 py-2 px-2">
            <div className="flex flex-wrap gap-1.5 justify-center">
              {message.images.map((img, i) => {
                const src = `data:${img.media_type};base64,${img.data}`;
                return (
                  <img
                    key={i}
                    src={src}
                    alt=""
                    onClick={() => setViewerSrc(src)}
                    className="max-h-72 rounded border border-zinc-800 object-contain cursor-zoom-in"
                  />
                );
              })}
            </div>
            {message.content && (
              <span className="text-[11px] text-zinc-500 text-center max-w-[75%]">{message.content}</span>
            )}
          </div>
          {viewer}
        </>
      );
    }
    return (
      <div className="flex items-center gap-2 py-1.5 px-2">
        <div className="h-px flex-1 bg-surface" />
        <span className="text-[11px] text-zinc-600 shrink-0">{message.content}</span>
        {message.costUsd != null && (
          <span className="text-[11px] text-zinc-600">${message.costUsd.toFixed(4)}</span>
        )}
        {message.durationMs != null && (
          <span className="text-[11px] text-zinc-600">{(message.durationMs / 1000).toFixed(1)}s</span>
        )}
        {message.usage && (
          <span className="text-[11px] text-zinc-600">
            {message.usage.input_tokens + message.usage.output_tokens} tok
          </span>
        )}
        <div className="h-px flex-1 bg-surface" />
      </div>
    );
  }

  if (isToolUse) {
    return <ToolBubble message={message} isLast={isLast} onAnswerAskUser={onAnswerAskUser} />;
  }

  if (isThinking) {
    return <ThinkingBubble message={message} />;
  }

  if (isUser) {
    const pending = !!message.isPending;
    const sending = message.deliveryStatus === 'sending';
    const failed = message.deliveryStatus === 'failed';
    const dim = pending || sending;
    return (
      <>
      <div className="flex justify-end py-1">
        <div className="group relative max-w-[75%]">
          <HoverTime ts={message.timestamp} side="left" />
          <div
            style={accent ? {
              backgroundColor: `${accent}26`,
              ...(dim ? { borderColor: `${accent}66` } : {}),
            } : undefined}
            className={`rounded-2xl rounded-br-sm px-3.5 py-2 transition-opacity ${
              accent ? '' : 'bg-blue-600/15'
            } ${
              dim ? `opacity-50 border border-dashed ${accent ? '' : 'border-blue-500/40'}` : ''
            } ${
              failed ? 'border border-red-500/50' : ''
            }`}
          >
            {message.images && message.images.length > 0 && (
              <div className="flex gap-1.5 flex-wrap mb-1.5">
                {message.images.map((img, i) => {
                  const src = `data:${img.media_type};base64,${img.data}`;
                  return (
                    <img
                      key={i}
                      src={src}
                      alt=""
                      onClick={() => setViewerSrc(src)}
                      className="max-h-40 rounded border border-blue-900/30 object-cover cursor-zoom-in"
                    />
                  );
                })}
              </div>
            )}
            {message.content && (
              <Markdown text={message.content} className="text-[13px] text-zinc-200 leading-relaxed" />
            )}
            {pending && (
              <div className="mt-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-blue-300/70">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-400/60 animate-pulse" />
                Queued
              </div>
            )}
            {sending && (
              <div className="mt-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-blue-300/70">
                <span className="inline-block w-2.5 h-2.5 rounded-full border border-blue-300/60 border-t-transparent animate-spin" />
                Sending…
              </div>
            )}
            {failed && (
              <div className="mt-1 flex items-center gap-2 text-[10px] uppercase tracking-wide text-red-300/80">
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-400/70" />
                  Not delivered
                </span>
                {onRetry && (
                  <button
                    type="button"
                    onClick={() => onRetry(message.id)}
                    className="rounded-full px-2 py-0.5 bg-red-500/15 hover:bg-red-500/25 text-red-200 border border-red-500/40 transition-colors normal-case tracking-normal"
                    title="Retry sending"
                  >
                    Retry
                  </button>
                )}
              </div>
            )}
          </div>
          {pending && onCancelPending && (
            <button
              type="button"
              onClick={() => onCancelPending(message.id)}
              className="absolute -top-1.5 -left-1.5 w-5 h-5 rounded-full bg-zinc-950 border border-blue-500/40 text-blue-300/80 hover:text-blue-100 hover:bg-zinc-900 flex items-center justify-center text-[11px] leading-none opacity-0 group-hover:opacity-100 transition-opacity"
              aria-label="Cancel queued message"
              title="Cancel queued message"
            >
              ×
            </button>
          )}
        </div>
      </div>
      {viewer}
      </>
    );
  }

  // Assistant
  const assistantTime = formatMsgTime(message.timestamp);
  return (
    <div className="group relative py-1">
      {assistantTime !== null && (
        <span
          title={formatMsgTimeFull(message.timestamp)}
          className="pointer-events-none absolute top-1 right-0 text-[11px] tabular-nums text-zinc-600 whitespace-nowrap bg-zinc-950/80 px-1 rounded opacity-0 group-hover:opacity-100 transition-opacity"
        >
          {assistantTime}
        </span>
      )}
      <Markdown text={message.content} className="text-[13px] text-zinc-300 leading-relaxed" />
    </div>
  );
});
