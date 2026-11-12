/**
 * Wire side of the Agents sheet: the per-task transcript endpoint and a tiny
 * store the session socket feeds.
 */

import { useState, useSyncExternalStore } from 'react';

import { ServerError, requestJson } from './client';
import { parseLiveMessage } from './messages';
import type { SubagentMessage, SubagentTask } from '../lib/subagents';

/**
 * A message from the transcript endpoint or a live frame, with the two ids
 * that say which sub-agent wrote it.
 *
 * A frame without `seq` sorts last instead of first: `parseLiveMessage` would
 * give it 0, which would put a just-arrived step above the agent's opening.
 */
export function parseTaskMessage(value: unknown): SubagentMessage | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const message = parseLiveMessage({
    ...raw,
    seq: typeof raw.seq === 'number' ? raw.seq : Number.MAX_SAFE_INTEGER,
  });
  if (message === null) {
    return null;
  }
  return {
    ...message,
    agentId: typeof raw.agentId === 'string' ? raw.agentId : null,
    parentToolUseId:
      typeof raw.parentToolUseId === 'string' ? raw.parentToolUseId : null,
  };
}

/**
 * Everything one sub-agent produced. Its own text and thinking never reach the
 * chat's history (the bridge keeps that chatter out of `/messages`), so this
 * is the only place to read it from.
 */
export function fetchTaskMessages(
  baseUrl: string,
  token: string,
  sessionId: string,
  taskId: string,
  toolUseId: string | null,
): Promise<SubagentMessage[]> {
  const query =
    toolUseId === null ? '' : `?tool_use_id=${encodeURIComponent(toolUseId)}`;
  return requestJson(
    baseUrl,
    `/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(
      taskId,
    )}/messages${query}`,
    body => {
      const raw = body as { messages?: unknown } | null;
      if (
        raw === null ||
        typeof raw !== 'object' ||
        !Array.isArray(raw.messages)
      ) {
        throw new ServerError("Couldn't read the agent's messages");
      }
      return raw.messages
        .map(parseTaskMessage)
        .filter((message): message is SubagentMessage => message !== null);
    },
    token,
  );
}

/**
 * The session's tasks, outside React state.
 *
 * Progress ticks arrive with every tool call of every sub-agent. Holding them
 * in the chat screen's state would re-render the whole thread for each one;
 * here only the components that read the store repaint.
 */
export interface TaskFeed {
  /** A `session_state` snapshot: the bridge's full, pruned list. */
  readonly replace: (tasks: Record<string, SubagentTask>) => void;
  /** One `task_update` frame. */
  readonly upsert: (task: SubagentTask) => void;
  readonly get: () => Record<string, SubagentTask>;
  readonly subscribe: (listener: () => void) => () => void;
}

export function createTaskFeed(): TaskFeed {
  let tasks: Record<string, SubagentTask> = {};
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  return {
    replace: next => {
      tasks = next;
      emit();
    },
    upsert: task => {
      tasks = { ...tasks, [task.taskId]: task };
      emit();
    },
    get: () => tasks,
    subscribe: listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** One feed per mounted chat screen. */
export function useTaskFeed(): TaskFeed {
  const [feed] = useState(createTaskFeed);
  return feed;
}

export function useFeedTasks(feed: TaskFeed): Record<string, SubagentTask> {
  return useSyncExternalStore(feed.subscribe, feed.get);
}
