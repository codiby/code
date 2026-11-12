import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Text, View } from 'react-native';

import {
  isTaskRunning,
  type SubagentTask,
  type SubagentTaskStatus,
} from '../../lib/subagents';
import { useInk } from '../../theme';
import { CheckIcon } from '../Chat/icons';
import { SlashIcon } from './icons';

/** Re-renders every `ms` while `active`, for the live elapsed counters. */
export function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      return;
    }
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [active, ms]);
  return now;
}

/**
 * The beating dot of the chat's "working…" line, in the agents' cyan. A
 * spinner per row would be the heavier way to say the same thing.
 */
export function LiveDot() {
  const opacity = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 1,
          duration: 600,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0.3,
          duration: 600,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);

  return (
    <Animated.View
      style={{ opacity }}
      className="h-2 w-2 rounded-full bg-cyan-500"
    />
  );
}

export function StatusIcon({ task }: { readonly task: SubagentTask }) {
  const ink = useInk();
  if (isTaskRunning(task)) {
    return (
      <View accessibilityLabel="Running">
        <LiveDot />
      </View>
    );
  }
  if (task.status === 'completed') {
    return (
      <View accessibilityLabel="Completed">
        <CheckIcon size={13} color={ink('#059669')} />
      </View>
    );
  }
  return (
    <View accessibilityLabel={task.status}>
      <SlashIcon
        size={13}
        color={ink(task.status === 'failed' ? '#e11d48' : '#94a3b8')}
      />
    </View>
  );
}

/** Full class names: NativeWind only compiles what it can read in the source. */
const PILL: Record<SubagentTaskStatus, { box: string; text: string }> = {
  pending: { box: 'bg-cyan-100', text: 'text-cyan-700' },
  running: { box: 'bg-cyan-100', text: 'text-cyan-700' },
  paused: { box: 'bg-cyan-100', text: 'text-cyan-700' },
  completed: { box: 'bg-emerald-100', text: 'text-emerald-700' },
  failed: { box: 'bg-rose-100', text: 'text-rose-700' },
  stopped: { box: 'bg-slate-100', text: 'text-slate-500' },
  killed: { box: 'bg-slate-100', text: 'text-slate-500' },
};

export function StatusPill({
  status,
}: {
  readonly status: SubagentTaskStatus;
}) {
  const pill = PILL[status];
  return (
    <View className={`rounded-full px-1.5 py-px ${pill.box}`}>
      <Text
        className={`text-[9.5px] font-bold uppercase tracking-wide ${pill.text}`}
      >
        {status}
      </Text>
    </View>
  );
}
