/**
 * A sub-agent's whole conversation, brought to the front.
 *
 * Same window shell as ToolSteps' output window (overlay, 960px card, 40px
 * header, "Send to chat" composer). The transcript renders with the chat's own
 * components — groupMessages + collapseToolRuns + MessageBubble/ToolRunBubble —
 * so it reads exactly like the main thread.
 *
 * It also shows an agent from inside a workflow (`workflowAgent`): the SDK
 * never streams those, so their chat is polled from the bridge, which reads
 * the run's transcript files. They cannot be stopped one by one — only their
 * workflow can — so the window offers no Stop for them.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDownToLine, Bot, CornerDownRight, Square, X } from 'lucide-react';
import type { ChatMessage, ClaudeClient, SubagentTask } from '../lib/claude-client';
import {
  formatElapsed, formatTokens, isTaskRunning, taskElapsedMs, taskKindLabel, taskTitle, useNow, usePageVisible, useTaskTranscript,
  useWorkflowAgentTranscript, windowTakesEscape, workflowAgentTask,
} from '../lib/subagents';
import { AgentBubble, MessageBubble, ToolRunBubble, collapseToolRuns, groupMessages, shortToolName } from './MessageBubble';

interface Props {
  task: SubagentTask;
  client: ClaudeClient | null;
  sessionId: string | null;
  messages: ChatMessage[];
  onClose: () => void;
  /** Absent for a workflow's inner agent: only the whole workflow can be stopped. */
  onStop?: () => void;
  onBackground?: () => void;
  /** Set when `task` stands for an agent inside this workflow (see workflowAgentTask). */
  workflowAgent?: { workflow: SubagentTask; agentId: string } | null;
}

const STATUS_PILL: Record<string, string> = {
  running: 'text-cyan-300 border-cyan-500/35 bg-cyan-500/10',
  completed: 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10',
  failed: 'text-rose-300 border-rose-500/30 bg-rose-500/10',
};

function sendToChat(text: string) {
  window.dispatchEvent(new CustomEvent('codiby-code:send-message', { detail: { text } }));
}

export function AgentChatWindow({ task: given, client, sessionId, messages, onClose, onStop, onBackground, workflowAgent = null }: Props) {
  const inner = workflowAgent;
  const sdk = useTaskTranscript(client, sessionId, inner ? null : given, messages);
  // Polling pauses while the app is hidden; the next read picks up the tail.
  const polled = useWorkflowAgentTranscript(client, sessionId, inner, usePageVisible());
  // A workflow agent's own poll carries its freshest numbers and its brief.
  const task = inner && polled.agent
    ? workflowAgentTask(polled.agent, inner.workflow, polled.prompt)
    : inner ? { ...given, prompt: polled.prompt ?? given.prompt } : given;
  const { messages: transcript, loading, error } = inner ? polled : sdk;
  const running = isTaskRunning(task);
  const now = useNow(running);
  const origin = inner ? 'the workflow' : 'the main agent';
  const [promptOpen, setPromptOpen] = useState(false);
  const promptRef = useRef<HTMLPreElement>(null);
  const [promptClipped, setPromptClipped] = useState(false);
  // Offer "Show full prompt" only when the collapsed prompt actually overflows.
  useLayoutEffect(() => {
    const el = promptRef.current;
    if (el && !promptOpen) setPromptClipped(el.scrollHeight > el.clientHeight + 2);
  }, [task.prompt, promptOpen]);
  const [note, setNote] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  // Esc closes — captured so it doesn't also stop the main turn, but only
  // when it is meant for this window (see windowTakesEscape). Registered once:
  // the panel re-renders every second with a fresh `onClose`.
  const rootRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!windowTakesEscape(e, rootRef.current)) return;
      e.stopPropagation();
      e.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Follow the tail while the agent works, unless the reader scrolled up.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [transcript.length, running]);

  const grouped = useMemo(() => collapseToolRuns(groupMessages(
    // Rendered standalone, so drop the parent link: otherwise the bubbles
    // would try to nest under an Agent card that is not in this list.
    transcript.map(m => (m.parentToolUseId ? { ...m, parentToolUseId: null } : m)),
  )), [transcript]);

  // The sub-agent's last message usually *is* what it returned; only show the
  // returned text separately when it differs.
  const lastText = useMemo(() => {
    for (let i = transcript.length - 1; i >= 0; i--) {
      const m = transcript[i]!;
      if (m.role === 'assistant' && !m.toolName && !m.isToolResult && !m.isThinking && m.content?.trim()) return m.content.trim();
    }
    return '';
  }, [transcript]);
  const summaryIsLastText = !!task.summary && lastText === task.summary.trim();

  const toolCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of transcript) if (m.toolName) counts.set(shortToolName(m.toolName), (counts.get(shortToolName(m.toolName)) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [transcript]);
  const maxCount = toolCounts[0]?.[1] ?? 1;

  const send = () => {
    const t = note.trim();
    if (!t) return;
    const where = task.workflowName ? ` in the workflow ${task.workflowName}` : '';
    sendToChat(inner ? `About the agent "${taskTitle(task)}"${where}: ${t}` : `About the sub-agent "${taskTitle(task)}": ${t}`);
    setNote('');
  };

  const pill = STATUS_PILL[task.status] ?? 'text-zinc-400 border-border bg-surface-light';

  return createPortal(
    <div ref={rootRef} className="fixed inset-0 z-[1000] flex items-start justify-center pt-[8vh] px-6 select-text">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[1.5px]" onClick={onClose} />
      <div
        role="dialog"
        aria-label={`${taskTitle(task)} — full chat`}
        className="relative w-full max-w-[960px] h-[min(640px,82vh)] flex flex-col rounded-xl overflow-hidden bg-surface border border-border shadow-2xl shadow-black/40"
      >
        {/* Header */}
        <div className="h-10 shrink-0 flex items-center gap-3 pl-4 pr-2 border-b border-border">
          <div className="flex items-center gap-2 min-w-0 flex-1 text-[12.5px]">
            <Bot size={14} className="text-cyan-300 shrink-0" />
            <span className="font-mono font-medium text-zinc-100 truncate">{taskTitle(task)}</span>
            <span className={`text-[9.5px] font-semibold uppercase tracking-[0.05em] px-1.5 py-px rounded-full border shrink-0 ${pill}`}>{task.status}</span>
            <span className="text-[11.5px] text-zinc-600 truncate">{taskKindLabel(task)}{task.workflowName ? ` · ${task.workflowName}` : ''}</span>
          </div>
          {running && onBackground && !task.backgrounded && (
            <button type="button" onClick={onBackground} className="inline-flex items-center gap-1 h-6 px-2 rounded-md border border-border text-[11px] text-zinc-400 hover:text-zinc-100 hover:bg-surface-light transition-colors">
              <ArrowDownToLine size={11} /> Background
            </button>
          )}
          {running && onStop && (
            <button type="button" onClick={onStop} className="inline-flex items-center gap-1 h-6 px-2 rounded-md border border-rose-500/35 text-[11px] text-rose-300 hover:bg-rose-500/10 transition-colors">
              <Square size={9} fill="currentColor" /> Stop
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close"
            className="w-7 h-7 flex items-center justify-center rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-surface-light transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 min-h-0 flex">
          {/* Transcript */}
          <div
            ref={scrollRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
            }}
            className="flex-1 min-w-0 overflow-y-auto py-4"
          >
            <div className="max-w-[680px] mx-auto px-6 flex flex-col">
              {task.prompt && (
                <div className="rounded-[10px] border border-border bg-surface-light px-3 py-2.5 mb-2">
                  <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-zinc-500 mb-1.5">
                    <CornerDownRight size={11} /> Prompt from {origin}
                  </div>
                  {/* Size and leading need `!` too: the global unlayered `pre` rule sets 13px / 1.5. */}
                  <pre ref={promptRef} className={`!bg-transparent !p-0 !m-0 !rounded-none whitespace-pre-wrap break-words font-mono !text-[11px] !leading-[1.55] text-zinc-400 ${promptOpen ? '' : `max-h-[118px] overflow-hidden ${promptClipped ? '[mask-image:linear-gradient(180deg,#000_70%,transparent)]' : ''}`}`}>
                    {task.prompt}
                  </pre>
                  {(promptClipped || promptOpen) && (
                    <button type="button" onClick={() => setPromptOpen(o => !o)} className="mt-1 text-[11px] text-cyan-300 hover:text-cyan-200">
                      {promptOpen ? 'Show less' : 'Show full prompt'}
                    </button>
                  )}
                </div>
              )}

              {inner && polled.truncated && (
                <div className="text-[11px] text-zinc-600 py-1.5">Showing the last {transcript.length} of {polled.total} messages.</div>
              )}
              {loading && transcript.length === 0 && <div className="text-[12px] text-zinc-600 py-2">Loading…</div>}
              {error && <div className="text-[12px] text-rose-300 py-2">{error}</div>}

              {grouped.map((item, i) => {
                if ('agent' in item) return <AgentBubble key={item.agent.id} agent={item.agent} children={item.children} />;
                if ('toolRun' in item) {
                  const after = i < grouped.length - 1;
                  // Expanded, unlike the main chat's live run: this window exists to show every step.
                  return <ToolRunBubble key={item.items[0]!.id} group={item} hasContentAfter={after} collapse={false} live={running && !after} />;
                }
                return <MessageBubble key={item.id} message={item} nested />;
              })}

              {running ? (
                <div className="flex items-center gap-2 py-2 text-[12px] text-zinc-500">
                  <span className="w-3 h-3 rounded-full border-[1.5px] border-zinc-500/25 border-t-teal-400 animate-spin" />
                  <span className="italic thinking-sweep">{task.progress || 'Working…'}</span>
                </div>
              ) : task.summary && summaryIsLastText ? (
                <div className="flex items-center gap-1.5 mt-2 text-[10px] font-semibold uppercase tracking-[0.06em] text-emerald-300/80">
                  <CornerDownRight size={11} /> Returned to {origin}
                </div>
              ) : task.summary ? (
                <div className="rounded-[10px] border border-emerald-500/25 bg-emerald-500/[0.04] px-3 pt-2.5 pb-1 mt-3">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.06em] text-emerald-300 mb-1">Returned to {origin}</div>
                  <MessageBubble message={{ id: `summary-${task.taskId}`, role: 'assistant', content: task.summary, timestamp: task.endedAt ?? Date.now() }} nested />
                </div>
              ) : null}
            </div>
          </div>

          {/* Facts */}
          <aside className="w-[220px] shrink-0 border-l border-border bg-base/40 overflow-y-auto px-3.5 py-3.5">
            <Fact label="Status"><span className="capitalize">{task.status}</span></Fact>
            <Fact label="Type">{taskKindLabel(task)}</Fact>
            <Fact label="Elapsed" mono>{formatElapsed(taskElapsedMs(task, now))}</Fact>
            <Fact label={inner ? 'Output tokens' : 'Tokens'} mono>{formatTokens(task.totalTokens)}</Fact>
            <Fact label="Tool uses" mono>{task.toolUses}</Fact>
            {inner && polled.agent?.phase && <Fact label="Phase">{polled.agent.phase}</Fact>}
            {toolCounts.length > 0 && (
              <>
                <div className="text-[9.5px] font-semibold uppercase tracking-[0.07em] text-zinc-600 mt-3 mb-1">Tools</div>
                {toolCounts.map(([name, n]) => (
                  <div key={name} className="flex items-center gap-1.5 h-5 font-mono text-[11px] text-zinc-400">
                    <span className="truncate max-w-[84px]">{name}</span>
                    <span className="h-1 rounded-sm bg-cyan-700/80" style={{ width: Math.max(4, Math.round((n / maxCount) * 64)) }} />
                    <span className="ml-auto text-zinc-600">{n}</span>
                  </div>
                ))}
              </>
            )}
            {running && task.progress && <Fact label="Progress">{task.progress}</Fact>}
          </aside>
        </div>

        {/* Composer */}
        <div className="h-12 shrink-0 flex items-center gap-2 px-3 border-t border-border">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
            placeholder={`Tell the main agent about ${taskTitle(task)}…`}
            className="flex-1 h-8 px-3 rounded-lg bg-base border border-border text-[12.5px] text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-border-light"
          />
          <button
            type="button"
            disabled={!note.trim()}
            onClick={send}
            className="h-8 px-3 rounded-lg bg-zinc-100 text-zinc-900 text-[12px] font-medium disabled:opacity-40 transition-opacity"
          >
            Send to chat
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Fact({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="mb-2.5">
      <div className="text-[9.5px] font-semibold uppercase tracking-[0.07em] text-zinc-600 mb-0.5">{label}</div>
      <div className={`text-[12px] text-zinc-300 break-words ${mono ? 'font-mono text-[11.5px]' : ''}`}>{children}</div>
    </div>
  );
}
