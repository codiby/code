import { useMemo, useState } from 'react';
import { Pressable, Text } from 'react-native';

import { useFeedTasks, type TaskFeed } from '../../api/subagents';
import { countTasks, isAgentTask } from '../../lib/subagents';
import { useInk } from '../../theme';
import { BotIcon } from './icons';
import { LiveDot } from './StatusIcon';

type SheetComponent = typeof import('./AgentsSheet').AgentsSheet;

export interface AgentsButtonProps {
  /** Fed by the chat screen's session socket. */
  readonly feed: TaskFeed;
  readonly serverId: string;
  readonly sessionId: string;
  readonly baseUrl: string;
  readonly token: string;
}

/**
 * The sheet and the full chat pull in Markdown and the gesture handler. The
 * chat header mounts with every conversation, so they load the first time
 * someone opens the sheet, not before.
 */
function loadSheet(): SheetComponent {
  return (require('./AgentsSheet') as typeof import('./AgentsSheet'))
    .AgentsSheet;
}

/**
 * The session's sub-agents, from the chat header: a live count while any
 * runs, the finished total otherwise. Absent while the session never
 * delegated anything — on a phone the header has no room for an empty chip.
 */
export function AgentsButton({
  feed,
  serverId,
  sessionId,
  baseUrl,
  token,
}: AgentsButtonProps) {
  const ink = useInk();
  const tasks = useFeedTasks(feed);
  const [isOpen, setIsOpen] = useState(false);
  const [wasOpened, setWasOpened] = useState(false);
  const agents = useMemo(
    () => Object.values(tasks).filter(isAgentTask),
    [tasks],
  );
  const { running, done } = useMemo(() => countTasks(agents), [agents]);

  if (agents.length === 0 && !isOpen) {
    return null;
  }

  const Sheet = wasOpened ? loadSheet() : null;
  const isLive = running > 0;

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Agents, ${running} running, ${done} done`}
        accessibilityState={{ expanded: isOpen }}
        onPress={() => {
          setWasOpened(true);
          setIsOpen(true);
        }}
        className="min-h-10 flex-row items-center gap-1.5 rounded-xl px-2 active:bg-slate-100"
      >
        <BotIcon size={18} color={ink(isLive ? '#0891b2' : '#64748b')} />
        {isLive ? <LiveDot /> : null}
        <Text
          className={`text-[12px] font-semibold ${
            isLive ? 'text-cyan-700' : 'text-slate-500'
          }`}
        >
          {isLive ? running : done}
        </Text>
      </Pressable>
      {Sheet !== null ? (
        <Sheet
          visible={isOpen}
          onClose={() => setIsOpen(false)}
          tasks={tasks}
          serverId={serverId}
          sessionId={sessionId}
          baseUrl={baseUrl}
          token={token}
        />
      ) : null}
    </>
  );
}
