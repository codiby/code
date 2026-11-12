/**
 * Helpers for the Agents panel: which tasks to show, how to group them, and
 * a hook that keeps one sub-agent's transcript live.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, ClaudeClient, SubagentTask, WorkflowAgent, WorkflowAgentMessages } from './claude-client';
import { onSubagentMessage } from './subagent-bus';

const AGENT_TASK_TYPES = new Set(['local_agent', 'remote_agent', 'local_workflow', 'in_process_teammate']);

/** Shells and monitors have their own panels; the Agents panel is for agents and workflows. */
export function isAgentTask(t: SubagentTask): boolean {
  return AGENT_TASK_TYPES.has(t.taskType) || !!t.subagentType;
}

export function isTaskRunning(t: SubagentTask): boolean {
  return t.status === 'running' || t.status === 'pending' || t.status === 'paused';
}

export function taskTitle(t: SubagentTask): string {
  return t.description || t.workflowName || t.subagentType || 'Agent';
}

export function taskKindLabel(t: SubagentTask): string {
  if (t.taskType === 'local_workflow') return 'workflow';
  if (t.spawnDepth > 1 || (!t.subagentType && t.toolUseId)) return t.subagentType || 'workflow agent';
  return t.subagentType || 'agent';
}

export function taskElapsedMs(t: SubagentTask, now: number): number {
  if (isTaskRunning(t)) return Math.max(t.durationMs, now - t.startedAt);
  if (t.durationMs) return t.durationMs;
  return Math.max(0, (t.endedAt ?? now) - t.startedAt);
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}

export interface TaskGroup {
  key: string;
  /** Set when the group is a workflow (its own task row renders as the header). */
  workflow: SubagentTask | null;
  tasks: SubagentTask[];
}

/**
 * Running first (newest first), then finished (most recent first). Agents a
 * workflow started share its tool_use id and are nested under it.
 */
export function groupTasks(all: SubagentTask[]): { running: TaskGroup[]; done: SubagentTask[] } {
  const agents = all.filter(isAgentTask);
  const workflows = agents.filter(t => t.taskType === 'local_workflow');
  const byWorkflow = new Map<string, SubagentTask[]>();
  const loose: SubagentTask[] = [];
  for (const t of agents) {
    if (t.taskType === 'local_workflow') continue;
    const wf = t.toolUseId ? workflows.find(w => w.toolUseId === t.toolUseId) : undefined;
    if (wf) {
      const list = byWorkflow.get(wf.taskId) ?? [];
      list.push(t);
      byWorkflow.set(wf.taskId, list);
    } else {
      loose.push(t);
    }
  }
  const newest = (a: SubagentTask, b: SubagentTask) => b.startedAt - a.startedAt;
  const recent = (a: SubagentTask, b: SubagentTask) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt);

  const running: TaskGroup[] = [];
  const done: SubagentTask[] = [];
  for (const wf of workflows.sort(newest)) {
    const children = (byWorkflow.get(wf.taskId) ?? []).sort((a, b) => a.startedAt - b.startedAt);
    const live = children.filter(isTaskRunning);
    if (isTaskRunning(wf) || live.length) {
      running.push({ key: wf.taskId, workflow: wf, tasks: children.length ? live : [wf] });
      done.push(...children.filter(c => !isTaskRunning(c)));
    } else {
      done.push(...(children.length ? children : [wf]));
    }
  }
  const liveLoose = loose.filter(isTaskRunning).sort(newest);
  if (liveLoose.length) running.push({ key: 'agents', workflow: null, tasks: liveLoose });
  done.push(...loose.filter(t => !isTaskRunning(t)));
  return { running, done: done.sort(recent) };
}

/** Re-render every `ms` while `active` (live elapsed counters). */
export function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [active, ms]);
  return now;
}

function belongsTo(m: ChatMessage, task: SubagentTask): boolean {
  return m.agentId === task.taskId || (!m.agentId && !!task.toolUseId && m.parentToolUseId === task.toolUseId);
}

/**
 * One sub-agent's transcript, kept live: fetched from the bridge (its text is
 * not in the chat window), then fed by `subagent_message` frames and by the
 * tool calls that do reach the chat list (`liveMessages`). Re-fetched when
 * the task settles so the final state is exact.
 */
export function useTaskTranscript(
  client: ClaudeClient | null,
  sessionId: string | null,
  task: SubagentTask | null,
  liveMessages: ChatMessage[],
): { messages: ChatMessage[]; loading: boolean; error: string | null } {
  const [fetched, setFetched] = useState<ChatMessage[]>([]);
  const [streamed, setStreamed] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taskId = task?.taskId ?? null;
  const running = task ? isTaskRunning(task) : false;
  const taskRef = useRef(task);
  taskRef.current = task;

  // A different task starts from scratch. Kept apart from the fetch below:
  // the re-fetch when a task settles must not wipe what is on screen (the
  // window would collapse to its tool calls, lose the reader's scroll
  // position, and stay empty if that fetch failed).
  useEffect(() => {
    setFetched([]);
    setStreamed([]);
    setError(null);
    setLoading(false);
  }, [sessionId, taskId]);

  useEffect(() => {
    if (!client || !sessionId || !taskId) return;
    let cancelled = false;
    setLoading(true);
    client.fetchTaskMessages(sessionId, taskId, taskRef.current?.toolUseId)
      .then(res => { if (!cancelled) { setFetched(res.messages); setError(null); } })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // Re-fetch when the task settles: the final text may have raced the frames.
  }, [client, sessionId, taskId, running]);

  useEffect(() => {
    if (!sessionId || !taskId) return;
    return onSubagentMessage((sid, msg) => {
      const t = taskRef.current;
      if (sid !== sessionId || !t || !belongsTo(msg, t)) return;
      setStreamed(prev => (prev.some(m => m.id === msg.id) ? prev : [...prev, msg]));
    });
  }, [sessionId, taskId]);

  const messages = useMemo(() => {
    if (!task) return [];
    const byId = new Map<string, ChatMessage>();
    for (const m of fetched) byId.set(m.id, m);
    for (const m of streamed) if (!byId.has(m.id)) byId.set(m.id, m);
    for (const m of liveMessages) if (belongsTo(m, task) && !byId.has(m.id)) byId.set(m.id, m);
    return [...byId.values()].sort((a, b) => (a.seq ?? Infinity) - (b.seq ?? Infinity) || a.timestamp - b.timestamp);
  }, [fetched, streamed, liveMessages, task]);

  return { messages, loading, error };
}

/** One-line argument summary for a tool call, for the panel's step list. */
export function toolArg(m: ChatMessage): string {
  const input = (m.toolInput && typeof m.toolInput === 'object' ? m.toolInput : {}) as Record<string, unknown>;
  const pick = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  return (pick('command') || pick('file_path') || pick('path') || pick('pattern') || pick('url') || pick('query') || pick('description') || '').replace(/\s+/g, ' ').trim();
}

/** Markdown → one readable paragraph for previews (the window renders the real thing). */
export function plainPreview(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/**
 * Whether the Agents window should close on this keydown. It listens in the
 * capture phase so an Esc never also stops the main turn, which means it sees
 * every Esc first — including ones meant for an overlay opened on top of it
 * (an image preview or a tool's output window, both portalled into <body>
 * after it), for an IME composition, or for a held-Ctrl session switcher.
 */
export function windowTakesEscape(
  e: Pick<KeyboardEvent, 'key' | 'isComposing' | 'ctrlKey' | 'metaKey' | 'altKey'>,
  root: Element | null,
): boolean {
  if (e.key !== 'Escape' || e.isComposing) return false;
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  for (let n = root?.nextElementSibling ?? null; n; n = n.nextElementSibling) {
    if (n.classList.contains('fixed') && n.classList.contains('inset-0')) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Agents inside a workflow
//
// The SDK streams a workflow as one task, so its agents come from the bridge
// reading the run's transcript files (GET /sessions/:id/tasks/:taskId/agents).
// Nothing pushes them: the drawer polls while a workflow runs.
// ---------------------------------------------------------------------------

/** How often a running workflow's agents, and an open agent's chat, are re-read. */
export const WORKFLOW_POLL_MS = 3000;
/** The most messages the window holds for one workflow agent (the bridge's cap too). */
export const WORKFLOW_MESSAGES_CAP = 2000;

export function isWorkflowTask(t: SubagentTask): boolean {
  return t.taskType === 'local_workflow';
}

/** done/total for the header's meter. An agent is done once it handed back its result. */
export function workflowProgress(agents: WorkflowAgent[]): { done: number; total: number; percent: number } {
  const done = agents.filter(a => a.status === 'completed').length;
  const total = agents.length;
  return { done, total, percent: total ? Math.round((done / total) * 100) : 0 };
}

/**
 * The agent that just acted: a workflow's progress tick carries the inner
 * agent's label as `last_tool_name` (task.lastToolName).
 */
export function isAgentActing(agent: WorkflowAgent, workflow: SubagentTask): boolean {
  return agent.status === 'running' && isTaskRunning(workflow) && !!workflow.lastToolName && workflow.lastToolName === agent.label;
}

export function workflowAgentElapsedMs(agent: WorkflowAgent, now: number): number {
  if (agent.startedAt === null) return 0;
  const end = agent.status === 'running' ? now : agent.endedAt ?? agent.startedAt;
  return Math.max(0, end - agent.startedAt);
}

/** Inner rows the filter keeps: "Running" hides the agents that already finished. */
export function visibleWorkflowAgents(agents: WorkflowAgent[], filter: 'all' | 'running' | 'done'): WorkflowAgent[] {
  return filter === 'running' ? agents.filter(a => a.status === 'running') : agents;
}

/**
 * A workflow agent dressed as a task, so the full-chat window (built for SDK
 * tasks) shows it unchanged. Its tokens are output tokens: that is what its
 * transcript records per response.
 */
export function workflowAgentTask(agent: WorkflowAgent, workflow: SubagentTask, prompt: string | null = null): SubagentTask {
  const startedAt = agent.startedAt ?? workflow.startedAt;
  const running = agent.status === 'running';
  return {
    taskId: `${workflow.taskId}/${agent.agentId}`,
    toolUseId: null,
    taskType: 'local_agent',
    description: agent.label,
    subagentType: null,
    workflowName: workflow.workflowName || taskTitle(workflow),
    prompt,
    status: agent.status,
    backgrounded: true,
    spawnDepth: 2,
    startedAt,
    endedAt: agent.endedAt,
    totalTokens: agent.outputTokens,
    toolUses: agent.toolUses,
    durationMs: running ? 0 : Math.max(0, (agent.endedAt ?? startedAt) - startedAt),
    lastToolName: agent.lastToolName,
    // Not its last text: the window already ends on that message, and its
    // "working" line would only repeat it.
    progress: null,
    summary: agent.summary,
    error: null,
  };
}

/** What a poll adds. Unchanged polls keep the same array, so nothing re-renders. */
export function mergeWorkflowMessages(
  prev: ChatMessage[],
  res: Pick<WorkflowAgentMessages, 'messages' | 'gap'>,
  incremental: boolean,
): ChatMessage[] {
  if (!incremental || res.gap) return res.messages;
  if (res.messages.length === 0) return prev;
  const seen = new Set(prev.map(m => m.id));
  const fresh = res.messages.filter(m => !seen.has(m.id));
  if (fresh.length === 0) return prev;
  const next = [...prev, ...fresh];
  return next.length > WORKFLOW_MESSAGES_CAP ? next.slice(-WORKFLOW_MESSAGES_CAP) : next;
}

function sameJson(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** False while the window or tab is hidden: polling then is wasted work. */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onChange = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return visible;
}

/**
 * Each workflow's agents, by workflow task id. While `active`, running
 * workflows are re-read every WORKFLOW_POLL_MS; a finished one is read once
 * more after it finishes (its final n/n) and then left alone.
 */
export function useWorkflowAgents(
  client: ClaudeClient | null,
  sessionId: string | null,
  workflows: SubagentTask[],
  active: boolean,
): Record<string, WorkflowAgent[]> {
  const [byTask, setByTask] = useState<Record<string, WorkflowAgent[]>>({});
  const settled = useRef(new Set<string>());
  const listRef = useRef(workflows);
  listRef.current = workflows;
  const key = workflows.map(w => `${w.taskId}:${isTaskRunning(w) ? 'r' : 'd'}`).join(',');

  useEffect(() => {
    setByTask({});
    settled.current = new Set();
  }, [sessionId]);

  useEffect(() => {
    if (!client || !sessionId || !active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const due = listRef.current.filter(w => isTaskRunning(w) || !settled.current.has(w.taskId));
      await Promise.all(due.map(async (w) => {
        try {
          const res = await client.fetchWorkflowAgents(sessionId, w.taskId);
          if (cancelled) return;
          if (!isTaskRunning(w)) settled.current.add(w.taskId);
          setByTask(prev => (sameJson(prev[w.taskId] ?? [], res.agents) ? prev : { ...prev, [w.taskId]: res.agents }));
        } catch {
          // Keep what is on screen; the next tick tries again.
        }
      }));
      if (!cancelled && listRef.current.some(isTaskRunning)) timer = setTimeout(tick, WORKFLOW_POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [client, sessionId, active, key]);

  return byTask;
}

export interface WorkflowAgentTranscript {
  messages: ChatMessage[];
  /** Fresher than the drawer's copy: it comes with every poll. */
  agent: WorkflowAgent | null;
  prompt: string | null;
  total: number;
  truncated: boolean;
  loading: boolean;
  error: string | null;
}

const NO_META = { agent: null, prompt: null, total: 0, truncated: false };

/**
 * One workflow agent's chat, kept live: fetched whole once, then polled for
 * what came after the newest message it has while the agent runs. Polls
 * append (or keep the same array), never clear, so the window neither
 * flickers nor loses the reader's scroll position.
 */
export function useWorkflowAgentTranscript(
  client: ClaudeClient | null,
  sessionId: string | null,
  target: { workflow: SubagentTask; agentId: string } | null,
  active = true,
): WorkflowAgentTranscript {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [meta, setMeta] = useState<{ agent: WorkflowAgent | null; prompt: string | null; total: number; truncated: boolean }>(NO_META);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const workflowId = target?.workflow.taskId ?? null;
  const agentId = target?.agentId ?? null;
  const workflowRunning = target ? isTaskRunning(target.workflow) : false;
  const agentRunning = meta.agent ? meta.agent.status === 'running' : workflowRunning;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  useEffect(() => {
    setMessages([]);
    setMeta(NO_META);
    setError(null);
    setLoading(false);
  }, [sessionId, workflowId, agentId]);

  useEffect(() => {
    if (!client || !sessionId || !workflowId || !agentId || !active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let whole = messagesRef.current.length === 0;
    const tick = async () => {
      const after = whole ? undefined : messagesRef.current[messagesRef.current.length - 1]?.seq ?? 0;
      if (messagesRef.current.length === 0) setLoading(true);
      let keepPolling = agentRunning;
      try {
        const res = await client.fetchWorkflowAgentMessages(sessionId, workflowId, agentId, after);
        if (cancelled) return;
        if (after !== undefined && res.total < after) {
          // The transcript started over (rewritten): read it whole again.
          whole = true;
          keepPolling = true;
        } else {
          whole = false;
          setMessages(prev => mergeWorkflowMessages(prev, res, after !== undefined));
          keepPolling = res.agent ? res.agent.status === 'running' : agentRunning;
        }
        const next = { agent: res.agent, prompt: res.prompt, total: res.total, truncated: res.truncated };
        setMeta(prev => (sameJson(prev, next) ? prev : next));
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
      if (!cancelled && keepPolling) timer = setTimeout(tick, whole ? 0 : WORKFLOW_POLL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // `agentRunning` on purpose: settling triggers one last read of the tail.
  }, [client, sessionId, workflowId, agentId, active, agentRunning]);

  return { messages, ...meta, loading, error };
}
