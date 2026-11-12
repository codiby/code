/**
 * Wire side of a workflow's own agents. The SDK reports a workflow as one
 * task and never streams its agents, so the bridge reads them from the run's
 * transcript files and the sheet polls it — only while it is on screen and
 * the workflow runs.
 */

import { useEffect, useRef, useState } from 'react';

import { ServerError, requestJson } from './client';
import { parseTaskMessage } from './subagents';
import { useAppActive } from './useAppActive';
import {
  isTaskRunning,
  mergeWorkflowMessages,
  parseWorkflowAgent,
  parseWorkflowAgents,
  type SubagentMessage,
  type SubagentTask,
  type WorkflowAgent,
} from '../lib/subagents';

/** How often a running workflow's agents, and an open agent's chat, are re-read. */
export const WORKFLOW_POLL_MS = 3000;

const taskPath = (sessionId: string, taskId: string) =>
  `/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(
    taskId,
  )}`;

/** The agents of one workflow task; empty until the bridge knows where its run lives. */
export function fetchWorkflowAgents(
  baseUrl: string,
  token: string,
  sessionId: string,
  taskId: string,
): Promise<WorkflowAgent[]> {
  return requestJson(
    baseUrl,
    `${taskPath(sessionId, taskId)}/agents`,
    body => {
      const raw = body as { agents?: unknown } | null;
      if (
        raw === null ||
        typeof raw !== 'object' ||
        !Array.isArray(raw.agents)
      ) {
        throw new ServerError("Couldn't read the workflow's agents");
      }
      return parseWorkflowAgents(raw.agents);
    },
    token,
  );
}

export interface WorkflowAgentPage {
  readonly agent: WorkflowAgent | null;
  /** The brief the workflow gave the agent; not repeated in `messages`. */
  readonly prompt: string | null;
  readonly messages: SubagentMessage[];
  /** Messages in the whole transcript; `seq` runs 1…total. */
  readonly total: number;
  /** Only the newest ones came. */
  readonly truncated: boolean;
  /** `afterSeq` fell before what the bridge keeps: replace instead of appending. */
  readonly gap: boolean;
}

/** One workflow agent's chat; `afterSeq` asks only for what is newer. */
export function fetchWorkflowAgentMessages(
  baseUrl: string,
  token: string,
  sessionId: string,
  taskId: string,
  agentId: string,
  afterSeq?: number,
): Promise<WorkflowAgentPage> {
  const query = afterSeq === undefined ? '' : `?after_seq=${afterSeq}`;
  return requestJson(
    baseUrl,
    `${taskPath(sessionId, taskId)}/agents/${encodeURIComponent(
      agentId,
    )}/messages${query}`,
    body => {
      const raw = body as Record<string, unknown> | null;
      if (
        raw === null ||
        typeof raw !== 'object' ||
        !Array.isArray(raw.messages)
      ) {
        throw new ServerError("Couldn't read the agent's messages");
      }
      return {
        agent: parseWorkflowAgent(raw.agent),
        prompt: typeof raw.prompt === 'string' ? raw.prompt : null,
        messages: raw.messages
          .map(parseTaskMessage)
          .filter((message): message is SubagentMessage => message !== null),
        total: typeof raw.total === 'number' ? raw.total : 0,
        truncated: raw.truncated === true,
        gap: raw.gap === true,
      };
    },
    token,
  );
}

const sameJson = (a: unknown, b: unknown) =>
  a === b || JSON.stringify(a) === JSON.stringify(b);

export interface UseWorkflowAgentsOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly sessionId: string;
  readonly workflows: SubagentTask[];
  /** The sheet is up. Hidden, or with the app in the background, nothing is fetched. */
  readonly visible: boolean;
}

/**
 * Each workflow's agents, by workflow task id. Running workflows are re-read
 * every WORKFLOW_POLL_MS; a finished one once more after it finishes (its
 * final n/n), then left alone.
 */
export function useWorkflowAgents({
  baseUrl,
  token,
  sessionId,
  workflows,
  visible,
}: UseWorkflowAgentsOptions): Record<string, WorkflowAgent[]> {
  const isAppActive = useAppActive();
  const [byTask, setByTask] = useState<Record<string, WorkflowAgent[]>>({});
  const settled = useRef(new Set<string>());
  const listRef = useRef(workflows);
  listRef.current = workflows;
  const key = workflows
    .map(task => `${task.taskId}:${isTaskRunning(task) ? 'r' : 'd'}`)
    .join(',');
  const isActive = visible && isAppActive && baseUrl.length > 0 && key !== '';

  useEffect(() => {
    setByTask({});
    settled.current = new Set();
  }, [sessionId, baseUrl]);

  useEffect(() => {
    if (!isActive) {
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const due = listRef.current.filter(
        task => isTaskRunning(task) || !settled.current.has(task.taskId),
      );
      await Promise.all(
        due.map(async task => {
          try {
            const agents = await fetchWorkflowAgents(
              baseUrl,
              token,
              sessionId,
              task.taskId,
            );
            if (cancelled) {
              return;
            }
            if (!isTaskRunning(task)) {
              settled.current.add(task.taskId);
            }
            setByTask(current =>
              sameJson(current[task.taskId] ?? [], agents)
                ? current
                : { ...current, [task.taskId]: agents },
            );
          } catch {
            // Keep what is on screen; the next tick tries again.
          }
        }),
      );
      if (!cancelled && listRef.current.some(isTaskRunning)) {
        timer = setTimeout(tick, WORKFLOW_POLL_MS);
      }
    };
    tick();
    return () => {
      cancelled = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
  }, [isActive, baseUrl, token, sessionId, key]);

  return byTask;
}

export interface WorkflowAgentTranscript {
  readonly messages: SubagentMessage[];
  /** Fresher than the sheet's copy: every poll brings it. */
  readonly agent: WorkflowAgent | null;
  readonly prompt: string | null;
  readonly total: number;
  readonly truncated: boolean;
  readonly loading: boolean;
  readonly error: string | null;
}

export interface UseWorkflowAgentTranscriptOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly sessionId: string;
  readonly workflow: SubagentTask;
  readonly agentId: string;
}

interface Meta {
  readonly agent: WorkflowAgent | null;
  readonly prompt: string | null;
  readonly total: number;
  readonly truncated: boolean;
}

const NO_META: Meta = { agent: null, prompt: null, total: 0, truncated: false };

/**
 * One workflow agent's chat, kept live: read whole once, then polled for what
 * came after its newest message while the agent runs. Polls append (or keep
 * the same array), never clear, so the list neither flickers nor jumps.
 */
export function useWorkflowAgentTranscript({
  baseUrl,
  token,
  sessionId,
  workflow,
  agentId,
}: UseWorkflowAgentTranscriptOptions): WorkflowAgentTranscript {
  const isAppActive = useAppActive();
  const [messages, setMessages] = useState<SubagentMessage[]>([]);
  const [meta, setMeta] = useState<Meta>(NO_META);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const workflowId = workflow.taskId;
  const workflowRunning = isTaskRunning(workflow);
  const isRunning =
    meta.agent === null ? workflowRunning : meta.agent.status === 'running';

  useEffect(() => {
    if (baseUrl.length === 0 || !isAppActive) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let whole = messagesRef.current.length === 0;
    const tick = async () => {
      const latest = messagesRef.current[messagesRef.current.length - 1];
      const after = whole ? undefined : latest?.seq ?? 0;
      let keepPolling = isRunning;
      try {
        const page = await fetchWorkflowAgentMessages(
          baseUrl,
          token,
          sessionId,
          workflowId,
          agentId,
          after,
        );
        if (cancelled) {
          return;
        }
        if (after !== undefined && page.total < after) {
          // The transcript started over: read it whole again.
          whole = true;
          keepPolling = true;
        } else {
          whole = false;
          setMessages(current =>
            mergeWorkflowMessages(current, page.messages, {
              incremental: after !== undefined,
              gap: page.gap,
            }),
          );
          keepPolling =
            page.agent === null ? isRunning : page.agent.status === 'running';
        }
        const next: Meta = {
          agent: page.agent,
          prompt: page.prompt,
          total: page.total,
          truncated: page.truncated,
        };
        setMeta(current => (sameJson(current, next) ? current : next));
        setError(null);
      } catch (cause) {
        if (!cancelled) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Couldn't load the agent's messages",
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
      if (!cancelled && keepPolling) {
        timer = setTimeout(tick, whole ? 0 : WORKFLOW_POLL_MS);
      }
    };
    tick();
    return () => {
      cancelled = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
    // `isRunning` on purpose: settling triggers one last read of the tail.
  }, [baseUrl, token, sessionId, workflowId, agentId, isRunning, isAppActive]);

  return { messages, ...meta, loading, error };
}
