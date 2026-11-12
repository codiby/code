import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useWorkflowAgentTranscript } from '../../api/subagentsWorkflow';
import { useTaskTranscript } from '../../api/useTaskTranscript';
import { buildChatItems } from '../../lib/chatItems';
import {
  formatElapsed,
  formatTokens,
  isTaskRunning,
  returnedSummary,
  taskElapsedMs,
  taskKindLabel,
  taskTitle,
  toolCounts,
  workflowAgentTask,
  type SubagentMessage,
  type SubagentTask,
  type WorkflowAgent,
} from '../../lib/subagents';
import { useInk } from '../../theme';
import { BackIcon, MessageBubble, MockupCard, ToolGroup } from '../Chat';
import { Markdown } from '../Markdown';
import { BackgroundIcon, BotIcon, HandoffIcon, StopIcon } from './icons';
import { LiveDot, StatusPill, useNow } from './StatusIcon';

export interface AgentChatProps {
  readonly task: SubagentTask;
  readonly serverId: string;
  readonly baseUrl: string;
  readonly token: string;
  readonly sessionId: string;
  readonly onBack: () => void;
  /** false when the frame could not go out; the caller already said why. */
  readonly onStop: () => boolean;
  readonly onBackground: () => boolean;
}

/** Past this the prompt starts folded: it is often a whole brief. */
const PROMPT_FOLD_CHARS = 280;
const PROMPT_FOLD_LINES = 6;

/** How long Stop / Background wait for the bridge before they can be tapped again. */
const PENDING_TIMEOUT_MS = 8000;

function isLongPrompt(prompt: string): boolean {
  return (
    prompt.length > PROMPT_FOLD_CHARS ||
    prompt.split('\n').length > PROMPT_FOLD_LINES
  );
}

/**
 * A sub-agent's whole conversation, full screen.
 *
 * The transcript goes through the chat's own pieces — `buildChatItems`,
 * `MessageBubble`, `ToolGroup` — so it reads exactly like the main thread,
 * and like it the list is inverted: it opens on the latest step and follows
 * the tail as the agent works.
 */
export function AgentChat({
  task,
  serverId,
  baseUrl,
  token,
  sessionId,
  onBack,
  onStop,
  onBackground,
}: AgentChatProps) {
  const transcript = useTaskTranscript({
    serverId,
    baseUrl,
    token,
    sessionId,
    task,
  });
  return (
    <AgentChatView
      task={task}
      messages={transcript.messages}
      loading={transcript.loading}
      error={transcript.error}
      origin="the main agent"
      note={null}
      onBack={onBack}
      onStop={onStop}
      onBackground={onBackground}
    />
  );
}

export interface WorkflowAgentChatProps {
  readonly workflow: SubagentTask;
  /** The sheet's copy; the chat's own polls replace it as they land. */
  readonly agent: WorkflowAgent;
  readonly baseUrl: string;
  readonly token: string;
  readonly sessionId: string;
  readonly onBack: () => void;
}

/**
 * An agent inside a workflow. The SDK never streams those, so its chat is
 * polled from the bridge (which reads the run's transcript files). It has no
 * Stop or Background: only the whole workflow can be stopped.
 */
export function WorkflowAgentChat({
  workflow,
  agent,
  baseUrl,
  token,
  sessionId,
  onBack,
}: WorkflowAgentChatProps) {
  const live = useWorkflowAgentTranscript({
    baseUrl,
    token,
    sessionId,
    workflow,
    agentId: agent.agentId,
  });
  // Without `progress`: the row shows the agent's last text there, but the
  // chat already ends on that message and the working line would repeat it.
  const task = {
    ...workflowAgentTask(live.agent ?? agent, workflow, live.prompt),
    progress: null,
  };
  return (
    <AgentChatView
      task={task}
      messages={live.messages}
      loading={live.loading && live.messages.length === 0}
      error={live.error}
      origin="the workflow"
      note={
        live.truncated
          ? `Showing the last ${live.messages.length} of ${live.total} messages.`
          : null
      }
      onBack={onBack}
    />
  );
}

interface AgentChatViewProps {
  readonly task: SubagentTask;
  readonly messages: SubagentMessage[];
  readonly loading: boolean;
  readonly error: string | null;
  /** Who briefed the agent and gets its result: "the main agent" or "the workflow". */
  readonly origin: string;
  /** A line above the first step, e.g. that older messages were left out. */
  readonly note: string | null;
  readonly onBack: () => void;
  readonly onStop?: () => boolean;
  readonly onBackground?: () => boolean;
}

function AgentChatView({
  task,
  messages,
  loading,
  error,
  origin,
  note,
  onBack,
  onStop,
  onBackground,
}: AgentChatViewProps) {
  const ink = useInk();
  const insets = useSafeAreaInsets();
  const running = isTaskRunning(task);
  const now = useNow(running);
  const [stampedId, setStampedId] = useState<string | null>(null);
  const [isPromptOpen, setIsPromptOpen] = useState(false);
  /** The action already sent; the bridge answers with a `task_update`. */
  const [pending, setPending] = useState<'stop' | 'background' | null>(null);

  // The next status the bridge reports settles the button. A provider without
  // stop/background support never answers, so the button also comes back on
  // its own: a stuck "Stopping…" would be worse than a second tap.
  useEffect(() => {
    setPending(null);
  }, [task.status, task.backgrounded]);
  useEffect(() => {
    if (pending === null) {
      return;
    }
    const timer = setTimeout(() => setPending(null), PENDING_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [pending]);

  const inverted = useMemo(
    () => buildChatItems(messages).reverse(),
    [messages],
  );
  const summary = useMemo(
    () => returnedSummary(task, messages),
    [task, messages],
  );
  const tools = useMemo(() => toolCounts(messages), [messages]);
  const title = taskTitle(task);

  const toggleStamp = useCallback(
    (id: string) => setStampedId(current => (current === id ? null : id)),
    [],
  );
  const showStamp = useCallback((id: string) => setStampedId(id), []);

  const confirmStop = () =>
    Alert.alert(
      `Stop ${title}?`,
      'It stops where it is. Its chat so far is kept.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Stop',
          style: 'destructive',
          onPress: () => {
            if (onStop?.()) {
              setPending('stop');
            }
          },
        },
      ],
    );

  const sendToBackground = () => {
    if (onBackground?.()) {
      setPending('background');
    }
  };

  const prompt = task.prompt?.trim() ?? '';
  const isFoldable = isLongPrompt(prompt);

  return (
    <View className="flex-1 bg-white">
      <View
        style={{ paddingTop: insets.top + 4 }}
        className="flex-row items-center gap-2.5 border-b border-slate-200 bg-white pb-1.5 pl-1.5 pr-3"
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to agents"
          onPress={onBack}
          className="h-10 w-10 items-center justify-center rounded-full active:bg-slate-100"
        >
          <BackIcon size={22} color={ink('#0f172a')} />
        </Pressable>
        <View className="h-9 w-9 items-center justify-center rounded-full bg-cyan-50">
          <BotIcon size={18} color={ink('#0891b2')} />
        </View>
        <View className="min-w-0 flex-1">
          <Text
            numberOfLines={1}
            className="text-[15.5px] font-semibold tracking-[-0.3px] text-slate-900"
          >
            {title}
          </Text>
          <View className="flex-row items-center gap-1.5">
            <StatusPill status={task.status} />
            <Text
              numberOfLines={1}
              className="flex-1 text-[11.5px] text-slate-500"
            >
              {taskKindLabel(task)}
              {task.workflowName ? ` · ${task.workflowName}` : ''}
            </Text>
          </View>
        </View>
      </View>

      <View className="border-b border-slate-200 bg-white pb-2.5 pt-2">
        <View className="flex-row px-5">
          <Fact
            label="Elapsed"
            value={formatElapsed(taskElapsedMs(task, now))}
          />
          <Fact label="Tokens" value={formatTokens(task.totalTokens)} />
          <Fact label="Tool uses" value={String(task.toolUses)} />
        </View>
        {tools.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerClassName="gap-1.5 px-5 pt-2"
          >
            {tools.map(([name, uses]) => (
              <View
                key={name}
                className="flex-row items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1"
              >
                <Text className="font-mono text-[10.5px] text-slate-600">
                  {name}
                </Text>
                <Text className="font-mono text-[10.5px] text-slate-400">
                  {uses}
                </Text>
              </View>
            ))}
          </ScrollView>
        ) : null}
      </View>

      <FlatList
        inverted
        className="flex-1"
        data={inverted}
        keyExtractor={item => item.key}
        renderItem={({ item }) =>
          item.kind === 'mockup' ? (
            <View className="px-3">
              <MockupCard name={item.name} />
            </View>
          ) : item.kind === 'group' ? (
            <ToolGroup entries={item.entries} />
          ) : (
            <MessageBubble
              message={item.message}
              group={item.group}
              isSelected={stampedId === item.message.id}
              onSelect={toggleStamp}
              onShowStamp={showStamp}
            />
          )
        }
        contentContainerClassName="py-3"
        initialNumToRender={12}
        maxToRenderPerBatch={8}
        windowSize={7}
        // Inverted: the header is drawn at the bottom, under the latest step.
        ListHeaderComponent={
          <>
            {error !== null ? (
              <Text className="px-[18px] py-2 text-[12px] text-rose-600">
                {error}
              </Text>
            ) : null}
            {task.status === 'failed' && task.error !== null ? (
              <Text className="px-[18px] py-2 text-[12.5px] text-rose-600">
                {task.error}
              </Text>
            ) : null}
            {running ? (
              <View className="flex-row items-center gap-2 px-[18px] py-2">
                <LiveDot />
                <Text
                  numberOfLines={2}
                  className="flex-1 text-[12px] italic text-slate-500"
                >
                  {task.progress ?? 'Working…'}
                </Text>
              </View>
            ) : summary.kind === 'marker' ? (
              <View className="flex-row items-center gap-1.5 px-[18px] pb-1 pt-2">
                <HandoffIcon size={12} color={ink('#059669')} />
                <Text className="text-[10px] font-bold uppercase tracking-wide text-emerald-700">
                  {`Returned to ${origin}`}
                </Text>
              </View>
            ) : summary.kind === 'card' ? (
              <View className="mx-3 mt-2 rounded-2xl border border-emerald-200 bg-emerald-50 px-3.5 pb-1.5 pt-2.5">
                <View className="mb-1 flex-row items-center gap-1.5">
                  <HandoffIcon size={12} color={ink('#059669')} />
                  <Text className="text-[10px] font-bold uppercase tracking-wide text-emerald-700">
                    {`Returned to ${origin}`}
                  </Text>
                </View>
                <Markdown text={summary.text} />
              </View>
            ) : null}
            <View className="h-2" />
          </>
        }
        // …and the footer at the top, before the first step: the brief.
        ListFooterComponent={
          prompt.length > 0 || note !== null ? (
            <>
              {prompt.length > 0 ? (
                <View className="mx-3 mb-2 mt-1 rounded-2xl border border-slate-200 bg-slate-50 px-3.5 py-2.5">
                  <View className="flex-row items-center gap-1.5">
                    <HandoffIcon size={12} color={ink('#94a3b8')} />
                    <Text className="text-[10px] font-bold uppercase tracking-wide text-slate-400">
                      {`Prompt from ${origin}`}
                    </Text>
                  </View>
                  <Text
                    selectable
                    numberOfLines={
                      isFoldable && !isPromptOpen
                        ? PROMPT_FOLD_LINES
                        : undefined
                    }
                    className="mt-1.5 font-mono text-[11px] leading-[17px] text-slate-600"
                  >
                    {prompt}
                  </Text>
                  {isFoldable ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ expanded: isPromptOpen }}
                      onPress={() => setIsPromptOpen(open => !open)}
                      hitSlop={8}
                      className="mt-1 self-start active:opacity-60"
                    >
                      <Text className="text-[11.5px] font-semibold text-cyan-700">
                        {isPromptOpen ? 'Show less' : 'Show full prompt'}
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
              ) : null}
              {note !== null ? (
                <Text className="px-[18px] pb-1 pt-1 text-[11.5px] text-slate-400">
                  {note}
                </Text>
              ) : null}
            </>
          ) : undefined
        }
        ListEmptyComponent={
          loading ? (
            <View className="items-center py-10">
              <ActivityIndicator size="small" color={ink('#94a3b8')} />
            </View>
          ) : error === null ? (
            <View className="items-center px-6 py-10">
              <Text className="text-sm text-slate-500">
                {running
                  ? 'Nothing from this agent yet.'
                  : 'This agent left no messages.'}
              </Text>
            </View>
          ) : undefined
        }
      />

      {running && onStop !== undefined ? (
        <View
          style={{ paddingBottom: insets.bottom + 8 }}
          className="flex-row items-center justify-end gap-1 border-t border-slate-200 bg-white px-3 pt-2"
        >
          {task.backgrounded ? (
            <Text className="mr-auto pl-2 text-[11.5px] text-slate-400">
              Running in the background
            </Text>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Move to the background"
              accessibilityHint="The main agent carries on while this one keeps working"
              accessibilityState={{ disabled: pending !== null }}
              disabled={pending !== null}
              onPress={sendToBackground}
              className="mr-auto flex-row items-center gap-1.5 rounded-lg px-3.5 py-2 active:bg-slate-100"
            >
              <BackgroundIcon size={14} color={ink('#475569')} />
              <Text className="text-[12.5px] font-semibold text-slate-600">
                {pending === 'background' ? 'Moving…' : 'Background'}
              </Text>
            </Pressable>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Stop this agent"
            accessibilityState={{ disabled: pending === 'stop' }}
            disabled={pending === 'stop'}
            onPress={confirmStop}
            className="flex-row items-center gap-1.5 rounded-lg border border-rose-200 px-3.5 py-2 active:bg-rose-50"
          >
            <StopIcon size={12} color={ink('#e11d48')} />
            <Text className="text-[12.5px] font-semibold text-rose-700">
              {pending === 'stop' ? 'Stopping…' : 'Stop'}
            </Text>
          </Pressable>
        </View>
      ) : (
        <View style={{ height: insets.bottom }} className="bg-white" />
      )}
    </View>
  );
}

function Fact({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <View className="flex-1">
      <Text className="text-[9.5px] font-bold uppercase tracking-wider text-slate-400">
        {label}
      </Text>
      <Text className="mt-0.5 font-mono text-[12.5px] text-slate-800">
        {value}
      </Text>
    </View>
  );
}
