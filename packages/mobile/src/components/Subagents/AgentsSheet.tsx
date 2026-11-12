import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useSockets } from '../../api/SocketProvider';
import { useWorkflowAgents } from '../../api/subagentsWorkflow';
import {
  countTasks,
  findWorkflowAgent,
  formatElapsed,
  formatTokens,
  isAgentTask,
  isTaskRunning,
  sheetSections,
  taskElapsedMs,
  taskTitle,
  taskTotals,
  type SubagentTask,
  type TaskFilter,
  type WorkflowProgress,
} from '../../lib/subagents';
import { AgentChat, WorkflowAgentChat } from './AgentChat';
import { StatusIcon, useNow } from './StatusIcon';
import { TaskRow } from './TaskRow';

export interface AgentsSheetProps {
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly tasks: Record<string, SubagentTask>;
  readonly serverId: string;
  readonly sessionId: string;
  readonly baseUrl: string;
  readonly token: string;
}

const FILTERS: { readonly key: TaskFilter; readonly label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'running', label: 'Running' },
  { key: 'done', label: 'Completed' },
];

/**
 * The session's sub-agents: a sheet with the list, and an agent's full chat
 * on top of it once a row is tapped. A workflow lists its own agents (polled
 * from the bridge while the sheet is up) under a done/total meter.
 *
 * Both live in one `Modal` rather than two: stacking a second one while the
 * first is up is where iOS drops presentations, and a single Android back
 * handler can step from the chat to the list and then close.
 */
export function AgentsSheet({
  visible,
  onClose,
  tasks,
  serverId,
  sessionId,
  baseUrl,
  token,
}: AgentsSheetProps) {
  const insets = useSafeAreaInsets();
  const sockets = useSockets();
  const [filter, setFilter] = useState<TaskFilter>('all');
  const [openId, setOpenId] = useState<string | null>(null);

  // Reopening the sheet starts from the list, not from the last agent viewed.
  useEffect(() => {
    if (!visible) {
      setOpenId(null);
    }
  }, [visible]);

  const agents = useMemo(
    () => Object.values(tasks).filter(isAgentTask),
    [tasks],
  );
  const counts = useMemo(() => countTasks(agents), [agents]);
  const workflows = useMemo(
    () => agents.filter(task => task.taskType === 'local_workflow'),
    [agents],
  );
  const agentsByWorkflow = useWorkflowAgents({
    baseUrl,
    token,
    sessionId,
    workflows,
    visible,
  });
  const sections = useMemo(
    () => sheetSections(agents, filter, agentsByWorkflow),
    [agents, filter, agentsByWorkflow],
  );
  const now = useNow(visible && openId === null && counts.running > 0);
  const shown = useMemo(
    () => sections.flatMap(section => section.tasks),
    [sections],
  );
  const totals = taskTotals(shown, now);
  // A task the bridge pruned while its chat was open falls back to the list.
  const openTask = openId === null ? null : tasks[openId] ?? null;
  const openInner =
    openId === null || openTask !== null
      ? null
      : findWorkflowAgent(openId, tasks, agentsByWorkflow);

  const stop = useCallback(
    (task: SubagentTask) => {
      const sent = sockets.send(serverId, {
        type: 'task_stop',
        sessionId,
        taskId: task.taskId,
      });
      if (!sent) {
        Alert.alert(
          'Agent not stopped',
          'The connection to the server is down.',
        );
      }
      return sent;
    },
    [sockets, serverId, sessionId],
  );

  const background = useCallback(
    (task: SubagentTask) => {
      const sent = sockets.send(serverId, {
        type: 'task_background',
        sessionId,
        // The bridge reads it as optional; the SDK then picks the foreground task.
        ...(task.toolUseId === null ? {} : { toolUseId: task.toolUseId }),
      });
      if (!sent) {
        Alert.alert('Agent not moved', 'The connection to the server is down.');
      }
      return sent;
    },
    [sockets, serverId, sessionId],
  );

  const countFor = (key: TaskFilter) =>
    key === 'running'
      ? counts.running
      : key === 'done'
      ? counts.done
      : counts.running + counts.done;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={
        openTask === null && openInner === null
          ? onClose
          : () => setOpenId(null)
      }
    >
      {/* Android Modal owns a separate native root; the transcript's
          Markdown tables scroll through the gesture handler, so they need
          their own root here. */}
      <GestureHandlerRootView style={styles.root}>
        {openTask !== null ? (
          <AgentChat
            key={openTask.taskId}
            task={openTask}
            serverId={serverId}
            baseUrl={baseUrl}
            token={token}
            sessionId={sessionId}
            onBack={() => setOpenId(null)}
            onStop={() => stop(openTask)}
            onBackground={() => background(openTask)}
          />
        ) : openInner !== null ? (
          <WorkflowAgentChat
            key={openId}
            workflow={openInner.workflow}
            agent={openInner.agent}
            baseUrl={baseUrl}
            token={token}
            sessionId={sessionId}
            onBack={() => setOpenId(null)}
          />
        ) : (
          <View className="flex-1 justify-end bg-black/45">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close agents"
              onPress={onClose}
              className="flex-1"
            />
            <View
              style={[styles.sheet, { paddingBottom: insets.bottom + 8 }]}
              className="rounded-t-3xl bg-white pt-2"
            >
              <View className="mx-auto mb-3 h-1 w-9 rounded-full bg-slate-300" />
              <View className="flex-row items-center px-5 pb-2">
                <View className="flex-1">
                  <Text className="text-base font-bold text-slate-900">
                    Agents
                  </Text>
                  <Text className="mt-0.5 text-xs text-slate-500">
                    {`${counts.running} running · ${counts.done} done`}
                  </Text>
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Close agents"
                  onPress={onClose}
                  className="min-h-11 justify-center pl-3"
                >
                  <Text className="text-sm text-slate-500">Close</Text>
                </Pressable>
              </View>

              <View className="flex-row border-b border-slate-200">
                {FILTERS.map(option => {
                  const isActive = filter === option.key;
                  const total = countFor(option.key);
                  return (
                    <Pressable
                      key={option.key}
                      accessibilityRole="tab"
                      accessibilityState={{ selected: isActive }}
                      onPress={() => setFilter(option.key)}
                      className={`flex-1 items-center py-2.5 ${
                        isActive ? 'border-b-2 border-slate-900' : ''
                      }`}
                    >
                      <Text
                        className={`text-[12.5px] font-semibold ${
                          isActive ? 'text-slate-900' : 'text-slate-400'
                        }`}
                      >
                        {total > 0 ? `${option.label} ${total}` : option.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              {shown.length > 0 ? (
                <View className="flex-row gap-3.5 border-b border-slate-100 px-5 py-2">
                  <Total value={formatTokens(totals.tokens)} label="tokens" />
                  <Total value={String(totals.tools)} label="tool uses" />
                  <Total
                    value={formatElapsed(totals.longest)}
                    label="longest"
                  />
                </View>
              ) : null}

              <ScrollView contentContainerClassName="pb-2">
                {sections.length === 0 ? (
                  <Text className="px-5 py-8 text-center text-[12.5px] text-slate-400">
                    {filter === 'running'
                      ? 'Nothing running.'
                      : filter === 'done'
                      ? 'No agent has finished yet.'
                      : 'No sub-agents in this session yet.'}
                  </Text>
                ) : (
                  sections.map(section => (
                    <View key={section.key}>
                      <View className="flex-row items-center gap-1.5 px-5 pb-0.5 pt-3">
                        <Text className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                          {section.label}
                        </Text>
                        {section.detail !== null ? (
                          <Text
                            numberOfLines={1}
                            className="flex-1 font-mono text-[11px] font-medium text-slate-500"
                          >
                            {section.detail}
                          </Text>
                        ) : null}
                        {section.progress !== null ? (
                          <Text className="font-mono text-[10.5px] text-slate-500">
                            {`${section.progress.done}/${section.progress.total}`}
                          </Text>
                        ) : null}
                      </View>
                      {section.progress !== null ? (
                        <Meter
                          progress={section.progress}
                          tone="running"
                          label={`${section.detail ?? 'Workflow'}: ${
                            section.progress.done
                          } of ${section.progress.total} agents done`}
                        />
                      ) : null}
                      {section.rows.map(row =>
                        row.kind === 'workflow' ? (
                          <WorkflowHeading
                            key={row.key}
                            workflow={row.workflow}
                            progress={row.progress}
                            now={now}
                          />
                        ) : (
                          <TaskRow
                            key={row.key}
                            task={row.task}
                            now={now}
                            onOpen={setOpenId}
                            isActing={row.kind === 'agent' && row.acting}
                          />
                        ),
                      )}
                    </View>
                  ))
                )}
              </ScrollView>
            </View>
          </View>
        )}
      </GestureHandlerRootView>
    </Modal>
  );
}

/** The thin done/total bar, in the agents' cyan while the workflow runs. */
function Meter({
  progress,
  tone,
  label,
}: {
  readonly progress: WorkflowProgress;
  readonly tone: 'running' | 'completed' | 'stopped';
  readonly label: string;
}) {
  const fill =
    tone === 'running'
      ? 'bg-cyan-500'
      : tone === 'completed'
      ? 'bg-emerald-500'
      : 'bg-slate-400';
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{
        min: 0,
        max: progress.total,
        now: progress.done,
      }}
      className="mx-5 mb-1 mt-1 h-[3px] overflow-hidden rounded-full bg-slate-200"
    >
      <View
        style={{ width: `${progress.percent}%` }}
        className={`h-full rounded-full ${fill}`}
      />
    </View>
  );
}

/** A finished workflow heading its agents inside "Completed", with its final n/n. */
function WorkflowHeading({
  workflow,
  progress,
  now,
}: {
  readonly workflow: SubagentTask;
  readonly progress: WorkflowProgress;
  readonly now: number;
}) {
  const name = workflow.workflowName ?? taskTitle(workflow);
  const tone = isTaskRunning(workflow)
    ? 'running'
    : workflow.status === 'completed'
    ? 'completed'
    : 'stopped';
  return (
    <View className="pt-2">
      <View className="flex-row items-center gap-2 px-5">
        <View className="w-3.5 items-center">
          <StatusIcon task={workflow} />
        </View>
        <Text
          numberOfLines={1}
          className="flex-1 font-mono text-[11.5px] font-semibold text-slate-600"
        >
          {name}
        </Text>
        <Text className="font-mono text-[10.5px] text-slate-500">
          {`${progress.done}/${progress.total}`}
        </Text>
        <Text className="font-mono text-[10.5px] text-slate-400">
          {formatElapsed(taskElapsedMs(workflow, now))}
        </Text>
      </View>
      <Meter
        progress={progress}
        tone={tone}
        label={`${name}: ${progress.done} of ${progress.total} agents done`}
      />
    </View>
  );
}

function Total({
  value,
  label,
}: {
  readonly value: string;
  readonly label: string;
}) {
  return (
    <Text className="font-mono text-[10.5px] text-slate-400">
      <Text className="text-slate-600">{value}</Text> {label}
    </Text>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  sheet: { maxHeight: '82%' },
});
