import { Pressable, Text, View } from 'react-native';

import {
  formatElapsed,
  taskElapsedMs,
  taskLine,
  taskTitle,
  type SubagentTask,
} from '../../lib/subagents';
import { StatusIcon } from './StatusIcon';

export interface TaskRowProps {
  readonly task: SubagentTask;
  readonly now: number;
  readonly onOpen: (taskId: string) => void;
  /** A workflow's agent that the workflow's latest progress tick named. */
  readonly isActing?: boolean;
}

/**
 * One agent per row: status, name, what it is doing, how long it has been at
 * it. Two lines instead of the desktop's one — a phone is narrow, and the
 * live step is what you opened the sheet to see.
 */
export function TaskRow({ task, now, onOpen, isActing = false }: TaskRowProps) {
  const title = taskTitle(task);
  const line = taskLine(task);
  const isFailure = task.status === 'failed';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${task.status}`}
      accessibilityHint="Opens the agent's full chat"
      onPress={() => onOpen(task.taskId)}
      className={`flex-row items-center gap-3 px-5 py-2.5 ${
        isActing ? 'bg-cyan-50 active:bg-cyan-100' : 'active:bg-slate-50'
      }`}
    >
      <View className="w-3.5 items-center">
        <StatusIcon task={task} />
      </View>
      <View className="min-w-0 flex-1">
        <Text
          numberOfLines={1}
          className={`text-[13.5px] font-semibold ${
            isActing ? 'text-cyan-800' : 'text-slate-900'
          }`}
        >
          {title}
        </Text>
        <Text
          numberOfLines={1}
          className={`mt-px text-[11.5px] ${
            isFailure ? 'text-rose-600' : 'text-slate-500'
          }`}
        >
          {line}
        </Text>
      </View>
      <Text className="font-mono text-[11px] text-slate-400">
        {formatElapsed(taskElapsedMs(task, now))}
      </Text>
      <Text className="text-[13px] text-slate-300">›</Text>
    </Pressable>
  );
}
