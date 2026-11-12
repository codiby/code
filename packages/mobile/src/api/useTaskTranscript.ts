import { useEffect, useMemo, useRef, useState } from 'react';

import { RECONNECTED, useSockets } from './SocketProvider';
import { fetchTaskMessages, parseTaskMessage } from './subagents';
import {
  belongsToTask,
  isTaskRunning,
  mergeTranscript,
  type SubagentMessage,
  type SubagentTask,
} from '../lib/subagents';

export interface TaskTranscript {
  readonly messages: SubagentMessage[];
  readonly loading: boolean;
  readonly error: string | null;
}

export interface UseTaskTranscriptOptions {
  readonly serverId: string;
  readonly baseUrl: string;
  readonly token: string;
  readonly sessionId: string;
  readonly task: SubagentTask;
}

/**
 * One sub-agent's transcript, kept live.
 *
 * Fetched from the bridge, then fed by the shared socket: `subagent_message`
 * carries its text and thinking, and its tool calls and results arrive as
 * ordinary `message` frames stamped with its `agentId`. Re-fetched when the
 * task settles (the last text can race the final frames) and after a
 * reconnect (frames sent while the socket was down are not replayed).
 */
export function useTaskTranscript({
  serverId,
  baseUrl,
  token,
  sessionId,
  task,
}: UseTaskTranscriptOptions): TaskTranscript {
  const { addListener } = useSockets();
  const [fetched, setFetched] = useState<SubagentMessage[]>([]);
  const [streamed, setStreamed] = useState<SubagentMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const taskRef = useRef(task);
  taskRef.current = task;
  const { taskId } = task;
  const running = isTaskRunning(task);

  useEffect(() => {
    if (baseUrl.length === 0) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchTaskMessages(
      baseUrl,
      token,
      sessionId,
      taskId,
      taskRef.current.toolUseId,
    )
      .then(messages => {
        if (!cancelled) {
          setFetched(messages);
          setError(null);
        }
      })
      .catch(cause => {
        if (!cancelled) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Couldn't load the agent's messages",
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
    // `running` on purpose: settling re-fetches the exact final transcript.
  }, [baseUrl, token, sessionId, taskId, running, reload]);

  useEffect(
    () =>
      addListener((from, frame) => {
        if (from !== serverId) {
          return;
        }
        if (frame.type === RECONNECTED) {
          setReload(value => value + 1);
          return;
        }
        if (
          frame.sessionId !== sessionId ||
          (frame.type !== 'subagent_message' && frame.type !== 'message')
        ) {
          return;
        }
        const message = parseTaskMessage(frame.message);
        if (message === null || !belongsToTask(message, taskRef.current)) {
          return;
        }
        setStreamed(current =>
          current.some(item => item.id === message.id)
            ? current
            : [...current, message],
        );
      }),
    [addListener, serverId, sessionId],
  );

  const messages = useMemo(
    () => mergeTranscript(fetched, streamed),
    [fetched, streamed],
  );

  return { messages, loading, error };
}
