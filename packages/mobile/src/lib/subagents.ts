/**
 * Sub-agents of a session — the mobile port of the desktop's
 * `packages/ui/src/lib/subagents.ts`. The bridge folds the Claude Agent SDK's
 * task_* events into one `SubagentTask` per task (`state.tasks` in the
 * `session_state` snapshot, then `task_update` frames), and this module turns
 * them into what the Agents sheet shows.
 *
 * Kept free of React Native imports so the rules can be tested on their own.
 */

import type { ChatMessage } from '../api/types';
import { shortToolName } from './chatItems';

export type SubagentTaskStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'killed';

/** Mirrors `SubagentTask` in packages/core/provider/types.ts. */
export interface SubagentTask {
  /** SDK task id; for sub-agents it is also the `agentId` on their messages. */
  readonly taskId: string;
  /** The Agent / Workflow tool call that started it, when known. */
  readonly toolUseId: string | null;
  /** 'local_agent', 'local_workflow', 'local_bash', … */
  readonly taskType: string;
  readonly description: string;
  readonly subagentType: string | null;
  readonly workflowName: string | null;
  readonly prompt: string | null;
  readonly status: SubagentTaskStatus;
  readonly backgrounded: boolean;
  /** 1 = started by the main agent, 2 = by one of its sub-agents… */
  readonly spawnDepth: number;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly totalTokens: number;
  readonly toolUses: number;
  readonly durationMs: number;
  readonly lastToolName: string | null;
  /** Live one-line progress. */
  readonly progress: string | null;
  /** What the task returned to the main agent. */
  readonly summary: string | null;
  readonly error: string | null;
}

/**
 * A message one sub-agent produced. `agentId` / `parentToolUseId` are what tie
 * it to its task; the chat's own `ChatMessage` drops them because the main
 * thread never needed them.
 */
export interface SubagentMessage extends ChatMessage {
  readonly agentId: string | null;
  readonly parentToolUseId: string | null;
}

const STATUSES: ReadonlySet<string> = new Set<SubagentTaskStatus>([
  'pending',
  'running',
  'paused',
  'completed',
  'failed',
  'stopped',
  'killed',
]);

function text(raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function count(raw: Record<string, unknown>, key: string): number {
  const value = raw[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * One task from the wire. Everything but `taskId` has a default: a bridge a
 * version ahead or behind must degrade to a plainer row, not drop the agent.
 */
export function parseTask(value: unknown): SubagentTask | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const taskId = text(raw, 'taskId');
  if (taskId === null) {
    return null;
  }
  const status = typeof raw.status === 'string' ? raw.status : '';
  return {
    taskId,
    toolUseId: text(raw, 'toolUseId'),
    taskType: text(raw, 'taskType') ?? 'local_agent',
    description: text(raw, 'description') ?? '',
    subagentType: text(raw, 'subagentType'),
    workflowName: text(raw, 'workflowName'),
    prompt: text(raw, 'prompt'),
    // An unknown status reads as finished: a status this build can't name
    // would otherwise spin forever and keep offering Stop.
    status: STATUSES.has(status) ? (status as SubagentTaskStatus) : 'stopped',
    backgrounded: raw.backgrounded === true,
    spawnDepth: count(raw, 'spawnDepth') || 1,
    startedAt: count(raw, 'startedAt'),
    endedAt: typeof raw.endedAt === 'number' ? raw.endedAt : null,
    totalTokens: count(raw, 'totalTokens'),
    toolUses: count(raw, 'toolUses'),
    durationMs: count(raw, 'durationMs'),
    lastToolName: text(raw, 'lastToolName'),
    progress: text(raw, 'progress'),
    summary: text(raw, 'summary'),
    error: text(raw, 'error'),
  };
}

/** `state.tasks` from a `session_state` snapshot, keyed by task id. */
export function parseTasks(value: unknown): Record<string, SubagentTask> {
  const tasks: Record<string, SubagentTask> = {};
  if (typeof value !== 'object' || value === null) {
    return tasks;
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    const task = parseTask(item);
    if (task !== null) {
      tasks[task.taskId] = task;
    }
  }
  return tasks;
}

const AGENT_TASK_TYPES: ReadonlySet<string> = new Set([
  'local_agent',
  'remote_agent',
  'local_workflow',
  'in_process_teammate',
]);

/** Shells and monitors are tasks too, but the Agents sheet is for agents and workflows. */
export function isAgentTask(task: SubagentTask): boolean {
  return AGENT_TASK_TYPES.has(task.taskType) || task.subagentType !== null;
}

export function isTaskRunning(task: SubagentTask): boolean {
  return (
    task.status === 'running' ||
    task.status === 'pending' ||
    task.status === 'paused'
  );
}

export function taskTitle(task: SubagentTask): string {
  return task.description || task.workflowName || task.subagentType || 'Agent';
}

export function taskKindLabel(task: SubagentTask): string {
  if (task.taskType === 'local_workflow') {
    return 'workflow';
  }
  if (
    task.spawnDepth > 1 ||
    (task.subagentType === null && task.toolUseId !== null)
  ) {
    return task.subagentType ?? 'workflow agent';
  }
  return task.subagentType ?? 'agent';
}

export function taskElapsedMs(task: SubagentTask, now: number): number {
  if (isTaskRunning(task)) {
    return Math.max(task.durationMs, now - task.startedAt);
  }
  if (task.durationMs > 0) {
    return task.durationMs;
  }
  return Math.max(0, (task.endedAt ?? now) - task.startedAt);
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  }
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1000) {
    return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  }
  return String(n);
}

export interface TaskGroup {
  readonly key: string;
  /** Set when the group is a workflow; its agents are the rows. */
  readonly workflow: SubagentTask | null;
  readonly tasks: SubagentTask[];
}

/**
 * Running first (newest first), then finished (most recent first). Agents a
 * workflow started share its tool_use id and are listed under it. Same rule
 * as the desktop drawer, so both surfaces agree on what "running" counts.
 */
export function groupTasks(all: SubagentTask[]): {
  running: TaskGroup[];
  done: SubagentTask[];
} {
  const agents = all.filter(isAgentTask);
  const workflows = agents.filter(task => task.taskType === 'local_workflow');
  const byWorkflow = new Map<string, SubagentTask[]>();
  const loose: SubagentTask[] = [];
  for (const task of agents) {
    if (task.taskType === 'local_workflow') {
      continue;
    }
    const workflow =
      task.toolUseId === null
        ? undefined
        : workflows.find(candidate => candidate.toolUseId === task.toolUseId);
    if (workflow === undefined) {
      loose.push(task);
    } else {
      const list = byWorkflow.get(workflow.taskId) ?? [];
      list.push(task);
      byWorkflow.set(workflow.taskId, list);
    }
  }
  const newest = (a: SubagentTask, b: SubagentTask) =>
    b.startedAt - a.startedAt;
  const recent = (a: SubagentTask, b: SubagentTask) =>
    (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt);

  const running: TaskGroup[] = [];
  const done: SubagentTask[] = [];
  for (const workflow of [...workflows].sort(newest)) {
    const children = [...(byWorkflow.get(workflow.taskId) ?? [])].sort(
      (a, b) => a.startedAt - b.startedAt,
    );
    const live = children.filter(isTaskRunning);
    if (isTaskRunning(workflow) || live.length > 0) {
      running.push({
        key: workflow.taskId,
        workflow,
        tasks: children.length > 0 ? live : [workflow],
      });
      done.push(...children.filter(child => !isTaskRunning(child)));
    } else {
      done.push(...(children.length > 0 ? children : [workflow]));
    }
  }
  const liveLoose = loose.filter(isTaskRunning).sort(newest);
  if (liveLoose.length > 0) {
    running.push({ key: 'agents', workflow: null, tasks: liveLoose });
  }
  done.push(...loose.filter(task => !isTaskRunning(task)));
  return { running, done: done.sort(recent) };
}

/** Running and finished counts, as the header chip and the filters show them. */
export function countTasks(all: SubagentTask[]): {
  running: number;
  done: number;
} {
  const { running, done } = groupTasks(all);
  return {
    running: running.reduce((n, group) => n + group.tasks.length, 0),
    done: done.length,
  };
}

export type TaskFilter = 'all' | 'running' | 'done';

export interface TaskSection {
  readonly key: string;
  /** 'Workflow', 'Running' or 'Completed'. */
  readonly label: string;
  /** The workflow's name next to the label, when the section is one. */
  readonly detail: string | null;
  readonly tasks: SubagentTask[];
}

/** What the list renders for a filter, in order: running groups, then completed. */
export function taskSections(
  all: SubagentTask[],
  filter: TaskFilter,
): TaskSection[] {
  const { running, done } = groupTasks(all);
  const sections: TaskSection[] = [];
  if (filter !== 'done') {
    for (const group of running) {
      sections.push({
        key: group.key,
        label: group.workflow === null ? 'Running' : 'Workflow',
        detail:
          group.workflow === null
            ? null
            : group.workflow.workflowName || taskTitle(group.workflow),
        tasks: group.tasks,
      });
    }
  }
  if (filter !== 'running' && done.length > 0) {
    sections.push({
      key: 'done',
      label: 'Completed',
      detail: null,
      tasks: done,
    });
  }
  return sections;
}

export interface TaskTotals {
  readonly tokens: number;
  readonly tools: number;
  /** The longest single agent, not the sum: they run in parallel. */
  readonly longest: number;
}

export function taskTotals(tasks: SubagentTask[], now: number): TaskTotals {
  return {
    tokens: tasks.reduce((n, task) => n + task.totalTokens, 0),
    tools: tasks.reduce((n, task) => n + task.toolUses, 0),
    longest: tasks.reduce(
      (n, task) => Math.max(n, taskElapsedMs(task, now)),
      0,
    ),
  };
}

/** The row's second line: what it is doing now, or what it was once done. */
export function taskLine(task: SubagentTask): string {
  if (isTaskRunning(task)) {
    const tool =
      task.lastToolName === null ? null : shortToolName(task.lastToolName);
    return [tool, task.progress].filter(Boolean).join(' · ') || 'Starting…';
  }
  if (task.status === 'failed' && task.error !== null) {
    return task.error;
  }
  return `${taskKindLabel(task)} · ${formatTokens(task.totalTokens)} tokens`;
}

/**
 * Whether a message is this task's. Messages from SDKs that don't stamp
 * `agentId` fall back to the Agent tool call they nest under.
 */
export function belongsToTask(
  message: Pick<SubagentMessage, 'agentId' | 'parentToolUseId'>,
  task: Pick<SubagentTask, 'taskId' | 'toolUseId'>,
): boolean {
  return (
    message.agentId === task.taskId ||
    (message.agentId === null &&
      task.toolUseId !== null &&
      message.parentToolUseId === task.toolUseId)
  );
}

/**
 * The transcript as fetched plus what streamed in since, oldest first. The
 * fetched copy wins a duplicate: it is the bridge's settled version.
 */
export function mergeTranscript(
  fetched: SubagentMessage[],
  streamed: SubagentMessage[],
): SubagentMessage[] {
  const byId = new Map<string, SubagentMessage>();
  for (const message of fetched) {
    byId.set(message.id, message);
  }
  for (const message of streamed) {
    if (!byId.has(message.id)) {
      byId.set(message.id, message);
    }
  }
  return [...byId.values()].sort(
    (a, b) => a.seq - b.seq || a.timestamp - b.timestamp,
  );
}

/** The sub-agent's last plain answer, which is usually what it returned. */
export function lastAnswer(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (
      message.role === 'assistant' &&
      message.toolName === null &&
      message.isToolResult !== true &&
      !message.isThinking &&
      message.content.trim().length > 0
    ) {
      return message.content.trim();
    }
  }
  return '';
}

/**
 * How to show what the task returned. When it equals the last message the
 * transcript already shows it, so a label is enough; repeating it as a card
 * would print the same text twice in a row.
 */
export function returnedSummary(
  task: SubagentTask,
  messages: ChatMessage[],
):
  | { readonly kind: 'none' }
  | { readonly kind: 'marker' }
  | { readonly kind: 'card'; readonly text: string } {
  if (
    isTaskRunning(task) ||
    task.summary === null ||
    task.summary.trim().length === 0
  ) {
    return { kind: 'none' };
  }
  return lastAnswer(messages) === task.summary.trim()
    ? { kind: 'marker' }
    : { kind: 'card', text: task.summary };
}

/** Most used tools first — the desktop's "Tools" facts, capped for a phone. */
export function toolCounts(
  messages: ChatMessage[],
  limit = 6,
): [name: string, uses: number][] {
  const counts = new Map<string, number>();
  for (const message of messages) {
    if (message.toolName !== null) {
      const name = shortToolName(message.toolName);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Agents inside a workflow
//
// The SDK streams a workflow as one task: its agents never send task events
// or messages of their own. The bridge reads them from the run's transcript
// files (GET /sessions/:id/tasks/:taskId/agents), and the sheet polls that
// while a workflow runs. Same data and rules as the desktop drawer.
// ---------------------------------------------------------------------------

export type WorkflowAgentStatus = 'running' | 'completed' | 'stopped';

/** Mirrors `WorkflowAgent` in packages/core/session/workflow-agents.ts. */
export interface WorkflowAgent {
  readonly agentId: string;
  readonly label: string;
  readonly phase: string | null;
  readonly status: WorkflowAgentStatus;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly toolUses: number;
  readonly outputTokens: number;
  readonly lastToolName: string | null;
  readonly lastText: string | null;
  /** What it handed back to the workflow, once done. */
  readonly summary: string | null;
}

const AGENT_STATUSES: ReadonlySet<string> = new Set<WorkflowAgentStatus>([
  'running',
  'completed',
  'stopped',
]);

function stamp(raw: Record<string, unknown>, key: string): number | null {
  const value = raw[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** One workflow agent from the wire; null without an id. */
export function parseWorkflowAgent(value: unknown): WorkflowAgent | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const agentId = text(raw, 'agentId');
  if (agentId === null) {
    return null;
  }
  const status = typeof raw.status === 'string' ? raw.status : '';
  return {
    agentId,
    label: text(raw, 'label') ?? agentId,
    phase: text(raw, 'phase'),
    // Same reasoning as parseTask: an unknown status must not spin forever.
    status: AGENT_STATUSES.has(status)
      ? (status as WorkflowAgentStatus)
      : 'stopped',
    startedAt: stamp(raw, 'startedAt'),
    endedAt: stamp(raw, 'endedAt'),
    toolUses: count(raw, 'toolUses'),
    outputTokens: count(raw, 'outputTokens'),
    lastToolName: text(raw, 'lastToolName'),
    lastText: text(raw, 'lastText'),
    summary: text(raw, 'summary'),
  };
}

export function parseWorkflowAgents(value: unknown): WorkflowAgent[] {
  return Array.isArray(value)
    ? value
        .map(parseWorkflowAgent)
        .filter((agent): agent is WorkflowAgent => agent !== null)
    : [];
}

export interface WorkflowProgress {
  readonly done: number;
  readonly total: number;
  readonly percent: number;
}

/** done/total for the header's meter: an agent is done once it handed back its result. */
export function workflowProgress(agents: WorkflowAgent[]): WorkflowProgress {
  const done = agents.filter(agent => agent.status === 'completed').length;
  const total = agents.length;
  return {
    done,
    total,
    percent: total > 0 ? Math.round((done / total) * 100) : 0,
  };
}

/**
 * The agent that just acted: a workflow's progress tick carries the inner
 * agent's label as `last_tool_name`.
 */
export function isAgentActing(
  agent: WorkflowAgent,
  workflow: SubagentTask,
): boolean {
  return (
    agent.status === 'running' &&
    isTaskRunning(workflow) &&
    workflow.lastToolName !== null &&
    workflow.lastToolName === agent.label
  );
}

/** Joins a workflow and one of its agents into the id the sheet opens. */
export function workflowAgentKey(workflowId: string, agentId: string): string {
  return `${workflowId}/${agentId}`;
}

/**
 * A workflow agent dressed as a task, so the row and the full chat (built
 * for SDK tasks) show it unchanged. Its tokens are output tokens: that is
 * what its transcript records.
 */
export function workflowAgentTask(
  agent: WorkflowAgent,
  workflow: SubagentTask,
  prompt: string | null = null,
): SubagentTask {
  const startedAt = agent.startedAt ?? workflow.startedAt;
  const isRunning = agent.status === 'running';
  return {
    taskId: workflowAgentKey(workflow.taskId, agent.agentId),
    toolUseId: null,
    taskType: 'local_agent',
    description: agent.label,
    subagentType: null,
    workflowName: workflow.workflowName ?? taskTitle(workflow),
    prompt,
    status: agent.status,
    backgrounded: true,
    spawnDepth: 2,
    startedAt,
    endedAt: agent.endedAt,
    totalTokens: agent.outputTokens,
    toolUses: agent.toolUses,
    durationMs: isRunning
      ? 0
      : Math.max(0, (agent.endedAt ?? startedAt) - startedAt),
    lastToolName: agent.lastToolName,
    progress: isRunning ? agent.lastText : null,
    summary: agent.summary,
    error: null,
  };
}

/** One line of the sheet's list. */
export type SheetRow =
  | { readonly kind: 'task'; readonly key: string; readonly task: SubagentTask }
  | {
      readonly kind: 'agent';
      readonly key: string;
      /** The agent as a task (see workflowAgentTask); its id opens the chat. */
      readonly task: SubagentTask;
      readonly acting: boolean;
    }
  | {
      /** A finished workflow's own header inside "Completed". */
      readonly kind: 'workflow';
      readonly key: string;
      readonly workflow: SubagentTask;
      readonly progress: WorkflowProgress;
    };

export interface SheetSection extends TaskSection {
  /** Set on a running workflow's section once its agents are known. */
  readonly progress: WorkflowProgress | null;
  readonly rows: SheetRow[];
}

function agentRows(
  workflow: SubagentTask,
  agents: WorkflowAgent[],
): SheetRow[] {
  return agents.map(agent => ({
    kind: 'agent',
    key: workflowAgentKey(workflow.taskId, agent.agentId),
    task: workflowAgentTask(agent, workflow),
    acting: isAgentActing(agent, workflow),
  }));
}

/**
 * `taskSections`, with each workflow's own agents where it has them: a
 * running workflow's section lists them under a done/total meter instead of
 * the workflow's single row, and a finished one heads its agents inside
 * "Completed" with its final n/n.
 */
export function sheetSections(
  all: SubagentTask[],
  filter: TaskFilter,
  agentsByWorkflow: Record<string, WorkflowAgent[]>,
): SheetSection[] {
  const byId = new Map(all.map(task => [task.taskId, task]));
  return taskSections(all, filter).map(section => {
    const workflow = section.key === 'done' ? undefined : byId.get(section.key);
    const agents =
      workflow === undefined ? undefined : agentsByWorkflow[workflow.taskId];
    if (workflow !== undefined && agents !== undefined && agents.length > 0) {
      const shown =
        filter === 'running'
          ? agents.filter(agent => agent.status === 'running')
          : agents;
      return {
        ...section,
        progress: workflowProgress(agents),
        rows: agentRows(workflow, shown),
      };
    }
    const rows: SheetRow[] = [];
    for (const task of section.tasks) {
      const inner =
        task.taskType === 'local_workflow'
          ? agentsByWorkflow[task.taskId]
          : undefined;
      if (section.key === 'done' && inner !== undefined && inner.length > 0) {
        rows.push({
          kind: 'workflow',
          key: task.taskId,
          workflow: task,
          progress: workflowProgress(inner),
        });
        rows.push(...agentRows(task, inner));
      } else {
        rows.push({ kind: 'task', key: task.taskId, task });
      }
    }
    return { ...section, progress: null, rows };
  });
}

/** What a poll adds. An unchanged poll keeps the same array, so nothing re-renders. */
export function mergeWorkflowMessages<T extends { readonly id: string }>(
  previous: T[],
  incoming: T[],
  options: { readonly incremental: boolean; readonly gap: boolean },
  cap = 2000,
): T[] {
  if (!options.incremental || options.gap) {
    return incoming;
  }
  if (incoming.length === 0) {
    return previous;
  }
  const seen = new Set(previous.map(message => message.id));
  const fresh = incoming.filter(message => !seen.has(message.id));
  if (fresh.length === 0) {
    return previous;
  }
  const next = [...previous, ...fresh];
  return next.length > cap ? next.slice(-cap) : next;
}

/** The workflow and agent a `workflowAgentKey` names, if both are still known. */
export function findWorkflowAgent(
  key: string,
  tasks: Record<string, SubagentTask>,
  agentsByWorkflow: Record<string, WorkflowAgent[]>,
): { workflow: SubagentTask; agent: WorkflowAgent } | null {
  const slash = key.indexOf('/');
  if (slash <= 0) {
    return null;
  }
  const workflow = tasks[key.slice(0, slash)];
  const agentId = key.slice(slash + 1);
  const agent = agentsByWorkflow[workflow?.taskId ?? '']?.find(
    candidate => candidate.agentId === agentId,
  );
  return workflow === undefined || agent === undefined
    ? null
    : { workflow, agent };
}
